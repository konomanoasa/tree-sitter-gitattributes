import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { root } from "../scripts/tree-sitter.js";
import nodeTypes from "../src/node-types.json" with { type: "json" };
import { hasError, leaves, parseCst } from "./support/cst.js";
import { parse } from "./support/parser.js";

function parseCorpus(text) {
  const sections = text.split("==================\n");
  assert.equal(sections.shift(), "", "corpus must begin with a header");
  assert.equal(sections.length % 2, 0, "corpus headers must be paired");
  const cases = [];
  for (let index = 0; index < sections.length; index += 2) {
    const [name, ...attributes] = sections[index].trimEnd().split("\n");
    assert.ok(name, "corpus case must have a name");
    for (const attribute of attributes) {
      assert.ok(
        attribute === ":cst" || attribute === ":error",
        `unsupported corpus attribute: ${attribute}`,
      );
    }
    const parts = sections[index + 1].split("\n---\n");
    assert.equal(parts.length, 2, `${name}: expected one output separator`);
    const source = parts[0].endsWith("\r") ? parts[0].slice(0, -1) : parts[0];
    cases.push({ name, source });
  }
  return cases;
}

const corpusDirectory = join(root, "test/corpus");
for (const file of readdirSync(corpusDirectory).sort()) {
  assert.ok(file.endsWith(".txt"), `unexpected corpus entry: ${file}`);
  const entries = parseCorpus(
    readFileSync(join(corpusDirectory, file), "utf8"),
  );
  for (const { name, source } of entries) {
    test(`gitattributes: corpus normal source coverage and full fresh determinism: ${file}: ${name}`, () => {
      const tree = parse(source);
      if (!hasError(tree)) {
        const bytes = Buffer.from(source);
        const parents = new Set(tree.map(({ parent }) => parent));
        const terminal = tree.filter((_, index) => !parents.has(index));
        let end = source.startsWith("\uFEFF") ? 3 : 0;
        for (const node of terminal) {
          assert.ok(node.start >= end);
          assert.match(
            bytes.subarray(end, node.start).toString(),
            /^[ \t\r]*$/,
          );
          end = node.end;
        }
        assert.match(bytes.subarray(end).toString(), /^[ \t\r]*$/);
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

test("gitattributes: public metadata requires normal structure without diagnostic nodes", () => {
  for (const node of nodeTypes) {
    assert.ok(!/issue|invalid|incomplete|missing/.test(node.type), node.type);
    assert.ok(!node.fields || !("issue" in node.fields), node.type);
  }
  for (const [kind, fields] of Object.entries({
    attribute_rule: ["pattern"],
    macro_definition: ["marker", "name"],
    attribute: ["name"],
    character_set: ["opening", "closing"],
    character_range: ["lower", "upper"],
  })) {
    const node = nodeTypes.find(({ type }) => type === kind);
    assert.ok(node?.fields, kind);
    for (const field of fields)
      assert.equal(node.fields[field].required, true, `${kind}.${field}`);
  }
});

test("gitattributes: compound delimiters are anonymous and have no opening or closing fields", () => {
  for (const type of ["[", "]", ":"]) {
    assert.equal(nodeTypes.find((node) => node.type === type)?.named, false);
  }
  const node = nodeTypes.find(({ type }) => type === "character_class");
  assert.ok(node);
  assert.ok(node.fields);
  assert.deepEqual(Object.keys(node.fields), ["name"]);
});

for (const [context, prefix, suffix] of [
  ["pattern", "a", "b"],
  ["comment", "#a", "b"],
  ["attribute name", "a n", "m"],
  ["value", "a n=v", "x"],
  ["glob escape", "\\", "b"],
  ["C escape prefix", '"\\', 'b"'],
  ["character set", "[a", "]"],
  ["decoded glob escape", '"\\\\\\', '"'],
  ["class name", "[[:d", ":]]"],
  ["quoted macro escape", '"[attr]a\\', '"'],
]) {
  test(`gitattributes: invalid UTF-8 in ${context} is rejected deterministically`, () => {
    const source = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([255, 254, 128]),
      Buffer.from(suffix),
    ]);
    const tree = parse(source);
    assert.ok(hasError(tree));
    assert.deepEqual(parse(source), tree);
  });
}

const largeInputCounts = {
  lines: 10_000,
  literalCharacters: 200_000,
};
const largeInputCases = [
  [
    "many independent lines",
    "**/node_modules/ -text\n".repeat(largeInputCounts.lines),
    false,
  ],
  ["one long literal", "a".repeat(largeInputCounts.literalCharacters), false],
];
for (const [name, source, expectedError] of largeInputCases)
  test(`gitattributes: large input: ${name}`, () => {
    assert.equal(hasError(parse(source)), expectedError);
  });

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

test("gitattributes: CST helpers reject absent and truncated roots", () => {
  assert.throws(() => parseCst("", "x"));
  assert.throws(() => parseCst("0:0 - 0:1   document", "é"));
});

test("gitattributes: CST helpers preserve root errors and missing leaves", () => {
  assert.deepEqual(parseCst("0:0 - 0:1   ERROR", "x"), [
    { kind: "ERROR", field: null, start: 0, end: 1, parent: null },
  ]);
  assert.ok(
    hasError(
      parseCst("0:0 - 0:1   document\n0:1 - 0:1     • quote_close", "x"),
    ),
  );
});
