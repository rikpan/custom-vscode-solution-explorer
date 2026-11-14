"use strict";

// Self-updater for a build that is distributed through GitHub Releases rather than
// the Marketplace. VS Code never updates an extension installed from a VSIX, so the
// extension looks for a newer release itself, downloads its .vsix and installs it.
//
// This file is hand-written and deliberately kept outside the webpack bundle
// (extension.js), which only calls activate() below.

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
const TIMER_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_FAILED_INSTALL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_ATTEMPTS = 5;
const DOWNLOAD_RETRY_DELAY_MS = 3 * 1000;
const MAX_REDIRECTS = 5;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_VSIX_BYTES = 200 * 1024 * 1024;
const LOCK_STALE_MS = 15 * 60 * 1000;

const CHECK_COMMAND = "solutionExplorer.checkForUpdates";
const LAST_CHECK_KEY = "updater.lastCheckTime";
const PENDING_VERSION_KEY = "updater.pendingVersion";
const SKIPPED_VERSION_KEY = "updater.skippedVersion";

// ---------------------------------------------------------------------------
// Versions, repository and asset selection
// ---------------------------------------------------------------------------

function parseVersion(value) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || "").trim());
    if (!match) {
        return undefined;
    }
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || "" };
}

/** Returns <0, 0 or >0. A version that cannot be parsed sorts before any valid one. */
function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) {
        return (a ? 1 : 0) - (b ? 1 : 0);
    }
    for (let i = 0; i < 3; i++) {
        if (a.numbers[i] !== b.numbers[i]) {
            return a.numbers[i] - b.numbers[i];
        }
    }
    // "1.0.0-beta" precedes "1.0.0".
    if (a.prerelease === b.prerelease) {
        return 0;
    }
    if (!a.prerelease || !b.prerelease) {
        return a.prerelease ? -1 : 1;
    }
    return a.prerelease < b.prerelease ? -1 : 1;
}

/** Extracts { owner, repo } from the "repository" field of package.json. */
function parseGitHubRepository(repository) {
    const url = typeof repository === "string" ? repository : repository && repository.url;
    const match = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || "").trim());
    return match ? { owner: match[1], repo: match[2] } : undefined;
}

/** Picks the .vsix of a release, preferring the conventional "<name>-<version>.vsix". */
function selectVsixAsset(assets, extensionName, version) {
    const candidates = (Array.isArray(assets) ? assets : [])
        .filter(asset => asset && typeof asset.name === "string" && /\.vsix$/i.test(asset.name) && typeof asset.browser_download_url === "string");
    const expected = `${extensionName}-${version}.vsix`.toLowerCase();
    return candidates.find(asset => asset.name.toLowerCase() === expected) || candidates[0];
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const REQUEST_HEADERS = { "User-Agent": "custom-vscode-solution-explorer-updater" };

/** Sends one HTTPS GET and resolves with its response, whatever the status. */
function open(url, headers, get) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }
        if (parsed.protocol !== "https:") {
            reject(new Error(`Refusing to request a non-HTTPS URL: ${url}`));
            return;
        }
        const req = get(parsed, { headers: { ...REQUEST_HEADERS, ...headers }, timeout: REQUEST_TIMEOUT_MS }, resolve);
        req.on("timeout", () => req.destroy(new Error(`Request timed out: ${parsed.host}${parsed.pathname}`)));
        req.on("error", reject);
    });
}

function statusError(response, url) {
    const parsed = new URL(url);
    const error = new Error(`HTTP ${response.statusCode} from ${parsed.host}${parsed.pathname}`);
    error.status = response.statusCode;
    return error;
}

function redirectTarget(response, url) {
    const status = response.statusCode || 0;
    return status >= 300 && status < 400 && response.headers.location
        ? new URL(response.headers.location, url).toString()
        : undefined;
}

/**
 * GETs an HTTPS URL, following redirects, and resolves with the response stream of a
 * 200, or of a 206 when a Range was requested. An error for any other status carries
 * it as error.status.
 */
async function request(url, headers, get = https.get) {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await open(url, headers, get);
        const next = redirectTarget(response, url);
        if (next) {
            response.resume();
            url = next;
            continue;
        }
        if (response.statusCode !== 200 && response.statusCode !== 206) {
            response.resume();
            throw statusError(response, url);
        }
        return response;
    }
    throw new Error(`Too many redirects: ${url}`);
}

