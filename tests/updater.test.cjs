const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const updater = require("../out/updater.js");
const {
    Updater, compareVersions, parseGitHubRepository, selectVsixAsset, sha256FromDigest,
    fetchJson, fetchRedirect, downloadFile, CHECK_INTERVAL_MS, RETRY_FAILED_INSTALL_MS, LAST_CHECK_KEY, PENDING_VERSION_KEY, SKIPPED_VERSION_KEY
} = updater;

const DOWNLOAD_URL = "https://github.com/rikpan/custom-vscode-solution-explorer/releases/download/v0.9.13/custom-vscode-solution-explorer-0.9.13.vsix";
const NOTES_URL = "https://github.com/rikpan/custom-vscode-solution-explorer/releases/tag/v0.9.13";
const DIGEST = "a".repeat(64);

function release(overrides = {}) {
    return {
        tag_name: "v0.9.13",
        html_url: NOTES_URL,
        assets: [{
            name: "custom-vscode-solution-explorer-0.9.13.vsix",
            size: 1234,
            digest: `sha256:${DIGEST}`,
            browser_download_url: DOWNLOAD_URL
        }],
        ...overrides
    };
}

function temporaryFolder(t) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "updater-test-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    return folder;
}

/** A stand-in for the vscode module and the network, recording everything the updater does. */
function createHarness(t, options = {}) {
    const calls = { fetches: [], redirects: [], downloads: [], commands: [], info: [], errors: [], opened: [], progress: [] };
    const state = new Map(Object.entries(options.state || {}));
    const answers = [...(options.answers || [])];
    const settings = { mode: options.mode };
    let time = options.now || 1_000_000_000_000;

    const vscode = {
        ExtensionMode: { Production: 1, Development: 2, Test: 3 },
        ProgressLocation: { Notification: 15, Window: 10 },
        Uri: { file: fsPath => ({ scheme: "file", fsPath }), parse: value => ({ value }) },
        l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index) => String(args[index])) },
        env: { openExternal: async uri => { calls.opened.push(uri.value); return true; } },
        workspace: {
            getConfiguration: section => {
                assert.equal(section, "vssolution");
                return { get: (key, fallback) => (key === "update.mode" && settings.mode !== undefined ? settings.mode : fallback) };
            }
        },
        commands: {
            registerCommand: (id, handler) => { calls.commands.push(["register", id]); return { dispose() {}, handler }; },
            executeCommand: async (id, ...args) => { calls.commands.push([id, ...args]); }
        },
        window: {
            withProgress: (_options, task) => task({ report: ({ message }) => calls.progress.push(message) }),
            showInformationMessage: async (message, ...actions) => { calls.info.push({ message, actions }); return answers.shift(); },
            showErrorMessage: async message => { calls.errors.push(message); }
        }
    };

    const context = {
        extensionMode: options.extensionMode || vscode.ExtensionMode.Production,
        extension: {
            packageJSON: {
                name: "custom-vscode-solution-explorer",
                version: options.version || "0.9.12",
                repository: { type: "git", url: "https://github.com/rikpan/custom-vscode-solution-explorer" }
            }
        },
        globalStorageUri: { fsPath: temporaryFolder(t) },
        globalState: {
            get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
            update: async (key, value) => { value === undefined ? state.delete(key) : state.set(key, value); }
        },
        subscriptions: []
    };

    const net = {
        fetchJson: async url => {
            calls.fetches.push(url);
            if (options.fetchError) {
                throw options.fetchError;
            }
            return options.release || release();
        },
        fetchRedirect: async url => {
            calls.redirects.push(url);
            return options.redirect;
        },
        downloadFile: async (url, destination, expected) => {
            calls.downloads.push({ url, destination, expected });
            if (options.downloadError) {
                throw options.downloadError;
            }
            for (const received of [300, 617, 620, 1234]) {
                expected.onProgress(received, expected.size);
            }
            fs.writeFileSync(destination, "vsix");
        }
    };

    const instance = new Updater(context, vscode, net, () => time);
    return {
        updater: instance, calls, state, context, settings, vscode,
        advance: milliseconds => { time += milliseconds; },
        installs: () => calls.commands.filter(([id]) => id === "workbench.extensions.installExtension"),
        flush: () => new Promise(resolve => setImmediate(resolve))
    };
}

