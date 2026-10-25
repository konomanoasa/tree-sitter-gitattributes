import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { issues, leaves, owners } from "./support/cst.js";
import {
  applyEdits,
  assertIncrementalEqualsFresh,
  parse,
} from "./support/parser.js";

test("gitattributes: Git runtime checks the documented supplementary cases", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "git-syntax-reference-"));
  const run = (args, input = "") =>
    spawnSync("git", ["-c", "core.ignoreCase=false", ...args], {
      cwd: directory,
      input,
      encoding: "utf8",
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(directory, "absent-config"),
      },
    });
  try {
    const version = run(["--version"]);
    assert.equal(version.status, 0, version.stderr);
    t.diagnostic(
      `Supplementary behavior established with Git 2.55.0 (escaped-slash and whitespace boundaries: Git 2.56.0); checked with ${version.stdout.trim()}`,
    );
    assert.equal(run(["init", "--quiet"]).status, 0);
    const cases = [
      {
        source: "a audit_probe=x\vy\fz\v\f\n",
        attribute: "audit_probe",
        value: "x\vy\fz\v\f",
        invalidName: false,
      },
      {
        source: "a x\vy\fz audit_probe\n",
        attribute: "audit_probe",
        value: "unspecified",
        invalidName: true,
      },
      {
        source: "[attr]x\vy\fz audit_probe\na x\n",
        attribute: "audit_probe",
        value: "unspecified",
        invalidName: true,
      },
      {
        source: '"[attr]foo" audit_probe\n* foo\n',
        attribute: "audit_probe",
        value: "set",
        invalidName: false,
      },
      {
        source: String.raw`"\133attr]\146oo" audit_probe
* foo
`,
        attribute: "audit_probe",
        value: "set",
        invalidName: false,
      },
      {
        source: "* -name=value\n",
        attribute: "name",
        value: "unset",
        invalidName: false,
      },
      {
        source: "* !name=value\n",
        attribute: "name",
        value: "unspecified",
        invalidName: false,
      },
      {
        source: "* bad$name audit_probe\n",
        attribute: "audit_probe",
        value: "unspecified",
        invalidName: true,
      },
      {
        source: "* 日本 audit_probe\n",
        attribute: "audit_probe",
        value: "unspecified",
        invalidName: true,
      },
      {
        source: "* --name audit_probe\n",
        attribute: "audit_probe",
        value: "unspecified",
        invalidName: true,
      },
      {
        source: "* _name .name 1name foo-bar audit_probe\n",
        attribute: "audit_probe",
        value: "set",
        invalidName: false,
      },
    ];
    for (const { source, attribute, value, invalidName } of cases) {
      writeFileSync(join(directory, ".gitattributes"), source);
      const result = run(["check-attr", "-z", attribute, "--", "a"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `a\0${attribute}\0${value}\0`, source);
      if (invalidName)
        assert.match(result.stderr, /not a valid attribute name/);
    }
    const patterns = [
      {
        pattern: "a\vb\fc",
        paths: ["a\vb\fc", "a", "a\vb"],
        expected: ["a\vb\fc"],
      },
      {
        pattern: "\v#x\f",
        paths: ["\v#x\f", "#x\f", "\v#x", "#x"],
        expected: ["\v#x\f"],
      },
      {
        pattern: "x\\/**/b",
        paths: ["x/b", "x/y/b", "x/y/z/b"],
        expected: ["x/b", "x/y/b", "x/y/z/b"],
      },
      {
        pattern: "x/**\\/b",
        paths: ["x/b", "x/y/b", "x/y/z/b"],
        expected: ["x/y/b", "x/y/z/b"],
      },
      {
        pattern: "**\\/b",
        paths: ["b", "x/b", "x/y/b"],
        expected: ["x/b", "x/y/b"],
      },
      {
        pattern: "x\\/*/b",
        paths: ["x/b", "x/y/b", "x/y/z/b"],
        expected: ["x/y/b"],
      },
      {
        pattern: "x/*\\/b",
        paths: ["x/b", "x/y/b", "x/y/z/b"],
        expected: ["x/y/b"],
      },
      {
        pattern: '"x\\\\/**/b"',
        paths: ["x/b", "x/y/b", "x/y/z/b"],
        expected: ["x/b", "x/y/b", "x/y/z/b"],
      },
      {
        pattern: '"x/**\\\\/b"',
        paths: ["x/b", "x/y/b", "x/y/z/b"],
        expected: ["x/y/b", "x/y/z/b"],
      },
      {
        pattern: '"**\\\\/b"',
        paths: ["b", "x/b", "x/y/b"],
        expected: ["x/b", "x/y/b"],
      },
      {
        pattern: '"x\\134\\057\\052\\052\\134\\057b"',
        paths: ["x/b", "x/y/b", "x/y/z/b"],
        expected: ["x/y/b", "x/y/z/b"],
      },
      {
        pattern: String.raw`"[a\055[:alpha:]]"`,
        paths: ["a", "a]", "l]", "z]"],
        expected: ["a]", "l]"],
      },
      {
        pattern: "[a-[:digit:]]",
        paths: ["a", "1", "-", "a]", "d]", ":]", "1]"],
        expected: ["a]", "d]", ":]"],
      },
      {
        pattern: "[A-[:digit:]]",
        paths: ["A]", "Z]", "[]", "1"],
        expected: ["A]", "Z]", "[]"],
      },
      {
        pattern: "[]-[:digit:]]",
        paths: ["]]", "d]", "1"],
        expected: ["]]", "d]"],
      },
      {
        pattern: "[a-b-[:digit:]]",
        paths: ["a", "b", "-", "1", "d]"],
        expected: ["a", "b", "-", "1"],
      },
      {
        pattern: "[[:alpha:]A-[:digit:]]",
        paths: ["a]", "Z]", "1"],
        expected: ["a]", "Z]"],
      },
      {
        pattern: "[[:a-\\]-[:digit:]]",
        paths: ["1", "[", "a", "-", "1]", "d]"],
        expected: ["1", "[", "a", "-"],
      },
      {
        pattern: '"[A-\\133:digit:]]"',
        paths: ["A]", "Z]", "[]", "1"],
        expected: ["A]", "Z]", "[]"],
      },
      { pattern: "[[:]]", paths: ["a", "[]", ":]"], expected: ["[]", ":]"] },
      { pattern: "[[::]]", paths: ["a", "[]", ":]"], expected: [] },
      { pattern: "[a[::]]", paths: ["a", "[]", ":]"], expected: [] },
      { pattern: "[![::]]", paths: ["a", "[]", ":]"], expected: [] },
      { pattern: "[[:unknown:]]", paths: ["a", "[]", ":]"], expected: [] },
      { pattern: "[a[:unknown:]]", paths: ["a", "[]", ":]"], expected: [] },
      { pattern: "[![:unknown:]]", paths: ["a", "[]", ":]"], expected: [] },
      {
        pattern: String.raw`"[\133\072\072\135]"`,
        paths: ["a", "[]", ":]"],
        expected: [],
      },
      {
        pattern: "a/***/b",
        paths: ["a/b", "a/x/b", "a/x/y/b"],
        expected: ["a/b", "a/x/b", "a/x/y/b"],
      },
    ];
    for (const { pattern, paths, expected } of patterns) {
      writeFileSync(
        join(directory, ".gitattributes"),
        `${pattern} audit_probe\n`,
      );
      const result = run(
        ["check-attr", "-z", "--stdin", "audit_probe"],
        `${paths.join("\0")}\0`,
      );
      assert.equal(result.status, 0, result.stderr);
      const fields = result.stdout.split("\0");
      const fieldsPerAttribute = 3;
      const matched = [];
      for (
        let index = 0;
        index + fieldsPerAttribute <= fields.length;
        index += fieldsPerAttribute
      ) {
        const [path, , value] = fields.slice(index, index + fieldsPerAttribute);
        if (value === "set") matched.push(path);
      }
      assert.deepEqual(matched, expected, pattern);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("gitattributes: Git compares octal and literal UTF-8 patterns as bytes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "git-octal-reference-"));
  const run = (args, input = Buffer.alloc(0)) =>
    spawnSync("git", args, {
      cwd: directory,
      input,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(directory, "absent-config"),
      },
    });
  try {
    const version = run(["--version"]);
    assert.equal(version.status, 0, version.stderr.toString());
    t.diagnostic(
      `Supplementary behavior established with Git 2.56.0; checked with ${version.stdout.toString().trim()}`,
    );
    assert.equal(run(["init", "--quiet"]).status, 0);
    const paths = [
      Buffer.from("a"),
      Buffer.from("z"),
      Buffer.from("é"),
      Buffer.from([0xc3]),
      Buffer.from([0xa9]),
      Buffer.from([0xff]),
    ];
    for (const { patterns, expected } of [
      {
        patterns: ["[é]", String.raw`"[\303\251]"`],
        expected: [false, false, false, true, true, false],
      },
      {
        patterns: ["[é-z]", String.raw`"[\303\251-z]"`],
        expected: [false, false, false, true, true, false],
      },
      {
        patterns: ["[a-é]", String.raw`"[a-\303\251]"`],
        expected: [true, true, false, true, true, false],
      },
      {
        patterns: ["é", String.raw`"\303\251"`],
        expected: [false, false, true, false, false, false],
      },
      {
        patterns: [String.raw`"[\377]"`],
        expected: [false, false, false, false, false, true],
      },
    ]) {
      for (const pattern of patterns) {
        writeFileSync(
          join(directory, ".gitattributes"),
          `${pattern} audit_probe\n`,
        );
        const result = run(
          ["check-attr", "-z", "--stdin", "audit_probe"],
          Buffer.concat(paths.flatMap((path) => [path, Buffer.from([0])])),
        );
        assert.equal(result.status, 0, result.stderr.toString());
        assert.deepEqual(
          result.stdout,
          Buffer.concat(
            paths.flatMap((path, index) => [
              path,
              Buffer.from(
                `\0audit_probe\0${expected[index] ? "set" : "unspecified"}\0`,
              ),
            ]),
          ),
          pattern,
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const encodingCases = [
  [
    "consecutive decode failures after glob escape",
    Buffer.from([92, 255, 254, 128, 98]),
    [["invalid_syntax", "invalid_encoding", 1, 4]],
    ["pattern"],
  ],
  [
    "consecutive decode failures after C escape prefix",
    Buffer.from([34, 92, 255, 254, 128, 98, 34]),
    [["invalid_syntax", "invalid_encoding", 2, 5]],
    ["pattern"],
  ],
  [
    "consecutive decode failures stay inside the character set",
    Buffer.from([91, 97, 255, 254, 128, 93]),
    [["invalid_syntax", "invalid_encoding", 2, 5]],
    ["character_set"],
  ],
  [
    "consecutive decode failures after a glob escape and a C escape prefix",
    Buffer.from([34, 92, 92, 92, 255, 254, 128, 34]),
    [["invalid_syntax", "invalid_encoding", 4, 7]],
    ["pattern"],
  ],
  [
    "consecutive decode failures stop before a character class delimiter",
    Buffer.from([91, 91, 58, 100, 255, 254, 128, 58, 93, 93]),
    [["invalid_syntax", "invalid_encoding", 4, 7]],
    ["character_class"],
  ],
];
for (const [name, source, expected, expectedOwners] of encodingCases)
  test(`gitattributes: ${name}`, () => {
    const tree = parse(source);
    assert.deepEqual(issues(tree), expected);
    assert.deepEqual(owners(tree), expectedOwners);
    for (const node of tree.filter(({ kind }) => kind === "syntax_issue"))
      assert.equal(node.field, "issue");
  });

for (const { owner, prefix, before } of [
  { owner: "pattern", prefix: '"\\\\\\', before: [["quote_open", '"']] },
  {
    owner: "macro name",
    prefix: '"[attr]a\\',
    before: [
      ["quote_open", '"'],
      ["macro_marker", "[attr]"],
      ["name_text", "a"],
    ],
  },
]) {
  test(`gitattributes: backslashes before a decode failure in a ${owner} are held without an escape`, () => {
    const source = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([255, 254, 34]),
    ]);
    assert.deepEqual(leaves(source, parse(source)), [
      ...before,
      ["invalid_encoding", Buffer.from([255, 254]).toString()],
      ["quote_close", '"'],
    ]);
  });
}

const largeInputCounts = {
  unmatchedBrackets: 50_000,
  incompleteClassPrefixes: 16_000,
  characterSets: 10_000,
  unclosedClassPrefixes: 20_000,
  invalidEscapes: 10_000,
  octalWildcards: 10_000,
  incompleteQuotedLines: 5_000,
  mixedItemPrefixes: 80_000,
  incompleteSetPrefixes: 60_000,
};
const largeInputCases = [
  [
    "many unmatched open brackets",
    "[".repeat(largeInputCounts.unmatchedBrackets),
    1,
  ],
  [
    "many incomplete class prefixes",
    `${"[:".repeat(largeInputCounts.incompleteClassPrefixes)}]`,
    1,
  ],
  [
    "many complete character sets",
    "[a-z]".repeat(largeInputCounts.characterSets),
    0,
  ],
  [
    "many unmatched brackets before a class",
    `${"[".repeat(largeInputCounts.unmatchedBrackets)}[:x]`,
    0,
  ],
  [
    "many unclosed brackets holding classes",
    "[[:x:]".repeat(largeInputCounts.unclosedClassPrefixes),
    1,
  ],
  [
    "many independently invalid escapes",
    "a\\\n".repeat(largeInputCounts.invalidEscapes),
    largeInputCounts.invalidEscapes,
  ],
  [
    "many octal wildcards",
    `"${"\\052".repeat(largeInputCounts.octalWildcards)}" text`,
    0,
  ],
  [
    "many incomplete quoted lines",
    '"a\\12\n'.repeat(largeInputCounts.incompleteQuotedLines),
    2 * largeInputCounts.incompleteQuotedLines,
  ],
  [
    "many mixed named item prefixes",
    `${"[:[.[=".repeat(largeInputCounts.mixedItemPrefixes)}]`,
    0,
  ],
  [
    "many wildcards inside an incomplete set",
    "[[[[?".repeat(largeInputCounts.incompleteSetPrefixes),
    1,
  ],
];
for (const [name, source, expectedIssues] of largeInputCases)
  test(`gitattributes: large input: ${name}`, () => {
    assert.equal(issues(parse(source)).length, expectedIssues);
  });

for (const { name, source, suffix, before, after } of [
  {
    name: "LF completes the CR of a quoted macro name",
    source: '"[attr]a@$\r',
    suffix: "\n",
    before: [
      ["invalid_syntax", "invalid_name_character", 8, 10],
      ["incomplete_syntax", "invalid_name_character", 10, 11],
      ["incomplete_syntax", "missing_quote_close", 11, 11],
    ],
    after: [
      ["invalid_syntax", "invalid_name_character", 8, 10],
      ["invalid_syntax", "missing_quote_close", 10, 10],
    ],
  },
  {
    name: "a closing quote fixes the CR of a macro name as invalid",
    source: '"[attr]a$\r',
    suffix: '"',
    before: [
      ["invalid_syntax", "invalid_name_character", 8, 9],
      ["incomplete_syntax", "invalid_name_character", 9, 10],
      ["incomplete_syntax", "missing_quote_close", 10, 10],
    ],
    after: [["invalid_syntax", "invalid_name_character", 8, 10]],
  },
  {
    name: "LF ends a quoted escape without repairing it",
    source: '"a\\\r',
    suffix: "\n",
    before: [
      ["invalid_syntax", "invalid_quoted_escape", 2, 4],
      ["incomplete_syntax", "missing_quote_close", 4, 4],
    ],
    after: [
      ["invalid_syntax", "incomplete_quoted_escape", 2, 3],
      ["invalid_syntax", "missing_quote_close", 3, 3],
    ],
  },
]) {
  test(`gitattributes: ${name} and deleting it restores the EOF issues`, () => {
    const original = parse(source);
    assert.deepEqual(issues(original), before);
    const byte = Buffer.byteLength(source);
    const edits = [{ byte, deleteBytes: 0, insert: suffix }];
    const appended = parse(source, edits);
    assert.deepEqual(issues(appended), after);
    assert.deepEqual(appended, parse(source + suffix));
    edits.push({ byte, deleteBytes: Buffer.byteLength(suffix), insert: "" });
    const restored = parse(source, edits);
    assert.deepEqual(issues(restored), before);
    assert.deepEqual(restored, original);
  });
}

test("gitattributes: a normal name character splits and rejoins an invalid run", () => {
  const source = "* a@@b";
  const edits = [{ byte: 4, deleteBytes: 0, insert: "x" }];
  const split = parse(source, edits);
  assert.deepEqual(issues(split), [
    ["invalid_syntax", "invalid_name_character", 3, 4],
    ["invalid_syntax", "invalid_name_character", 5, 6],
  ]);
  assert.deepEqual(split, parse("* a@x@b"));
  edits.push({ byte: 4, deleteBytes: 1, insert: "" });
  const joined = parse(source, edits);
  assert.deepEqual(issues(joined), [
    ["invalid_syntax", "invalid_name_character", 3, 5],
  ]);
  assert.deepEqual(joined, parse(source));
});

const escapedSeparatorHistories = [
  {
    name: "change the escaped slash before double asterisk",
    source: "x\\/**/b",
    edits: [
      { byte: 2, deleteBytes: 1, insert: "a" },
      { byte: 2, deleteBytes: 1, insert: "/" },
      { byte: 1, deleteBytes: 1, insert: "" },
      { byte: 1, deleteBytes: 0, insert: "\\" },
    ],
    expected: [
      "wildcard",
      "recursive_wildcard",
      "recursive_wildcard",
      "recursive_wildcard",
    ],
  },
  {
    name: "change the escaped slash after double asterisk",
    source: "x/**b",
    edits: [
      { byte: 4, deleteBytes: 0, insert: "\\/" },
      { byte: 5, deleteBytes: 1, insert: "a" },
      { byte: 5, deleteBytes: 1, insert: "/" },
      { byte: 4, deleteBytes: 1, insert: "" },
    ],
    expected: [
      "recursive_wildcard",
      "wildcard",
      "recursive_wildcard",
      "recursive_wildcard",
    ],
  },
  {
    name: "change backslash parity before the following slash",
    source: "x/**\\/b",
    edits: [
      { byte: 4, deleteBytes: 0, insert: "\\" },
      { byte: 4, deleteBytes: 1, insert: "" },
    ],
    expected: ["wildcard", "recursive_wildcard"],
  },
  {
    name: "extend and restore the double asterisk run",
    source: "x\\/**\\/b",
    edits: [
      { byte: 3, deleteBytes: 0, insert: "*" },
      { byte: 3, deleteBytes: 1, insert: "" },
    ],
    expected: ["wildcard", "recursive_wildcard"],
  },
  {
    name: "change octal separators around encoded double asterisk",
    source: '"x\\134\\057\\052\\052\\134\\057b"',
    edits: [
      { byte: 23, deleteBytes: 3, insert: "141" },
      { byte: 23, deleteBytes: 3, insert: "057" },
      { byte: 7, deleteBytes: 3, insert: "141" },
      { byte: 7, deleteBytes: 3, insert: "057" },
    ],
    expected: [
      "wildcard",
      "recursive_wildcard",
      "wildcard",
      "recursive_wildcard",
    ],
  },
];
for (const { name, source, edits, expected } of escapedSeparatorHistories) {
  test(`gitattributes: ${name}`, () => {
    for (let length = 1; length <= edits.length; length++) {
      const history = edits.slice(0, length);
      const incremental = assertIncrementalEqualsFresh(
        source,
        history,
        applyEdits(source, history),
      );
      assert.deepEqual(issues(incremental), []);
      assert.deepEqual(
        incremental
          .filter(
            ({ kind }) => kind === "wildcard" || kind === "recursive_wildcard",
          )
          .map(({ kind }) => kind),
        [expected[length - 1]],
      );
    }
  });
}