/** Resolves with the URL that url redirects to, without following it; undefined if it does not redirect. */
async function fetchRedirect(url, get = https.get) {
    const response = await open(url, {}, get);
    response.resume();
    const next = redirectTarget(response, url);
    if (!next && response.statusCode !== 200) {
        throw statusError(response, url);
    }
    return next;
}

async function fetchJson(url, get = https.get) {
    const response = await request(url, { "Accept": "application/vnd.github+json" }, get);
    const chunks = [];
    let received = 0;
    for await (const chunk of response) {
        received += chunk.length;
        if (received > MAX_JSON_BYTES) {
            response.destroy();
            throw new Error("The response is unexpectedly large.");
        }
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Downloads url to destination. The file only appears at destination once it is
 * complete and matches the SHA-256 published with the release (when there is one).
 *
 * The bytes received so far are kept in "<destination>.part", and a transfer that
 * drops or stalls is resumed from there with a Range request - by the next attempt,
 * or by the next call if every attempt fails. On a slow connection a release can
 * take several interrupted transfers to arrive.
 *
 * @param options { size, sha256, onProgress(received, total), attempts, retryDelayMs }
 */
async function downloadFile(url, destination, options = {}, get = https.get) {
    const partial = `${destination}.part`;
    const attempts = options.attempts || DOWNLOAD_ATTEMPTS;
    const retryDelay = options.retryDelayMs === undefined ? DOWNLOAD_RETRY_DELAY_MS : options.retryDelayMs;
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });

    for (let attempt = 1; ; attempt++) {
        try {
            await transfer(url, partial, options, get);
            break;
        } catch (error) {
            // Asking again does not change an HTTP error status; a dropped connection may recover.
            if (error.status || error.fatal || attempt >= attempts) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }

    if (options.sha256 && (await sha256OfFile(partial)) !== options.sha256.toLowerCase()) {
        await fs.promises.rm(partial, { force: true });
        throw new Error("The download does not match the checksum published with the release.");
    }
    await fs.promises.rename(partial, destination);
}

/** One attempt: continues partial where it ends, or starts over if the server does not resume. */
async function transfer(url, partial, options, get) {
    const total = typeof options.size === "number" ? options.size : undefined;
    const limit = total === undefined ? MAX_VSIX_BYTES : Math.min(total, MAX_VSIX_BYTES);
    let offset = 0;
    try {
        offset = (await fs.promises.stat(partial)).size;
    } catch (error) {
        // Nothing downloaded yet.
    }
    if (offset > limit) {
        await fs.promises.rm(partial, { force: true });
        offset = 0;
    }
    if (total !== undefined && offset === total) {
        return;
    }

    let response;
    try {
        response = await request(url, { "Accept": "application/octet-stream", ...(offset > 0 ? { "Range": `bytes=${offset}-` } : {}) }, get);
    } catch (error) {
        if (error.status === 416) {
            // The partial file does not belong to this asset: the next attempt starts over.
            await fs.promises.rm(partial, { force: true });
            throw new Error("The partial download could not be resumed.");
        }
        throw error;
    }

    const resumed = response.statusCode === 206;
    let received = resumed ? offset : 0;
    const meter = new Transform({
        transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (received > limit) {
                const error = new Error("The download is larger than expected.");
                error.fatal = true;
                callback(error);
                return;
            }
            if (options.onProgress) {
                options.onProgress(received, total);
            }
            callback(null, chunk);
        }
    });
    try {
        await pipeline(response, meter, fs.createWriteStream(partial, { flags: resumed ? "a" : "w" }));
    } catch (error) {
        if (error.fatal) {
            await fs.promises.rm(partial, { force: true });
        }
        throw error;
    }
    if (total !== undefined && received < total) {
        throw new Error(`The download is incomplete (${received} of ${total} bytes).`);
    }
}

async function sha256OfFile(file) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

/** "sha256:abc..." (GitHub's asset digest) -> "abc...". Other algorithms are ignored. */
function sha256FromDigest(digest) {
    const match = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || ""));
    return match ? match[1].toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

