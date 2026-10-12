import { test } from "node:test";
import {
  applyEdits,
  assertEditHistory,
  assertIncrementalEqualsFresh,
} from "./support/parser.js";

const editCases = [
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

test("gitattributes: fixed-seed generated histories preserve source structure and issue ranges", () => {
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
      assertIncrementalEqualsFresh(source, edits, bytes);
    }
  }
});
