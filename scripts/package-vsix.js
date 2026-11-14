// Packages the extension into <name>-<version>.vsix, in the repo root or in the
// directory given as the first argument. Used by "npm run package" and by the
// release workflow (.github/workflows/release.yml), so both produce the same file.
//
// vsce always runs the "vscode:prepublish" script, which rebuilds out/extension.js
// with webpack. This repo ships that bundle prebuilt and has no sources to rebuild it
// from, so the package is made from a staged copy of the checkout whose package.json
// has the prepublish scripts removed. The translation files that the prepublish step
// would have regenerated are regenerated in the staged copy instead.
const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VSCE = "@vscode/vsce@4";

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const outDir = path.resolve(process.argv[2] || ROOT);
const vsixPath = path.join(outDir, `${manifest.name}-${manifest.version}.vsix`);

// Tracked files plus new ones that are not ignored: the checkout as it is, without
// node_modules, earlier .vsix files or test output.
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(file => file && fs.existsSync(path.join(ROOT, file)));

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "package-vsix-"));
try {
    for (const file of files) {
        const target = path.join(stage, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), target);
    }

    delete manifest.scripts["vscode:prepublish"];
    delete manifest.scripts["prevscode:prepublish"];
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(manifest, null, "\t") + "\n", "utf8");

    execFileSync(process.execPath, [path.join(stage, "scripts", "generate-all-translations.js")], { cwd: stage, stdio: "inherit" });

    fs.mkdirSync(outDir, { recursive: true });
    // --no-dependencies: the runtime dependencies are inside the bundle, there is no node_modules.
    // --allow-star-activation: the extension activates on "*" to load solutions at startup.
    execSync(`npx --yes ${VSCE} package --no-dependencies --allow-star-activation --out "${vsixPath}"`, { cwd: stage, stdio: "inherit" });
} finally {
    fs.rmSync(stage, { recursive: true, force: true });
}

console.log(`Packaged ${path.relative(process.cwd(), vsixPath) || vsixPath}`);