// The updater logs failures; keep the test output readable.
test.beforeEach(t => t.mock.method(console, "warn", () => {}));

test("versions are compared numerically, ignoring a leading v", () => {
    assert.ok(compareVersions("0.9.13", "0.9.12") > 0);
    assert.ok(compareVersions("0.10.0", "0.9.99") > 0);
    assert.ok(compareVersions("v1.0.0", "0.99.99") > 0);
    assert.equal(compareVersions("v0.9.12", "0.9.12"), 0);
    assert.ok(compareVersions("0.9.12", "0.9.13") < 0);
    assert.ok(compareVersions("1.0.0-beta", "1.0.0") < 0);
    assert.ok(compareVersions("nonsense", "0.0.1") < 0);
});

test("the GitHub repository is read from package.json", () => {
    const expected = { owner: "rikpan", repo: "custom-vscode-solution-explorer" };
    assert.deepEqual(parseGitHubRepository({ url: "https://github.com/rikpan/custom-vscode-solution-explorer" }), expected);
    assert.deepEqual(parseGitHubRepository("https://github.com/rikpan/custom-vscode-solution-explorer.git"), expected);
    assert.deepEqual(parseGitHubRepository("git@github.com:rikpan/custom-vscode-solution-explorer.git"), expected);
    assert.equal(parseGitHubRepository({ url: "https://example.com/rikpan/repo" }), undefined);
    assert.equal(parseGitHubRepository(undefined), undefined);
});

test("the conventionally named .vsix is preferred among a release's assets", () => {
    const asset = name => ({ name, browser_download_url: `https://github.com/o/r/releases/download/v1.0.0/${name}` });
    const assets = [asset("notes.txt"), asset("other-1.0.0.vsix"), asset("my-ext-1.0.0.vsix")];
    assert.equal(selectVsixAsset(assets, "my-ext", "1.0.0").name, "my-ext-1.0.0.vsix");
    assert.equal(selectVsixAsset(assets, "renamed", "1.0.0").name, "other-1.0.0.vsix");
    assert.equal(selectVsixAsset([asset("notes.txt")], "my-ext", "1.0.0"), undefined);
    assert.equal(selectVsixAsset(undefined, "my-ext", "1.0.0"), undefined);
});

test("only sha256 digests are used", () => {
    assert.equal(sha256FromDigest(`sha256:${DIGEST}`), DIGEST);
    assert.equal(sha256FromDigest("md5:abc"), undefined);
    assert.equal(sha256FromDigest(null), undefined);
});

test("auto mode downloads, installs and offers a reload", async t => {
    const h = createHarness(t, { answers: ["Reload Window"] });
    await h.updater.checkIfDue();
    await h.flush();

    assert.deepEqual(h.calls.fetches, ["https://api.github.com/repos/rikpan/custom-vscode-solution-explorer/releases/latest"]);
    assert.equal(h.calls.downloads.length, 1);
    const [download] = h.calls.downloads;
    assert.equal(download.url, DOWNLOAD_URL);
    assert.equal(download.expected.size, 1234);
    assert.equal(download.expected.sha256, DIGEST);
    assert.deepEqual(h.calls.progress, ["24%", "50%", "100%"]);
    assert.equal(path.basename(download.destination), "custom-vscode-solution-explorer-0.9.13.vsix");
    assert.ok(download.destination.startsWith(h.context.globalStorageUri.fsPath));

    assert.deepEqual(h.installs(), [["workbench.extensions.installExtension", { scheme: "file", fsPath: download.destination }]]);
    assert.equal(h.state.get(PENDING_VERSION_KEY), "0.9.13");
    assert.equal(h.calls.info.length, 1);
    assert.match(h.calls.info[0].message, /0\.9\.13 has been installed/);
    assert.deepEqual(h.calls.commands.at(-1), ["workbench.action.reloadWindow"]);
    assert.ok(!fs.existsSync(path.join(path.dirname(download.destination), "install.lock")), "the install lock is released");
});

