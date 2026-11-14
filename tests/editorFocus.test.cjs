const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// This checkout ships the webpack bundle without its original TypeScript sources.
const bundle = fs.readFileSync(path.join(__dirname, "../out/extension.js"), "utf8");
const start = bundle.indexOf('t.SolutionExplorerProvider=void 0;');
const endMarker = "t.SolutionExplorerProvider=c";
const end = bundle.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, "Provider module must exist in the shipped bundle");

function createProvider() {
    const file = { path: "C:/project/Example.cs" };
    const reveals = [];
    const scheduled = [];
    const vscode = {
        Disposable: class {},
        window: { activeTextEditor: { document: { uri: { scheme: "file", fsPath: file.path } } } }
    };
    const dependencies = {
        1398: vscode,
        5205: { getShowMode: () => "activityBar", getTrackActiveItem: () => true },
        1073: {},
        5385: { normalizePath: value => value },
        6716: {}
    };
    const exports = {};
    vm.runInNewContext(bundle.slice(start, end + endMarker.length), {
        t: exports,
        r: id => dependencies[id],
        setTimeout: callback => scheduled.push(callback)
    });
    const provider = Object.create(exports.SolutionExplorerProvider.prototype);
    provider.solutionTreeItemCollection = { items: [file], hasChildren: true };
    provider.treeView = {
        visible: true,
        selection: [],
        reveal: async (item, options) => reveals.push({ item, ...options })
    };
    return { provider, file, reveals, scheduled };
}

function assertPreservedFocus(reveals, file) {
    assert.deepEqual(reveals, [{ item: file, select: true, focus: false }]);
}

test("selecting the active document preserves editor focus", async () => {
    const { provider, file, reveals } = createProvider();
    await provider.selectActiveDocument();
    assertPreservedFocus(reveals, file);
});

for (const entryPoint of ["onActiveEditorChanged", "revealActiveDocumentOnShow"]) {
    test(`${entryPoint} preserves editor focus`, async () => {
        const { provider, file, reveals } = createProvider();
        provider[entryPoint]();
        await new Promise(resolve => setImmediate(resolve));
        assertPreservedFocus(reveals, file);
    });
}

test("deferred reveal after loading preserves editor focus", async () => {
    const { provider, file, reveals, scheduled } = createProvider();
    provider.creatingSolutionItems = true;
    provider.revealActiveDocumentOnShow();
    assert.equal(provider.revealActiveOnLoad, true);
    provider.solutionFinder = { findSolutions: async () => [] };
    provider.templateEngineCollection = { reset() {} };
    await provider.createSolutionItems();
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assertPreservedFocus(reveals, file);
});

test("an already selected file does not trigger another reveal", async () => {
    const { provider, file, reveals } = createProvider();
    provider.treeView.selection = [file];
    await provider.selectActiveDocument();
    assert.deepEqual(reveals, []);
});

test("the explicit focus command focuses the tree", () => {
    const { provider, file, reveals } = createProvider();
    provider.treeView.selection = [file];
    provider.focus();
    assert.deepEqual(reveals, [{ item: file, select: false, focus: true }]);
});
