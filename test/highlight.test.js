import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  createTreeSitter,
  grammars,
  packageName,
  root,
} from "../scripts/tree-sitter.js";

function decodeEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function renderedCaptures(html, source) {
  const start = html.indexOf("<pre><code>");
  const end = html.indexOf("</code></pre>");
  assert.ok(start >= 0 && end >= start, html);
  const content = html.slice(start + "<pre><code>".length, end);
  const stack = [];
  const captures = [];
  let text = "";
  for (const part of content.matchAll(
    /<span class='([^']*)'>|<[/]span>|([^<]+)/g,
  )) {
    if (part[1] !== undefined) stack.push(part[1].replaceAll(" ", "."));
    else if (part[0] === "</span>") assert.notEqual(stack.pop(), undefined);
    else {
      const decoded = decodeEntities(part[2]);
      text += decoded;
      captures.push(
        ...Array(Buffer.byteLength(decoded)).fill(stack.at(-1) ?? ""),
      );
    }
  }
  assert.equal(stack.length, 0, "unclosed highlight span");
  assert.equal(
    text.replace(/\n$/, ""),
    source.replace(/\n$/, ""),
    "rendered source differs from the input",
  );
  return captures;
}

function createHighlighter({ directory, root, run, captureNames }) {
  const parserDirectory = join(directory, "parsers");
  mkdirSync(parserDirectory);
  symlinkSync(root, join(parserDirectory, "tree-sitter-test"), "junction");
  const configPath = join(directory, "highlight.json");
  const capturePath = join(directory, "captures.txt");
  writeFileSync(
    configPath,
    JSON.stringify({
      "parser-directories": [parserDirectory],
      theme: Object.fromEntries(
        captureNames.map((name, index) => [name, index + 17]),
      ),
    }),
  );
  writeFileSync(capturePath, `${captureNames.join("\n")}\n`);

  return (scope, source, valid = true) => {
    const path = join(directory, "highlight.txt");
    writeFileSync(path, source);
    if (valid) {
      const parsed = run(["parse", "--cst", "--scope", scope, path]);
      assert.doesNotMatch(parsed, /^[0-9: \t-]+•/m, parsed);
    }
    const captures = renderedCaptures(
      run([
        "highlight",
        "--check",
        "--captures-path",
        capturePath,
        "--config-path",
        configPath,
        "--html",
        "--layout",
        "fragment",
        "--style",
        "classes",
        "--scope",
        scope,
        path,
      ]),
      source,
    );
    for (const capture of captures) {
      assert.ok(
        capture === "" || captureNames.includes(capture),
        `unexpected final capture: ${capture}`,
      );
    }
    return captures;
  };
}

function assertCaptures(source, actual, ranges) {
  const bytes = Buffer.from(source);
  const expected = Array(bytes.length).fill("");
  let previousEnd = 0;
  for (const [start, end, capture] of ranges) {
    assert.ok(
      Number.isSafeInteger(start) && start >= previousEnd,
      "expected ranges must be ordered and disjoint",
    );
    assert.ok(
      Number.isSafeInteger(end) && end > start && end <= bytes.length,
      "expected range exceeds source bytes",
    );
    expected.fill(capture, start, end);
    previousEnd = end;
  }
  for (const [index, byte] of bytes.entries()) {
    if (byte !== 10)
      assert.equal(
        actual[index],
        expected[index],
        `byte ${index} in ${JSON.stringify(source)}`,
      );
  }
}

const captureNames = [
  "comment",
  "string.special.path",
  "string.escape",
  "operator",
  "character.special",
  "punctuation.delimiter",
  "punctuation.bracket",
  "type",
  "string",
  "keyword",
  "attribute",
];
let highlight;