test("nothing is downloaded when the installed version is current", async t => {
    for (const version of ["0.9.13", "0.9.14"]) {
        const h = createHarness(t, { version });
        await h.updater.checkIfDue();
        assert.equal(h.calls.fetches.length, 1);
        assert.equal(h.calls.downloads.length, 0);
        assert.deepEqual(h.calls.info, []);
    }
});

test("the automatic check runs at most once a day", async t => {
    const h = createHarness(t, { version: "0.9.13" });
    await h.updater.checkIfDue();
    await h.updater.checkIfDue();
    h.advance(CHECK_INTERVAL_MS - 1);
    await h.updater.checkIfDue();
    assert.equal(h.calls.fetches.length, 1);
    h.advance(1);
    await h.updater.checkIfDue();
    assert.equal(h.calls.fetches.length, 2);
});

test("a failed automatic check is silent and not retried until the next day", async t => {
    const h = createHarness(t, { fetchError: new Error("HTTP 403 from api.github.com") });
    await h.updater.checkIfDue();
    await h.updater.checkIfDue();
    assert.equal(h.calls.fetches.length, 1);
    assert.deepEqual(h.calls.errors, []);
    assert.deepEqual(h.calls.info, []);
});

test("off mode never checks on its own, but the command still does", async t => {
    const h = createHarness(t, { mode: "off", answers: ["Install Now"] });
    await h.updater.checkIfDue();
    assert.equal(h.calls.fetches.length, 0);

    await h.updater.check(true);
    assert.equal(h.calls.fetches.length, 1);
    assert.match(h.calls.info[0].message, /0\.9\.13 is available \(installed: 0\.9\.12\)/);
    assert.deepEqual(h.calls.info[0].actions, ["Install Now", "Release Notes"]);
    assert.equal(h.installs().length, 1);
});

test("notify mode asks first and installs on confirmation", async t => {
    const h = createHarness(t, { mode: "notify", answers: ["Release Notes", "Install Now"] });
    await h.updater.checkIfDue();
    assert.deepEqual(h.calls.info[0].actions, ["Install Now", "Release Notes", "Skip This Version"]);
    assert.deepEqual(h.calls.opened, [NOTES_URL]);
    assert.equal(h.installs().length, 1);
    assert.equal(h.state.get(PENDING_VERSION_KEY), "0.9.13");
});

test("notify mode installs nothing when the notification is dismissed", async t => {
    const h = createHarness(t, { mode: "notify", answers: [undefined] });
    await h.updater.checkIfDue();
    assert.equal(h.calls.downloads.length, 0);
    assert.equal(h.state.has(SKIPPED_VERSION_KEY), false);
});

test("a skipped version is not offered again automatically, only on demand", async t => {
    const h = createHarness(t, { mode: "notify", answers: ["Skip This Version", undefined] });
    await h.updater.checkIfDue();
    assert.equal(h.state.get(SKIPPED_VERSION_KEY), "0.9.13");
    assert.equal(h.calls.info.length, 1);

    h.advance(CHECK_INTERVAL_MS);
    await h.updater.checkIfDue();
    assert.equal(h.calls.fetches.length, 2);
    assert.equal(h.calls.info.length, 1, "no second prompt for the skipped version");

    await h.updater.check(true);
    assert.equal(h.calls.info.length, 2, "the command offers it again");
});

