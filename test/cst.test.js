import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { root } from "../scripts/tree-sitter.js";
import nodeTypes from "../src/node-types.json" with { type: "json" };
import { parseCorpus } from "./support/corpus.js";
import { issues, leaves, owners, parseCst } from "./support/cst.js";
import {
  applyEdits,
  assertEditHistory,
  assertIncrementalEqualsFresh,
  parse,
} from "./support/parser.js";

const corpusDirectory = join(root, "test/corpus");
for (const file of readdirSync(corpusDirectory).sort()) {
  assert.ok(file.endsWith(".txt"), `unexpected corpus entry: ${file}`);
  const entries = parseCorpus(
    readFileSync(join(corpusDirectory, file), "utf8"),
  );
  for (const { name, source } of entries) {
    test(`gitattributes: corpus source coverage issue structure and fresh determinism: ${file}: ${name}`, () => {
      const tree = parse(source);
      issues(tree);
      for (const node of tree.filter(({ kind }) => kind === "syntax_issue")) {
        assert.equal(node.field, "issue");
      }
      assert.deepEqual(parse(source), tree);
    });
  }
}

test("gitattributes: corpus inputs retain BOM NUL whitespace and line endings", () => {
  const text = [
    "==================\nEmpty\n==================\n\n---\n(document)\n\n",
    "==================\nLayout\n:cst\n==================\n",
    "\uFEFF \t\v\f\r\na text\n\n\n---\nignored output\n\n",
    "==================\nNUL\n:cst\n==================\n",
    "\0=\0\n---\nignored output\n\n",
    "==================\nFinal CR\n:cst\n==================\n",
    "a text\r\r\n---\nignored output\n",
  ].join("");
  assert.deepEqual(parseCorpus(text), [
    { name: "Empty", source: "" },
    { name: "Layout", source: "\uFEFF \t\v\f\r\na text\n\n" },
    { name: "NUL", source: "\0=\0" },
    { name: "Final CR", source: "a text\r" },
  ]);
});

test("gitattributes: corpus input reader rejects unsupported conditions and framing", () => {
  for (const text of [
    "not a corpus file",
    "==================\nUnclosed header\n",
    "==================\nSkipped\n:skip\n==================\na text\n---\n",
    "==================\nNo separator\n==================\na text\n",
  ]) {
    assert.throws(() => parseCorpus(text), { code: "ERR_ASSERTION" }, text);
  }
});

test("gitattributes: public issue nodes have one outcome and one reason", () => {
  const issue = nodeTypes.find(({ type }) => type === "syntax_issue");
  assert.ok(issue);
  assert.ok(issue.children);
  assert.equal(issue.children.required, true);
  assert.equal(issue.children.multiple, false);
  assert.deepEqual(
    issue.children.types.map(({ type }) => type),
    ["incomplete_syntax", "invalid_syntax"],
  );
  for (const { type } of issue.children.types) {
    const outcome = nodeTypes.find((node) => node.type === type);
    assert.ok(outcome, type);
    assert.ok(outcome.children, type);
    assert.equal(outcome.children.required, true);
    assert.equal(outcome.children.multiple, false);
    for (const child of outcome.children.types) {
      const reason = nodeTypes.find((node) => node.type === child.type);
      assert.ok(reason, child.type);
      if (child.type === "invalid_name_character") {
        assert.ok(reason.children);
        assert.equal(reason.children.multiple, false);
        assert.deepEqual(reason.children.types, [
          { type: "quoted_escape", named: true },
        ]);
      } else {
        assert.equal(reason.children, undefined);
      }
    }
  }
});

test("gitattributes: compound delimiters are anonymous and have no opening or closing fields", () => {
  for (const type of ["[", "]", ":"]) {
    assert.equal(nodeTypes.find((node) => node.type === type)?.named, false);
  }
  const node = nodeTypes.find(({ type }) => type === "character_class");
  assert.ok(node);
  assert.ok(node.fields);
  assert.deepEqual(Object.keys(node.fields), ["issue", "name"]);
});

