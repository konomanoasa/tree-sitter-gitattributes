import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, parse } from "./support/parser.js";

const histories = [
  [
    "empty an encoded class name",
    String.raw`"[\133:digit:\135]"`,
    [{ byte: 7, deleteBytes: 5, insert: "" }],
  ],
  [
    "fill an empty encoded class name",
    String.raw`"[\133::\135]"`,
    [{ byte: 7, deleteBytes: 0, insert: "digit" }],
  ],
  [
    "change an encoded class into a range upper bracket",
    '"[A\\133:digit:]]" text',
    [{ byte: 3, deleteBytes: 0, insert: "-" }],
  ],
  [
    "restore an encoded class from a range upper bracket",
    '"[A-\\133:digit:]]" text',
    [{ byte: 3, deleteBytes: 1, insert: "" }],
  ],
  [
    "turn a quoted pattern into an encoded macro definition",
    String.raw`"\133attr)\146oo" text`,
    [{ byte: 9, deleteBytes: 1, insert: "]" }],
  ],
  [
    "remove a quoted macro closing quote and retain its name owner",
    '"[attr]foo" text',
    [{ byte: 10, deleteBytes: 1, insert: "" }],
  ],
  [
    "replace class delimiters with ordinary equal signs",
    "[[:digit:]]",
    [
      { byte: 2, deleteBytes: 1, insert: "=" },
      { byte: 8, deleteBytes: 1, insert: "=" },
    ],
  ],
  [
    "delete and restore a bracket inside a set",
    "[[.a.]-[.z.]]",
    [
      { byte: 7, deleteBytes: 1, insert: "" },
      { byte: 7, deleteBytes: 0, insert: "[" },
    ],
  ],
  [
    "replace an octal delimiter with its literal spelling",
    String.raw`"[\133\056a\056\135]"`,
    [
      { byte: 6, deleteBytes: 4, insert: "." },
      { byte: 8, deleteBytes: 4, insert: "." },
    ],
  ],
  ["complete an escape", "a\\", [{ byte: 2, deleteBytes: 0, insert: "*" }]],
  [
    "end an incomplete escape line",
    "a\\",
    [{ byte: 2, deleteBytes: 0, insert: "\nnext" }],
  ],
  [
    "complete an unclosed character set",
    "[abc",
    [{ byte: 4, deleteBytes: 0, insert: "]" }],
  ],
  ["reopen a set", "[abc]", [{ byte: 4, deleteBytes: 1, insert: "" }]],
  [
    "change a comment to a pattern",
    "# abc",
    [{ byte: 0, deleteBytes: 1, insert: "!" }],
  ],
  [
    "insert negation before a recursive wildcard",
    "**/a",
    [{ byte: 0, deleteBytes: 0, insert: "!" }],
  ],
  [
    "change an asterisk context",
    "a**/",
    [{ byte: 0, deleteBytes: 1, insert: "" }],
  ],
  [
    "turn a range into literal text",
    "[a-z]",
    [{ byte: 2, deleteBytes: 1, insert: "" }],
  ],
  [
    "turn class into set text",
    '"[[:alpha:]]" text',
    [{ byte: 2, deleteBytes: 1, insert: "" }],
  ],
  ["split a UTF-8 character", "éx", [{ byte: 1, deleteBytes: 1, insert: "" }]],
  [
    "repair a decode failure",
    Buffer.from([97, 255, 98]),
    [{ byte: 1, deleteBytes: 1, insert: "é" }],
  ],
  [
    "turn CRLF into bare CR",
    "a\r\nb",
    [{ byte: 2, deleteBytes: 1, insert: "" }],
  ],
  [
    "insert BOM at the start",
    "a\n",
    [{ byte: 0, deleteBytes: 0, insert: "\uFEFF" }],
  ],
  [
    "remove a leading BOM",
    "\uFEFFa",
    [{ byte: 0, deleteBytes: 3, insert: "" }],
  ],
  [
    "make trailing spaces significant",
    "a  ",
    [{ byte: 3, deleteBytes: 0, insert: "b" }],
  ],
];
histories.push(
  [
    "close quotation and expose attributes",
    '"a b text',
    [{ byte: 4, deleteBytes: 0, insert: '"' }],
  ],
  [
    "reopen quotation and absorb attributes",
    '"a b" text',
    [{ byte: 4, deleteBytes: 1, insert: "" }],
  ],
  [
    "complete octal and closing quote",
    String.raw`"\12`,
    [{ byte: 4, deleteBytes: 0, insert: '3" text' }],
  ],
  [
    "turn octal literal into wildcard",
    String.raw`"\141" text`,
    [{ byte: 2, deleteBytes: 3, insert: "052" }],
  ],
  [
    "complete macro marker",
    "[attr name -text",
    [{ byte: 5, deleteBytes: 0, insert: "]" }],
  ],
  [
    "fill an empty attribute name",
    "a -",
    [{ byte: 3, deleteBytes: 0, insert: "text" }],
  ],
  [
    "remove attribute modifier before assignment",
    "a -text=auto",
    [{ byte: 2, deleteBytes: 1, insert: "" }],
  ],
  [
    "split and join attribute rules",
    "a text b -diff",
    [
      { byte: 6, deleteBytes: 1, insert: "\n" },
      { byte: 6, deleteBytes: 1, insert: " " },
    ],
  ],
  [
    "preserve a quoted bracket after earlier lookahead",
    String.raw`"[\133"`,
    [{ byte: 6, deleteBytes: 0, insert: "]" }],
  ],
);
for (const [name, source, edits] of histories) {
  test(`gitattributes: ${name}`, () =>
    assert.deepEqual(parse(source, edits), parse(applyEdits(source, edits))));
}

test("gitattributes: fixed-seed generated histories preserve source structure and issue ranges", () => {
  let state = 0x731dac9;
  const next = (maximum) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
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
  for (let sample = 0; sample < 120; sample++) {
    const source = seeds[sample % seeds.length];
    let bytes = Buffer.from(source);
    const edits = [];
    for (let step = 0; step < 4; step++) {
      const byte = next(bytes.length + 1);
      const edit = {
        byte,
        deleteBytes: Math.min(next(4), bytes.length - byte),
        insert: alphabet[next(alphabet.length)],
      };
      edits.push(edit);
      bytes = applyEdits(bytes, [edit]);
      assert.deepEqual(
        parse(source, edits),
        parse(bytes),
        JSON.stringify({ source, edits }),
      );
    }
  }
});