test("an update that is installed but not yet loaded is not downloaded again", async t => {
    const h = createHarness(t, { state: { [PENDING_VERSION_KEY]: "0.9.13" }, answers: [undefined] });
    await h.updater.checkIfDue();
    await h.flush();
    assert.equal(h.calls.downloads.length, 0);
    assert.match(h.calls.info[0].message, /Reload the window/);
});

test("the command reports that the extension is up to date", async t => {
    const h = createHarness(t, { version: "0.9.13", state: { [LAST_CHECK_KEY]: 1_000_000_000_000 } });
    await h.updater.check(true);
    assert.equal(h.calls.fetches.length, 1, "the command ignores the daily limit");
    assert.deepEqual(h.calls.info.map(i => i.message), ["Solution Explorer is up to date (version 0.9.13)."]);
});

test("the command reports failures", async t => {
    const h = createHarness(t, { fetchError: new Error("HTTP 403 from api.github.com") });
    await h.updater.check(true);
    assert.deepEqual(h.calls.errors, ["Could not update Solution Explorer: HTTP 403 from api.github.com"]);
});

test("a failed download installs nothing and is retried an hour later", async t => {
    const h = createHarness(t, { downloadError: new Error("aborted") });
    await h.updater.checkIfDue();
    assert.equal(h.installs().length, 0);
    assert.equal(h.state.has(PENDING_VERSION_KEY), false);
    assert.deepEqual(h.calls.errors, [], "automatic failures stay silent");
    assert.ok(!fs.existsSync(path.join(h.updater.updatesFolder, "install.lock")), "the install lock is released");

    h.advance(RETRY_FAILED_INSTALL_MS - 1);
    await h.updater.checkIfDue();
    assert.equal(h.calls.downloads.length, 1);
    h.advance(1);
    await h.updater.checkIfDue();
    assert.equal(h.calls.downloads.length, 2);
});

test("downloads of other releases are deleted, a partial one of this release is kept", async t => {
    const h = createHarness(t);
    const folder = h.updater.updatesFolder;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "custom-vscode-solution-explorer-0.9.12.vsix"), "old");
    fs.writeFileSync(path.join(folder, "custom-vscode-solution-explorer-0.9.12.vsix.part"), "old");
    fs.writeFileSync(path.join(folder, "custom-vscode-solution-explorer-0.9.13.vsix.part"), "resumable");

    await h.updater.checkIfDue();
    assert.deepEqual(fs.readdirSync(folder).sort(), [
        "custom-vscode-solution-explorer-0.9.13.vsix",
        "custom-vscode-solution-explorer-0.9.13.vsix.part"
    ]);
});

function rateLimited() {
    return Object.assign(new Error("HTTP 403 from api.github.com"), { status: 403 });
}

test("when the API quota is used up, the release is found through the website", async t => {
    const h = createHarness(t, {
        fetchError: rateLimited(),
        redirect: "https://github.com/rikpan/custom-vscode-solution-explorer/releases/tag/v0.9.13"
    });
    await h.updater.checkIfDue();
    await h.flush();

    assert.deepEqual(h.calls.redirects, ["https://github.com/rikpan/custom-vscode-solution-explorer/releases/latest"]);
    const [download] = h.calls.downloads;
    assert.equal(download.url, DOWNLOAD_URL);
    assert.equal(download.expected.size, undefined);
    assert.equal(download.expected.sha256, undefined);
    assert.deepEqual(h.calls.progress, ["0.0 MB"]);
    assert.equal(h.installs().length, 1);
    assert.equal(h.state.get(PENDING_VERSION_KEY), "0.9.13");
    assert.deepEqual(h.calls.errors, []);
});

test("the website fallback finds no update for the current version or without releases", async t => {
    for (const redirect of [
        "https://github.com/rikpan/custom-vscode-solution-explorer/releases/tag/v0.9.12",
        "https://github.com/rikpan/custom-vscode-solution-explorer/releases",
        undefined
    ]) {
        const h = createHarness(t, { fetchError: rateLimited(), redirect });
        await h.updater.check(true);
        assert.equal(h.calls.downloads.length, 0);
        assert.deepEqual(h.calls.errors, []);
        assert.deepEqual(h.calls.info.map(i => i.message), ["Solution Explorer is up to date (version 0.9.12)."]);
    }
});