let directory;
let runner;
before(() => {
  directory = mkdtempSync(join(tmpdir(), `${packageName}-highlight-`));
  runner = createTreeSitter();
  highlight = createHighlighter({
    directory,
    root,
    run: assertCommand,
    captureNames,
  });
});
after(() => {
  try {
    runner?.close();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function assertCommand(arguments_) {
  const result = runner.run(arguments_, {
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /Non-standard highlight captures/);
  return result.stdout;
}

const grammar = grammars[0];

const finalCaptureCases = [
  {
    name: "escaped separators retain their own captures around a recursive wildcard",
    source: "x\\/**\\/b",
    captures: [
      [0, 1, "string.special.path"],
      [1, 3, "string.escape"],
      [3, 5, "character.special"],
      [5, 7, "string.escape"],
      [7, 8, "string.special.path"],
    ],
  },
  {
    name: "octal escaped separators retain their original capture ranges",
    source: '"x\\134\\057\\052\\052\\134\\057b"',
    captures: [
      [0, 1, "string"],
      [1, 2, "string.special.path"],
      [2, 10, "string.escape"],
      [10, 18, "character.special"],
      [18, 26, "string.escape"],
      [26, 27, "string.special.path"],
      [27, 28, "string"],
    ],
  },
  {
    name: "empty class highlights only existing delimiters",
    source: "[[::]]",
    captures: [
      [0, 2, "punctuation.bracket"],
      [2, 4, "punctuation.delimiter"],
      [4, 6, "punctuation.bracket"],
    ],
  },
  {
    name: "range upper bracket does not highlight a character class",
    source: "[a-[:digit:]] text",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "string.special.path"],
      [2, 3, "operator"],
      [3, 11, "string.special.path"],
      [11, 12, "punctuation.bracket"],
      [12, 13, "string.special.path"],
      [14, 18, "attribute"],
    ],
  },
  {
    name: "caret set negation",
    source: "[^a]",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "operator"],
      [2, 3, "string.special.path"],
      [3, 4, "punctuation.bracket"],
    ],
  },
  {
    name: "dot and equals inside sets remain path text",
    source: "[[.a.][=b=]]",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 5, "string.special.path"],
      [5, 7, "punctuation.bracket"],
      [7, 10, "string.special.path"],
      [10, 11, "punctuation.bracket"],
      [11, 12, "string.special.path"],
    ],
  },
  {
    name: "octal dot notation preserves escapes and the first set close",
    source: String.raw`"[\133\056a\056\135]"`,
    captures: [
      [0, 1, "string"],
      [1, 2, "punctuation.bracket"],
      [2, 10, "string.escape"],
      [10, 11, "string.special.path"],
      [11, 15, "string.escape"],
      [15, 19, "punctuation.bracket"],
      [19, 20, "string.special.path"],
      [20, 21, "string"],
    ],
  },
  { name: "comment", source: "# note", captures: [[0, 6, "comment"]] },
  {
    name: "invalid negation preserves glob highlighting",
    source: "!**/foo?.[a-z]  ",
    captures: [
      [1, 3, "character.special"],
      [3, 4, "punctuation.delimiter"],
      [4, 7, "string.special.path"],
      [7, 8, "character.special"],
      [8, 9, "string.special.path"],
      [9, 10, "punctuation.bracket"],
      [10, 11, "string.special.path"],
      [11, 12, "operator"],
      [12, 13, "string.special.path"],
      [13, 14, "punctuation.bracket"],
    ],
  },
  {
    name: "escape",
    source: "\\#a",
    captures: [
      [0, 2, "string.escape"],
      [2, 3, "string.special.path"],
    ],
  },
  {
    name: "unfinished set preserves its opening bracket",
    source: "[abc",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 4, "string.special.path"],
    ],
  },
  {
    name: "incomplete escape is uncolored",
    source: "a\\",
    captures: [[0, 1, "string.special.path"]],
  },
  {
    name: "invalid escape preserves the next line",
    source: "a\\\nb",
    captures: [
      [0, 1, "string.special.path"],
      [3, 4, "string.special.path"],
    ],
  },
  {
    name: "character class",
    source: "[[:digit:]]",
    captures: [
      [0, 2, "punctuation.bracket"],
      [2, 3, "punctuation.delimiter"],
      [3, 8, "type"],
      [8, 9, "punctuation.delimiter"],
      [9, 11, "punctuation.bracket"],
    ],
  },
  {
    name: "Unicode leaf ranges",
    source: "日本\\é",
    captures: [
      [0, 6, "string.special.path"],
      [6, 9, "string.escape"],
    ],
  },
];
finalCaptureCases.push(
  {
    name: "attribute forms",
    source: "a text -diff !merge eol=lf",
    captures: [
      [0, 1, "string.special.path"],
      [2, 6, "attribute"],
      [7, 8, "operator"],
      [8, 12, "attribute"],
      [13, 14, "operator"],
      [14, 19, "attribute"],
      [20, 23, "attribute"],
      [23, 24, "operator"],
      [24, 26, "string"],
    ],
  },
  {
    name: "macro definition",
    source: "[attr]custom -text",
    captures: [
      [0, 6, "keyword"],
      [6, 12, "attribute"],
      [13, 14, "operator"],
      [14, 18, "attribute"],
    ],
  },
  {
    name: "quoted wildcard uses its CST classification",
    source: String.raw`"\052.c" text`,
    captures: [
      [0, 1, "string"],
      [1, 5, "character.special"],
      [5, 7, "string.special.path"],
      [7, 8, "string"],
      [9, 13, "attribute"],
    ],
  },
  {
    name: "C quoting and glob escape",
    source: String.raw`"a\tb\\*"`,
    captures: [
      [0, 1, "string"],
      [1, 2, "string.special.path"],
      [2, 4, "string.escape"],
      [4, 5, "string.special.path"],
      [5, 8, "string.escape"],
      [8, 9, "string"],
    ],
  },
  {
    name: "incomplete quote keeps normal content colored",
    source: '"a b',
    captures: [
      [0, 1, "string"],
      [1, 4, "string.special.path"],
    ],
  },
  {
    name: "invalid quoted escape stays uncolored",
    source: String.raw`"a\qb" text`,
    captures: [
      [0, 1, "string"],
      [1, 2, "string.special.path"],
      [4, 5, "string.special.path"],
      [5, 6, "string"],
      [7, 11, "attribute"],
    ],
  },
  {
    name: "missing separator does not widen its range",
    source: '"a"text',
    captures: [
      [0, 1, "string"],
      [1, 2, "string.special.path"],
      [2, 3, "string"],
      [3, 7, "attribute"],
    ],
  },
  {
    name: "modified assignment preserves the operator",
    source: "a -name=value",
    captures: [
      [0, 1, "string.special.path"],
      [2, 3, "operator"],
      [3, 7, "attribute"],
      [7, 8, "operator"],
      [8, 13, "string"],
    ],
  },
);
for (const { name, source, captures } of finalCaptureCases) {
  test(`${grammar.name}: ${name}`, () =>
    assertCaptures(source, highlight(grammar.scope, source, false), captures));
}
