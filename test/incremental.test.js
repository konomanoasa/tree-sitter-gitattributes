import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEdits,
  assertEditHistory,
  assertEditMatchesContract,
  parse,
} from "./support/parser.js";

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
    name: "remove and restore a quoted macro closing quote",
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
    name: "replace a letter escape with encoded punctuation and restore it",
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
  {
    name: "turn CRLF into bare CR",
    source: "a\r\nb",
    edits: [{ byte: 2, deleteBytes: 1, insert: "" }],
  },
  {
    name: "split and join attribute rules",
    source: "a text b -diff",
    edits: [
      { byte: 6, deleteBytes: 1, insert: "\n" },
      { byte: 6, deleteBytes: 1, insert: " " },
    ],
  },
];
for (const entry of editCases) {
  test(`gitattributes: ${entry.name}`, () => {
    assertEditHistory(entry);
  });
}

test("gitattributes: replacing and restoring an octal byte preserves incremental parsing", () => {
  const source = String.raw`"[\303\251-z]"`;
  const original = parse(source);
  const edits = [{ byte: 3, deleteBytes: 3, insert: "377" }];
  assert.deepEqual(parse(source, edits), parse(String.raw`"[\377\251-z]"`));
  edits.push({ byte: 3, deleteBytes: 3, insert: "303" });
  assert.deepEqual(parse(source, edits), original);
});

test("gitattributes: fixed-seed generated histories preserve full fresh determinism and normal source equivalence", () => {
  const seed = 0x731dac9;
  const historyCount = 120;
  const editsPerHistory = 4;
  const maxDeletedBytes = 3;
  const lcgMultiplier = 1_664_525;
  const lcgIncrement = 1_013_904_223;
  let state = seed;
  const next = (maximum) => {
    state = (Math.imul(state, lcgMultiplier) + lcgIncrement) >>> 0;
    return state % maximum;
  };
  const alphabet = 'ab []!:.*?\\/\n\r\t-^=é"0127';
  const seeds = [
    "",
    "# comment\n**/a text !diff\n",
    "[a-z] text=auto \r\n",
    "[[:alpha:]]",
    "foo\\",
    '[attr]binary -diff -text\n"a\\12',
    String.raw`"\133attr]\146oo" text`,
    String.raw`"[[:a\q:]]" text`,
  ];
  for (let sample = 0; sample < historyCount; sample++) {
    const source = seeds[sample % seeds.length];
    let bytes = Buffer.from(source);
    const edits = [];
    for (let step = 0; step < editsPerHistory; step++) {
      const byte = next(bytes.length + 1);
      const edit = {
        byte,
        deleteBytes: Math.min(next(maxDeletedBytes + 1), bytes.length - byte),
        insert: alphabet[next(alphabet.length)],
      };
      edits.push(edit);
      bytes = applyEdits(bytes, [edit]);
      assertEditMatchesContract(source, edits, bytes);
    }
  }
});