test("other API failures do not fall back to the website", async t => {
    const h = createHarness(t, { fetchError: Object.assign(new Error("HTTP 500 from api.github.com"), { status: 500 }) });
    await h.updater.check(true);
    assert.deepEqual(h.calls.redirects, []);
    assert.deepEqual(h.calls.errors, ["Could not update Solution Explorer: HTTP 500 from api.github.com"]);
});

test("a release without a .vsix, or hosted elsewhere, is rejected", async t => {
    const withoutVsix = createHarness(t, { release: release({ assets: [] }) });
    await withoutVsix.updater.check(true);
    assert.match(withoutVsix.calls.errors[0], /has no \.vsix file/);

    const foreign = release();
    foreign.assets[0].browser_download_url = "https://github.com/someone-else/repo/releases/download/v0.9.13/x.vsix";
    const elsewhere = createHarness(t, { release: foreign });
    await elsewhere.updater.check(true);
    assert.match(elsewhere.calls.errors[0], /Unexpected download location/);
    assert.equal(elsewhere.calls.downloads.length, 0);
});

test("a window that finds another one installing does nothing", async t => {
    const h = createHarness(t);
    fs.mkdirSync(h.updater.updatesFolder, { recursive: true });
    const lock = path.join(h.updater.updatesFolder, "install.lock");
    fs.writeFileSync(lock, "");
    fs.utimesSync(lock, new Date(1_000_000_000_000), new Date(1_000_000_000_000));

    await h.updater.checkIfDue();
    assert.equal(h.calls.downloads.length, 0);
    assert.ok(fs.existsSync(lock), "the other window's lock is left alone");

    // A lock abandoned by a closed window expires.
    h.advance(CHECK_INTERVAL_MS);
    await h.updater.checkIfDue();
    assert.equal(h.calls.downloads.length, 1);
});

test("starting the updated version clears the pending state and the download", async t => {
    const h = createHarness(t, { version: "0.9.13", state: { [PENDING_VERSION_KEY]: "0.9.13", [SKIPPED_VERSION_KEY]: "0.9.12" } });
    fs.mkdirSync(h.updater.updatesFolder, { recursive: true });
    fs.writeFileSync(path.join(h.updater.updatesFolder, "old.vsix"), "vsix");

    await h.updater.finishAppliedUpdate();
    assert.equal(h.state.has(PENDING_VERSION_KEY), false);
    assert.equal(h.state.has(SKIPPED_VERSION_KEY), false);
    assert.ok(!fs.existsSync(h.updater.updatesFolder));
});

test("register adds the command and schedules checks only for an installed extension", t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const installed = createHarness(t, { version: "0.9.13" });
    installed.updater.register();
    assert.deepEqual(installed.calls.commands, [["register", "solutionExplorer.checkForUpdates"]]);
    assert.equal(installed.context.subscriptions.length, 2);
    installed.context.subscriptions.forEach(subscription => subscription.dispose());

    const development = createHarness(t, { extensionMode: 2 });
    development.updater.register();
    assert.equal(development.context.subscriptions.length, 1, "no timers in a development host");
    t.mock.timers.tick(48 * 60 * 60 * 1000);
    assert.equal(development.calls.fetches.length, 0);
});

// --- network helpers, driven by a fake https.get ---------------------------

/**
 * Returns a get() like https.get. routes: url -> { status, headers, body, dropAfter, drops }.
 * A 200 route honours Range requests; with dropAfter it sends that many bytes and then
 * breaks the connection, "drops" times.
 */