class Updater {
    /**
     * @param context the vscode.ExtensionContext
     * @param vscode the "vscode" module
     * @param net { fetchJson(url), fetchRedirect(url), downloadFile(url, destination, options) },
     *            replaceable in tests
     * @param now clock, replaceable in tests
     */
    constructor(context, vscode, net = { fetchJson, fetchRedirect, downloadFile }, now = Date.now) {
        this.context = context;
        this.vscode = vscode;
        this.net = net;
        this.now = now;
        this.busy = false;
        this.manifest = context.extension.packageJSON;
        this.repository = parseGitHubRepository(this.manifest.repository);
        this.updatesFolder = path.join(context.globalStorageUri.fsPath, "updates");
    }

    get currentVersion() {
        return this.manifest.version;
    }

    /** "auto" installs silently, "notify" asks first, "off" never checks on its own. */
    get mode() {
        const mode = this.vscode.workspace.getConfiguration("vssolution").get("update.mode", "auto");
        return mode === "notify" || mode === "off" ? mode : "auto";
    }

    register() {
        const { vscode, context } = this;
        context.subscriptions.push(vscode.commands.registerCommand(CHECK_COMMAND, () => this.check(true)));

        this.finishAppliedUpdate().catch(error => this.log(error));

        // Development and test hosts run the checkout, which a release must not replace.
        if (context.extensionMode !== vscode.ExtensionMode.Production) {
            return;
        }

        // Not during startup, and spread out for windows that are restored together;
        // re-evaluated hourly for windows that stay open for days.
        const startup = setTimeout(() => this.checkIfDue(), STARTUP_DELAY_MS + Math.floor(Math.random() * STARTUP_DELAY_MS));
        const hourly = setInterval(() => this.checkIfDue(), TIMER_INTERVAL_MS);
        context.subscriptions.push({ dispose: () => { clearTimeout(startup); clearInterval(hourly); } });
    }

    /** Once the installed update is the running version, forget it and delete its download. */
    async finishAppliedUpdate() {
        const state = this.context.globalState;
        const pending = state.get(PENDING_VERSION_KEY);
        if (pending && compareVersions(this.currentVersion, pending) >= 0) {
            await state.update(PENDING_VERSION_KEY, undefined);
            await fs.promises.rm(this.updatesFolder, { recursive: true, force: true });
        }
        const skipped = state.get(SKIPPED_VERSION_KEY);
        if (skipped && compareVersions(this.currentVersion, skipped) >= 0) {
            await state.update(SKIPPED_VERSION_KEY, undefined);
        }
    }

    async checkIfDue() {
        if (this.mode === "off") {
            return;
        }
        const lastCheck = this.context.globalState.get(LAST_CHECK_KEY, 0);
        const elapsed = this.now() - lastCheck;
        if (elapsed >= 0 && elapsed < CHECK_INTERVAL_MS) {
            return;
        }
        await this.check(false);
    }

