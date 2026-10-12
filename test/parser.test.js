import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { issues } from "./support/cst.js";
import {
  applyEdits,
  assertEditHistory,
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

const largeInputCounts = {
  lines: 10_000,
  literalCharacters: 200_000,
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
    "many independent lines",
    "**/node_modules/ -text\n".repeat(largeInputCounts.lines),
    0,
  ],
  ["one long literal", "a".repeat(largeInputCounts.literalCharacters), 0],
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

test("gitattributes: replacing and restoring an octal byte preserves incremental parsing", () => {
  const source = String.raw`"[\303\251-z]"`;
  const original = parse(source);
  const edits = [{ byte: 3, deleteBytes: 3, insert: "377" }];
  assert.deepEqual(parse(source, edits), parse(String.raw`"[\377\251-z]"`));
  edits.push({ byte: 3, deleteBytes: 3, insert: "303" });
  assert.deepEqual(parse(source, edits), original);
});

const editCases = [
  {
    name: "empty an encoded class name",
    source: String.raw`"[\133:digit:\135]"`,
    edits: [{ byte: 7, deleteBytes: 5, insert: "" }],
  },
  {
    name: "fill an empty encoded class name",
    source: String.raw`"[\133::\135]"`,
    edits: [{ byte: 7, deleteBytes: 0, insert: "digit" }],
  },
  {
    name: "change an encoded class into a range upper bracket",
    source: '"[A\\133:digit:]]" text',
    edits: [{ byte: 3, deleteBytes: 0, insert: "-" }],
  },
  {
    name: "restore an encoded class from a range upper bracket",
    source: '"[A-\\133:digit:]]" text',
    edits: [{ byte: 3, deleteBytes: 1, insert: "" }],
  },
  {
    name: "turn a quoted pattern into an encoded macro definition",
    source: String.raw`"\133attr)\146oo" text`,
    edits: [{ byte: 9, deleteBytes: 1, insert: "]" }],
  },
  {
    name: "remove a quoted macro closing quote and retain its name owner",
    source: '"[attr]foo" text',
    edits: [{ byte: 10, deleteBytes: 1, insert: "" }],
  },
  {
    name: "replace class delimiters with ordinary equal signs",
    source: "[[:digit:]]",
    edits: [
      { byte: 2, deleteBytes: 1, insert: "=" },
      { byte: 8, deleteBytes: 1, insert: "=" },
    ],
  },
  {
    name: "delete and restore a bracket inside a set",
    source: "[[.a.]-[.z.]]",
    edits: [
      { byte: 7, deleteBytes: 1, insert: "" },
      { byte: 7, deleteBytes: 0, insert: "[" },
    ],
  },
  {
    name: "replace an octal delimiter with its literal spelling",
    source: String.raw`"[\133\056a\056\135]"`,
    edits: [
      { byte: 6, deleteBytes: 4, insert: "." },
      { byte: 8, deleteBytes: 4, insert: "." },
    ],
  },
  {
    name: "complete an escape",
    source: "a\\",
    edits: [{ byte: 2, deleteBytes: 0, insert: "*" }],
  },
  {
    name: "end an incomplete escape line",
    source: "a\\",
    edits: [{ byte: 2, deleteBytes: 0, insert: "\nnext" }],
  },
  {
    name: "complete an unclosed character set",
    source: "[abc",
    edits: [{ byte: 4, deleteBytes: 0, insert: "]" }],
  },
  {
    name: "reopen a set",
    source: "[abc]",
    edits: [{ byte: 4, deleteBytes: 1, insert: "" }],
  },
  {
    name: "change a comment to a pattern",
    source: "# abc",
    edits: [{ byte: 0, deleteBytes: 1, insert: "!" }],
  },
  {
    name: "insert negation before a recursive wildcard",
    source: "**/a",
    edits: [{ byte: 0, deleteBytes: 0, insert: "!" }],
  },
  {
    name: "change an asterisk context",
    source: "a**/",
    edits: [{ byte: 0, deleteBytes: 1, insert: "" }],
  },
  {
    name: "turn a range into literal text",
    source: "[a-z]",
    edits: [{ byte: 2, deleteBytes: 1, insert: "" }],
  },
  {
    name: "turn class into set text",
    source: '"[[:alpha:]]" text',
    edits: [{ byte: 2, deleteBytes: 1, insert: "" }],
  },
  {
    name: "split and merge decode failures inside a quoted macro name",
    source: Buffer.concat([
      Buffer.from('"[attr]a'),
      Buffer.from([255, 254, 128]),
      Buffer.from('b" text'),
    ]),
    edits: [
      { byte: 9, deleteBytes: 0, insert: "x" },
      { byte: 9, deleteBytes: 1, insert: "" },
    ],
  },
  {
    name: "change a valid name escape to an invalid name character and back",
    source: String.raw`"[attr]a\141b" text`,
    edits: [
      { byte: 9, deleteBytes: 3, insert: "044" },
      { byte: 9, deleteBytes: 3, insert: "141" },
    ],
  },
  {
    name: "replace pattern separators with VT and FF and restore them",
    source: "a b text",
    edits: [
      { byte: 1, deleteBytes: 1, insert: "\v" },
      { byte: 1, deleteBytes: 1, insert: "\f" },
      { byte: 1, deleteBytes: 1, insert: " " },
    ],
  },
  {
    name: "replace attribute separators with VT and FF and restore them",
    source: "a value=x other",
    edits: [
      { byte: 9, deleteBytes: 1, insert: "\v" },
      { byte: 9, deleteBytes: 1, insert: "\f" },
      { byte: 9, deleteBytes: 1, insert: " " },
    ],
  },
  {
    name: "replace comment indentation with VT and FF and restore it",
    source: " #note",
    edits: [
      { byte: 0, deleteBytes: 1, insert: "\v" },
      { byte: 0, deleteBytes: 1, insert: "\f" },
      { byte: 0, deleteBytes: 1, insert: " " },
    ],
  },
  {
    name: "make trailing spaces significant",
    source: "a  ",
    edits: [{ byte: 3, deleteBytes: 0, insert: "b" }],
  },
  {
    name: "close quotation and expose attributes",
    source: '"a b text',
    edits: [{ byte: 4, deleteBytes: 0, insert: '"' }],
  },
  {
    name: "reopen quotation and absorb attributes",
    source: '"a b" text',
    edits: [{ byte: 4, deleteBytes: 1, insert: "" }],
  },
  {
    name: "complete octal and closing quote",
    source: String.raw`"\12`,
    edits: [{ byte: 4, deleteBytes: 0, insert: '3" text' }],
  },
  {
    name: "turn octal literal into wildcard",
    source: String.raw`"\141" text`,
    edits: [{ byte: 2, deleteBytes: 3, insert: "052" }],
  },
  {
    name: "complete macro marker",
    source: "[attr name -text",
    edits: [{ byte: 5, deleteBytes: 0, insert: "]" }],
  },
  {
    name: "fill an empty attribute name",
    source: "a -",
    edits: [{ byte: 3, deleteBytes: 0, insert: "text" }],
  },
  {
    name: "remove attribute modifier before assignment",
    source: "a -text=auto",
    edits: [{ byte: 2, deleteBytes: 1, insert: "" }],
  },
  {
    name: "preserve a quoted bracket after earlier lookahead",
    source: String.raw`"[\133"`,
    edits: [{ byte: 6, deleteBytes: 0, insert: "]" }],
  },
];
for (const entry of editCases) {
  test(`gitattributes: ${entry.name}`, () => {
    assertEditHistory(entry);
  });
}

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