function fakeGet(routes, requested = []) {
    return (url, options, callback) => {
        const range = options.headers.Range;
        requested.push(range ? `${url} ${range}` : url.toString());
        const route = routes[url.toString()] || { status: 404 };
        let status = route.status;
        let body = Buffer.from(route.body || "");
        if (status === 200 && range) {
            const offset = Number(/^bytes=(\d+)-$/.exec(range)[1]);
            status = offset < body.length ? 206 : 416;
            body = body.subarray(offset);
        }
        const drop = status < 300 && route.drops > 0 && route.drops-- > 0;
        const response = Readable.from((async function* () {
            if (drop) {
                yield body.subarray(0, route.dropAfter);
                // A real connection stalls before it breaks, so what arrived is on disk by then.
                await new Promise(resolve => setTimeout(resolve, 25));
                throw new Error("aborted");
            }
            if (body.length > 0) {
                yield body;
            }
        })());
        response.statusCode = status;
        response.headers = route.headers || {};
        setImmediate(() => callback(response));
        return { on() { return this; }, destroy() {} };
    };
}

const FILE_URL = "https://cdn.example/x.vsix";
const BODY = "0123456789abcdefghij";
const BODY_SHA256 = crypto.createHash("sha256").update(BODY).digest("hex");
const quick = { size: BODY.length, sha256: BODY_SHA256, retryDelayMs: 0 };

test("downloads follow redirects and appear only when complete", async t => {
    const folder = temporaryFolder(t);
    const requested = [];
    const get = fakeGet({
        "https://github.com/o/r/releases/download/v1/x.vsix": { status: 302, headers: { location: FILE_URL } },
        [FILE_URL]: { status: 200, body: BODY }
    }, requested);

    const destination = path.join(folder, "nested", "x.vsix");
    const progress = [];
    await downloadFile("https://github.com/o/r/releases/download/v1/x.vsix", destination,
        { ...quick, onProgress: (received, total) => progress.push([received, total]) }, get);
    assert.equal(fs.readFileSync(destination, "utf8"), BODY);
    assert.ok(!fs.existsSync(`${destination}.part`));
    assert.deepEqual(requested, ["https://github.com/o/r/releases/download/v1/x.vsix", FILE_URL]);
    assert.deepEqual(progress, [[BODY.length, BODY.length]]);
});

test("an interrupted download is resumed where it stopped", async t => {
    const destination = path.join(temporaryFolder(t), "x.vsix");
    const requested = [];
    const get = fakeGet({ [FILE_URL]: { status: 200, body: BODY, dropAfter: 6, drops: 2 } }, requested);

    await downloadFile(FILE_URL, destination, quick, get);
    assert.equal(fs.readFileSync(destination, "utf8"), BODY);
    assert.deepEqual(requested, [FILE_URL, `${FILE_URL} bytes=6-`, `${FILE_URL} bytes=12-`]);
});

test("a download that keeps failing is continued by the next call", async t => {
    const destination = path.join(temporaryFolder(t), "x.vsix");
    const route = { status: 200, body: BODY, dropAfter: 4, drops: 2 };
    const requested = [];
    const get = fakeGet({ [FILE_URL]: route }, requested);

    await assert.rejects(downloadFile(FILE_URL, destination, { ...quick, attempts: 2 }, get), /aborted/);
    assert.ok(!fs.existsSync(destination));
    assert.equal(fs.readFileSync(`${destination}.part`, "utf8"), BODY.slice(0, 8));

    await downloadFile(FILE_URL, destination, quick, get);
    assert.equal(fs.readFileSync(destination, "utf8"), BODY);
    assert.equal(requested.at(-1), `${FILE_URL} bytes=8-`);
});

test("a download that fails the checksum is discarded", async t => {
    const destination = path.join(temporaryFolder(t), "x.vsix");
    const get = fakeGet({ [FILE_URL]: { status: 200, body: BODY } });
    await assert.rejects(downloadFile(FILE_URL, destination, { ...quick, sha256: "0".repeat(64) }, get), /checksum/);
    assert.ok(!fs.existsSync(destination));
    assert.ok(!fs.existsSync(`${destination}.part`));
});

