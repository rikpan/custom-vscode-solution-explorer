// Prints the release notes of a version: its section of CHANGELOG.md followed by
// install instructions. Used by the release workflow.
// Usage: node scripts/release-notes.js [version]   (default: the version in package.json)
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** Returns the body of the "## <version>" section of a changelog, or undefined. */
function changelogSection(changelog, version) {
    const lines = changelog.split(/\r?\n/);
    const start = lines.findIndex(line => line.trim() === `## ${version}`);
    if (start < 0) {
        return undefined;
    }
    const length = lines.slice(start + 1).findIndex(line => /^## /.test(line));
    const body = lines.slice(start + 1, length < 0 ? undefined : start + 1 + length).join("\n").trim();
    return body || undefined;
}

function releaseNotes(changelog, name, version) {
    const fileName = `${name}-${version}.vsix`;
    return [
        changelogSection(changelog, version) || `Version ${version}.`,
        "",
        "### Install",
        "",
        "Installed copies from 0.9.13 on update themselves within a day; run **Solution Explorer: Check for Updates** to update now.",
        "",
        `To install by hand, download \`${fileName}\` below and run **Extensions: Install from VSIX...** in VS Code, or:`,
        "",
        "```",
        `code --install-extension ${fileName}`,
        "```",
        ""
    ].join("\n");
}

if (require.main === module) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const version = process.argv[2] || manifest.version;
    const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
    if (!changelogSection(changelog, version)) {
        // "::warning::" is shown as an annotation on the workflow run.
        console.error(`::warning::CHANGELOG.md has no "## ${version}" section; the release notes only name the version.`);
    }
    process.stdout.write(releaseNotes(changelog, manifest.name, version));
}

module.exports = { changelogSection, releaseNotes };
