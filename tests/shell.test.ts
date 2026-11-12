declare const require: (name: string) => any;

const assert = require("assert/strict");
const test = require("node:test");
import { defaultTerminalCommands } from "../src/extensions/defaultTerminalCommands";
import { buildCustomCommandArguments } from "../src/extensions/customCommandBuilder";
import { escapeTemplateValue, quoteForShell, validateTerminalValue } from "../src/extensions/shell";

test("escapeTemplateValue on Windows does not add extra quotes and doubles internal quotes", () => {
    const input = 'C:\\path\\to\\My "Quoted" Solution.sln';
    const escaped = escapeTemplateValue(input, "win32");

    assert.equal(escaped, 'C:\\path\\to\\My ""Quoted"" Solution.sln');
});

test("escapeTemplateValue on Linux escapes shell-sensitive characters in quoted templates", () => {
    const input = "line\\path\"$`\nnext\u0000";
    const escaped = escapeTemplateValue(input, "linux");

    assert.equal(escaped, "line\\\\path\\\"\\$\\`next");
});

test("escapeTemplateValue on macOS escapes shell-sensitive characters in quoted templates", () => {
    const input = "folder\\name\"$`\r\nvalue\u0000";
    const escaped = escapeTemplateValue(input, "darwin");

    assert.equal(escaped, "folder\\\\name\\\"\\$\\`value");
});

test("quoteForShell on Windows wraps with quotes and escapes internal quotes", () => {
    const input = 'C:\\temp\\a "b".sln';
    const quoted = quoteForShell(input, "win32");

    assert.equal(quoted, '"C:\\temp\\a ""b"".sln"');
});

test("quoteForShell on Linux uses single-quote escaping", () => {
    const input = "/tmp/it's-here";
    const quoted = quoteForShell(input, "linux");

    assert.equal(quoted, "'/tmp/it'\\''s-here'");
});

test("quoteForShell on macOS uses single-quote escaping", () => {
    const input = "/Users/test/O'Brien";
    const quoted = quoteForShell(input, "darwin");

    assert.equal(quoted, "'/Users/test/O'\\''Brien'");
});

test("validateTerminalValue accepts normal path and argument values", () => {
    assert.doesNotThrow(() => validateTerminalValue("C:\\path\\ok.sln", "path"));
    assert.doesNotThrow(() => validateTerminalValue("--project", "argument"));
});

test("validateTerminalValue rejects control character injection", () => {
    assert.throws(() => validateTerminalValue("abc\nxyz", "argument"), /Unsafe terminal argument/);
    assert.throws(() => validateTerminalValue("abc\rxyz", "path"), /Unsafe terminal path/);
    assert.throws(() => validateTerminalValue("abc\u0000xyz", "path"), /Unsafe terminal path/);
});

test("clean custom command generation is compatible on Windows", () => {
    const args = buildCustomCommandArguments(
        defaultTerminalCommands.clean,
        { projectPath: 'C:\\repo\\My "Great" App\\MySolution.sln' },
        "win32"
    );

    assert.deepEqual(args, [
        "dotnet",
        "clean",
        '"C:\\repo\\My ""Great"" App\\MySolution.sln"'
    ]);
});

test("clean custom command generation is compatible on Linux", () => {
    const args = buildCustomCommandArguments(
        defaultTerminalCommands.clean,
        { projectPath: '/repo/My "Great" App/MySolution.sln' },
        "linux"
    );

    assert.deepEqual(args, [
        "dotnet",
        "clean",
        '"/repo/My \\\"Great\\\" App/MySolution.sln"'
    ]);
});

test("clean custom command generation is compatible on macOS", () => {
    const args = buildCustomCommandArguments(
        defaultTerminalCommands.clean,
        { projectPath: '/Users/me/My "Great" App/MySolution.sln' },
        "darwin"
    );

    assert.deepEqual(args, [
        "dotnet",
        "clean",
        '"/Users/me/My \\\"Great\\\" App/MySolution.sln"'
    ]);
});

test("clean custom command generation strips control characters from path value", () => {
    const args = buildCustomCommandArguments(
        defaultTerminalCommands.clean,
        { projectPath: '/repo/MySolution.sln\nrm -rf /\u0000' },
        "linux"
    );

    assert.equal(args[2], '"/repo/MySolution.slnrm -rf /"');
});