    /**
     * Looks for a newer release and installs it according to the mode.
     * @param manual true when the user ran the command: always checks, and reports
     *               every outcome instead of staying silent.
     */
    async check(manual) {
        const { vscode } = this;
        const t = vscode.l10n.t;
        if (this.busy) {
            if (manual) {
                vscode.window.showInformationMessage(t("An update check is already in progress."));
            }
            return;
        }

        let update;
        this.busy = true;
        try {
            // Recorded before the request so that a failing check is not retried every hour.
            await this.context.globalState.update(LAST_CHECK_KEY, this.now());
            update = manual
                ? await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: t("Checking for Solution Explorer updates...") },
                    () => this.findUpdate())
                : await this.findUpdate();
        } catch (error) {
            this.reportFailure(error, manual);
            return;
        } finally {
            this.busy = false;
        }

        if (!update) {
            if (manual) {
                vscode.window.showInformationMessage(t("Solution Explorer is up to date (version {0}).", this.currentVersion));
            }
            return;
        }

        const state = this.context.globalState;
        if (state.get(PENDING_VERSION_KEY) === update.version) {
            // Already installed, by this window or another one; it only needs a reload.
            this.promptReload(update);
            return;
        }
        if (!manual && state.get(SKIPPED_VERSION_KEY) === update.version) {
            return;
        }
        if (this.mode !== "auto" && !(await this.confirmInstall(update, manual))) {
            return;
        }
        await this.install(update, manual || this.mode !== "auto");
    }

    /** Resolves with the newer release, or undefined when the running version is current. */
    async findUpdate() {
        if (!this.repository) {
            throw new Error("package.json does not name a GitHub repository.");
        }
        const { owner, repo } = this.repository;
        let release;
        try {
            // "latest" excludes drafts and pre-releases.
            release = await this.net.fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
        } catch (error) {
            // The API allows 60 anonymous requests an hour per IP address, which a shared
            // proxy or NAT uses up for everyone behind it. The website has no such quota.
            if (error.status !== 403 && error.status !== 429) {
                throw error;
            }
            release = await this.findReleaseOnWebsite();
        }
        const version = String(release && release.tag_name || "").replace(/^v/, "");
        if (!parseVersion(version) || compareVersions(version, this.currentVersion) <= 0) {
            return undefined;
        }

        const asset = selectVsixAsset(release.assets, this.manifest.name, version);
        if (!asset) {
            throw new Error(`Release ${release.tag_name} has no .vsix file.`);
        }
        // Only ever install a file that this repository published.
        const downloadPrefix = `https://github.com/${owner}/${repo}/releases/download/`.toLowerCase();
        if (!asset.browser_download_url.toLowerCase().startsWith(downloadPrefix)) {
            throw new Error(`Unexpected download location: ${asset.browser_download_url}`);
        }

        return {
            version,
            fileName: path.basename(asset.name),
            downloadUrl: asset.browser_download_url,
            size: typeof asset.size === "number" ? asset.size : undefined,
            sha256: sha256FromDigest(asset.digest),
            notesUrl: typeof release.html_url === "string" ? release.html_url : undefined
        };
    }

    /**
     * The API-free way to the latest release: github.com/<owner>/<repo>/releases/latest
     * redirects to the release's tag. Its .vsix is assumed to have the conventional name,
     * and comes without the size and checksum that only the API reports.
     */
    async findReleaseOnWebsite() {
        const { owner, repo } = this.repository;
        const releases = `https://github.com/${owner}/${repo}/releases`;
        const location = await this.net.fetchRedirect(`${releases}/latest`);
        const match = /\/releases\/tag\/([^/?#]+)$/.exec(location || "");
        if (!match) {
            // A repository without releases redirects to the empty release list.
            return undefined;
        }
        const tag = decodeURIComponent(match[1]);
        const fileName = `${this.manifest.name}-${tag.replace(/^v/, "")}.vsix`;
        return {
            tag_name: tag,
            html_url: `${releases}/tag/${encodeURIComponent(tag)}`,
            assets: [{ name: fileName, browser_download_url: `${releases}/download/${encodeURIComponent(tag)}/${fileName}` }]
        };
    }

    /** Asks before installing ("notify" and "off" modes). Resolves true to install. */
    async confirmInstall(update, manual) {
        const { vscode } = this;
        const t = vscode.l10n.t;
        const install = t("Install Now");
        const notes = t("Release Notes");
        const skip = t("Skip This Version");
        const actions = [install];
        if (update.notesUrl) {
            actions.push(notes);
        }
        if (!manual) {
            actions.push(skip);
        }

        for (;;) {
            const choice = await vscode.window.showInformationMessage(
                t("Solution Explorer {0} is available (installed: {1}).", update.version, this.currentVersion),
                ...actions);
            if (choice === notes) {
                // Reading the notes is not an answer: ask again afterwards.
                await vscode.env.openExternal(vscode.Uri.parse(update.notesUrl));
                continue;
            }
            if (choice === skip) {
                await this.context.globalState.update(SKIPPED_VERSION_KEY, update.version);
            }
            return choice === install;
        }
    }

    /** Downloads the release's .vsix, installs it and offers to reload the window. */
    async install(update, reportFailures) {
        const { vscode } = this;
        const t = vscode.l10n.t;
        if (this.busy) {
            return;
        }

        this.busy = true;
        let lock;
        try {
            lock = await this.acquireInstallLock();
            if (!lock) {
                // Another window is installing; it will record the pending version.
                if (reportFailures) {
                    vscode.window.showInformationMessage(t("An update check is already in progress."));
                }
                return;
            }
            const vsixPath = path.join(this.updatesFolder, update.fileName);
            await vscode.window.withProgress(
                {
                    location: reportFailures ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
                    title: t("Downloading Solution Explorer {0}...", update.version)
                },
                async progress => {
                    await this.removeOtherDownloads(update.fileName);
                    let shown;
                    const onProgress = (received, total) => {
                        const message = total
                            ? `${Math.floor(received * 100 / total)}%`
                            : `${(received / (1024 * 1024)).toFixed(1)} MB`;
                        if (message !== shown) {
                            shown = message;
                            progress.report({ message });
                        }
                    };
                    await this.net.downloadFile(update.downloadUrl, vsixPath, { size: update.size, sha256: update.sha256, onProgress });
                    await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsixPath));
                });
            await this.context.globalState.update(PENDING_VERSION_KEY, update.version);
        } catch (error) {
            this.reportFailure(error, reportFailures);
            // What was downloaded is kept and resumed, so try again soon instead of tomorrow.
            await this.context.globalState.update(LAST_CHECK_KEY, this.now() - CHECK_INTERVAL_MS + RETRY_FAILED_INSTALL_MS);
            return;
        } finally {
            if (lock) {
                await fs.promises.rm(lock, { force: true }).catch(() => undefined);
            }
            this.busy = false;
        }
        this.promptReload(update);
    }

    /** Deletes downloads of other releases; this release's partial download is kept to resume it. */
    async removeOtherDownloads(fileName) {
        const keep = new Set([fileName, `${fileName}.part`, "install.lock"]);
        for (const entry of await fs.promises.readdir(this.updatesFolder)) {
            if (!keep.has(entry)) {
                await fs.promises.rm(path.join(this.updatesFolder, entry), { recursive: true, force: true });
            }
        }
    }

    /**
     * Every open window runs its own copy of the extension, and they all share the
     * updates folder. The lock file keeps them from downloading and installing the
     * same release at once. Resolves with the lock's path, or undefined when another
     * window holds it.
     */
    async acquireInstallLock() {
        const lock = path.join(this.updatesFolder, "install.lock");
        await fs.promises.mkdir(this.updatesFolder, { recursive: true });
        try {
            // A window that was closed mid-install leaves its lock behind.
            const stat = await fs.promises.stat(lock);
            if (this.now() - stat.mtimeMs > LOCK_STALE_MS) {
                await fs.promises.rm(lock, { force: true });
            }
        } catch (error) {
            // No lock file.
        }
        try {
            await (await fs.promises.open(lock, "wx")).close();
            return lock;
        } catch (error) {
            if (error && error.code === "EEXIST") {
                return undefined;
            }
            throw error;
        }
    }

    /** The new version only runs after a reload; the notification is not awaited. */
    promptReload(update) {
        const { vscode } = this;
        const t = vscode.l10n.t;
        const reload = t("Reload Window");
        const notes = t("Release Notes");
        const actions = update.notesUrl ? [reload, notes] : [reload];
        Promise.resolve(vscode.window.showInformationMessage(
            t("Solution Explorer {0} has been installed. Reload the window to start using it.", update.version),
            ...actions))
            .then(choice => {
                if (choice === reload) {
                    return vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
                if (choice === notes) {
                    return vscode.env.openExternal(vscode.Uri.parse(update.notesUrl));
                }
                return undefined;
            })
            .then(undefined, error => this.log(error));
    }

    reportFailure(error, visible) {
        this.log(error);
        if (visible) {
            const message = error && error.message ? error.message : String(error);
            this.vscode.window.showErrorMessage(this.vscode.l10n.t("Could not update Solution Explorer: {0}", message));
        }
    }

    log(error) {
        console.warn("[solution-explorer] update:", error && error.message ? error.message : error);
    }
}

/** Called by extension.js. Must never throw: updating is not worth breaking the extension. */
function activate(context) {
    try {
        new Updater(context, require("vscode")).register();
    } catch (error) {
        console.warn("[solution-explorer] update: could not start", error);
    }
}

module.exports = {
    activate,
    Updater,
    compareVersions,
    parseGitHubRepository,
    selectVsixAsset,
    sha256FromDigest,
    fetchJson,
    fetchRedirect,
    downloadFile,
    CHECK_INTERVAL_MS,
    RETRY_FAILED_INSTALL_MS,
    LAST_CHECK_KEY,
    PENDING_VERSION_KEY,
    SKIPPED_VERSION_KEY
};