test("a partial file that does not belong to the release does not block the update", async t => {
    const destination = path.join(temporaryFolder(t), "x.vsix");
    const requested = [];
    const get = fakeGet({ [FILE_URL]: { status: 200, body: BODY } }, requested);

    // Same length, different content: nothing left to request, but the checksum fails.
    fs.writeFileSync(`${destination}.part`, "x".repeat(BODY.length));
    await assert.rejects(downloadFile(FILE_URL, destination, quick, get), /checksum/);
    assert.deepEqual(requested, []);
    await downloadFile(FILE_URL, destination, quick, get);
    assert.equal(fs.readFileSync(destination, "utf8"), BODY);

    // Longer than the release: started over.
    fs.rmSync(destination);
    fs.writeFileSync(`${destination}.part`, "x".repeat(BODY.length + 5));
    await downloadFile(FILE_URL, destination, quick, get);
    assert.equal(fs.readFileSync(destination, "utf8"), BODY);
});

test("a download larger or smaller than the release says is rejected", async t => {
    const folder = temporaryFolder(t);
    const requested = [];
    const get = fakeGet({ [FILE_URL]: { status: 200, body: BODY } }, requested);

    const larger = path.join(folder, "larger.vsix");
    await assert.rejects(downloadFile(FILE_URL, larger, { ...quick, size: BODY.length - 1 }, get), /larger than expected/);
    assert.equal(requested.length, 1, "not retried");
    assert.ok(!fs.existsSync(larger) && !fs.existsSync(`${larger}.part`));

    const smaller = path.join(folder, "smaller.vsix");
    await assert.rejects(downloadFile(FILE_URL, smaller, { ...quick, size: BODY.length + 1, attempts: 3 }, get));
    assert.ok(!fs.existsSync(smaller));
});

test("requests refuse plain HTTP, including as a redirect target, and do not retry HTTP errors", async t => {
    const folder = temporaryFolder(t);
    const requested = [];
    const get = fakeGet({
        "https://example.com/redirect": { status: 301, headers: { location: "http://example.com/plain" } },
        "https://example.com/json": { status: 200, body: "{\"tag_name\":\"v1.2.3\"}" }
    }, requested);
    await assert.rejects(fetchJson("http://example.com/json", get), /non-HTTPS/);
    await assert.rejects(downloadFile("https://example.com/redirect", path.join(folder, "x.vsix"), { retryDelayMs: 0, attempts: 1 }, get), /non-HTTPS/);
    await assert.rejects(fetchJson("https://example.com/missing", get), /HTTP 404/);
    assert.deepEqual(await fetchJson("https://example.com/json", get), { tag_name: "v1.2.3" });

    requested.length = 0;
    await assert.rejects(downloadFile("https://example.com/missing", path.join(folder, "y.vsix"), { retryDelayMs: 0 }, get), /HTTP 404/);
    assert.deepEqual(requested, ["https://example.com/missing"]);
});

test("a redirect is reported without being followed", async () => {
    const requested = [];
    const get = fakeGet({
        "https://github.com/o/r/releases/latest": { status: 302, headers: { location: "/o/r/releases/tag/v1.2.3" } },
        "https://github.com/o/r/releases/tag/v1.2.3": { status: 200, body: "page" }
    }, requested);
    assert.equal(await fetchRedirect("https://github.com/o/r/releases/latest", get), "https://github.com/o/r/releases/tag/v1.2.3");
    assert.deepEqual(requested, ["https://github.com/o/r/releases/latest"]);
    assert.equal(await fetchRedirect("https://github.com/o/r/releases/tag/v1.2.3", get), undefined);
    await assert.rejects(fetchRedirect("https://github.com/o/missing", get), error => error.status === 404);
    await assert.rejects(fetchRedirect("http://github.com/o/r/releases/latest", get), /non-HTTPS/);
});