const encodingCases = [
  [
    "consecutive decode failures within pattern",
    Buffer.from([97, 255, 254, 128, 98]),
    [["invalid_syntax", "invalid_encoding", 1, 4]],
    ["pattern"],
  ],
  [
    "consecutive decode failures within comment",
    Buffer.from([35, 255, 254, 128, 98]),
    [["invalid_syntax", "invalid_encoding", 1, 4]],
    ["comment"],
  ],
  [
    "consecutive decode failures within name",
    Buffer.from([97, 32, 110, 255, 254, 128, 109]),
    [["invalid_syntax", "invalid_encoding", 3, 6]],
    ["attribute_name"],
  ],
  [
    "consecutive decode failures within value",
    Buffer.from([97, 32, 110, 61, 118, 255, 254, 128, 120]),
    [["invalid_syntax", "invalid_encoding", 5, 8]],
    ["attribute_value"],
  ],
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

for (const [owner, prefix, suffix] of [
  ["pattern", "a", "b text"],
  ["name", "a na", "me"],
  ["value", "a key=", "x"],
  ["comment", "# a", "b"],
  ["class", "[[:di", ":]] text"],
]) {
  for (const bom of ["", "\uFEFF"]) {
    test(`gitattributes: splitting the character after a decoding failure merges the issue in ${owner}${bom && " after a BOM"}`, () => {
      const offset = Buffer.byteLength(bom + prefix);
      const source = Buffer.concat([
        Buffer.from(bom + prefix),
        Buffer.from([255]),
        Buffer.from(`é${suffix}`),
      ]);
      const edits = [{ byte: offset + 2, deleteBytes: 1, insert: "" }];
      const incremental = assertIncrementalEqualsFresh(
        source,
        edits,
        applyEdits(source, edits),
      );
      assert.deepEqual(
        incremental
          .filter(({ kind }) => kind === "syntax_issue")
          .map(({ start, end }) => [start, end]),
        [[offset, offset + 2]],
      );
    });
  }
}

const editCases = [
  {
    name: "split a UTF-8 character",
    source: "éx",
    edits: [{ byte: 1, deleteBytes: 1, insert: "" }],
  },
  {
    name: "repair a decode failure",
    source: Buffer.from([97, 255, 98]),
    edits: [{ byte: 1, deleteBytes: 1, insert: "é" }],
  },
  {
    name: "insert BOM at the start",
    source: "a\n",
    edits: [{ byte: 0, deleteBytes: 0, insert: "\uFEFF" }],
  },
  {
    name: "remove a leading BOM",
    source: "\uFEFFa",
    edits: [{ byte: 0, deleteBytes: 3, insert: "" }],
  },
];
for (const entry of editCases) {
  test(`gitattributes: ${entry.name}`, () => {
    assertEditHistory(entry);
  });
}

test("gitattributes: CST helpers preserve fields, anonymous nodes and UTF-8 ranges across CRLF", () => {
  const source = "é0123456789\r\n[[:x:]] a=b";
  const text = [
    "0:0  - 1:11   document",
    "0:0  - 1:0      attribute_rule",
    "0:0  - 0:12       pattern: pattern",
    "0:0  - 0:12         glob_literal `é0123456789`",
    "0:12 - 1:0        line_ending",
    "0:12 - 0:14         `\\r\\n`",
    "1:0  - 1:11     attribute_rule",
    "1:0  - 1:7        pattern: pattern",
    "1:0  - 1:7          character_set",
    "1:0  - 1:1            opening: set_open `[`",
    "1:1  - 1:6            character_class",
    '1:1  - 1:2              "["',
    '1:2  - 1:3              ":"',
    "1:3  - 1:4              name: class_name `x`",
    '1:4  - 1:5              ":"',
    '1:5  - 1:6              "]"',
    "1:6  - 1:7            closing: set_close `]`",
    "1:8  - 1:11       attribute",
    "1:8  - 1:9          name: attribute_name",
    "1:8  - 1:9            name_text `a`",
    "1:9  - 1:10         operator: assignment_operator `=`",
    "1:10 - 1:11         value: attribute_value",
    "1:10 - 1:11           value_text `b`",
  ].join("\n");
  const nodes = parseCst(text, source);
  assert.deepEqual(nodes, [
    { kind: "document", field: null, start: 0, end: 25, parent: null },
    { kind: "attribute_rule", field: null, start: 0, end: 14, parent: 0 },
    { kind: "pattern", field: "pattern", start: 0, end: 12, parent: 1 },
    { kind: "glob_literal", field: null, start: 0, end: 12, parent: 2 },
    { kind: "line_ending", field: null, start: 12, end: 14, parent: 1 },
    { kind: "attribute_rule", field: null, start: 14, end: 25, parent: 0 },
    { kind: "pattern", field: "pattern", start: 14, end: 21, parent: 5 },
    { kind: "character_set", field: null, start: 14, end: 21, parent: 6 },
    { kind: "set_open", field: "opening", start: 14, end: 15, parent: 7 },
    { kind: "character_class", field: null, start: 15, end: 20, parent: 7 },
    { kind: "[", field: null, start: 15, end: 16, parent: 9 },
    { kind: ":", field: null, start: 16, end: 17, parent: 9 },
    { kind: "class_name", field: "name", start: 17, end: 18, parent: 9 },
    { kind: ":", field: null, start: 18, end: 19, parent: 9 },
    { kind: "]", field: null, start: 19, end: 20, parent: 9 },
    { kind: "set_close", field: "closing", start: 20, end: 21, parent: 7 },
    { kind: "attribute", field: null, start: 22, end: 25, parent: 5 },
    { kind: "attribute_name", field: "name", start: 22, end: 23, parent: 16 },
    { kind: "name_text", field: null, start: 22, end: 23, parent: 17 },
    {
      kind: "assignment_operator",
      field: "operator",
      start: 23,
      end: 24,
      parent: 16,
    },
    { kind: "attribute_value", field: "value", start: 24, end: 25, parent: 16 },
    { kind: "value_text", field: null, start: 24, end: 25, parent: 20 },
  ]);
  assert.deepEqual(leaves(source, nodes), [
    ["glob_literal", "é0123456789"],
    ["line_ending", "\r\n"],
    ["set_open", "["],
    ["[", "["],
    [":", ":"],
    ["class_name", "x"],
    [":", ":"],
    ["]", "]"],
    ["set_close", "]"],
    ["name_text", "a"],
    ["assignment_operator", "="],
    ["value_text", "b"],
  ]);
});

test("gitattributes: CST helpers reject truncated roots and native recovery nodes", () => {
  assert.throws(() => parseCst("0:0 - 0:1   document", "é"));
  for (const kind of ["ERROR", "MISSING"]) {
    const text = `0:0 - 0:1   document\n0:0 - 0:1     ${kind}`;
    assert.throws(() => parseCst(text, "a"));
  }
});
