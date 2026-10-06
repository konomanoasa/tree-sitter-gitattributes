import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nodeTypes from "../src/node-types.json" with { type: "json" };
import { issues, leaves, owners, parse } from "./support/parser.js";

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

const validCases = [
  [
    "escaped slash before a recursive wildcard",
    "x\\/**/b",
    [
      ["glob_literal", "x"],
      ["escape", "\\/"],
      ["recursive_wildcard", "**"],
      ["path_separator", "/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "escaped slash after a recursive wildcard",
    "x/**\\/b",
    [
      ["glob_literal", "x"],
      ["path_separator", "/"],
      ["recursive_wildcard", "**"],
      ["escape", "\\/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "escaped slashes around a recursive wildcard",
    "x\\/**\\/b",
    [
      ["glob_literal", "x"],
      ["escape", "\\/"],
      ["recursive_wildcard", "**"],
      ["escape", "\\/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "leading recursive wildcard before an escaped slash",
    "**\\/b",
    [
      ["recursive_wildcard", "**"],
      ["escape", "\\/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "escaped nonseparator does not start a component",
    "x\\a**/b",
    [
      ["glob_literal", "x"],
      ["escape", "\\a"],
      ["wildcard", "**"],
      ["path_separator", "/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "escaped nonseparator does not end a component",
    "x/**\\a/b",
    [
      ["glob_literal", "x"],
      ["path_separator", "/"],
      ["wildcard", "**"],
      ["escape", "\\a"],
      ["path_separator", "/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "escaped backslash before slash does not end a component",
    "x/**\\\\/b",
    [
      ["glob_literal", "x"],
      ["path_separator", "/"],
      ["wildcard", "**"],
      ["escape", "\\\\"],
      ["path_separator", "/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "escaped slash does not make three asterisks recursive",
    "x\\/***/b",
    [
      ["glob_literal", "x"],
      ["escape", "\\/"],
      ["wildcard", "***"],
      ["path_separator", "/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "slash inside a set does not start a component",
    "[\\/]**/b",
    [
      ["set_open", "["],
      ["escape", "\\/"],
      ["set_close", "]"],
      ["wildcard", "**"],
      ["path_separator", "/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "C-quoted escaped slash before a recursive wildcard",
    '"x\\\\/**/b"',
    [
      ["quote_open", '"'],
      ["glob_literal", "x"],
      ["escape", "\\\\/"],
      ["recursive_wildcard", "**"],
      ["path_separator", "/"],
      ["glob_literal", "b"],
      ["quote_close", '"'],
    ],
  ],
  [
    "C-quoted escaped slash after a recursive wildcard",
    '"x/**\\\\/b"',
    [
      ["quote_open", '"'],
      ["glob_literal", "x"],
      ["path_separator", "/"],
      ["recursive_wildcard", "**"],
      ["escape", "\\\\/"],
      ["glob_literal", "b"],
      ["quote_close", '"'],
    ],
  ],
  [
    "C-quoted escaped slashes around a recursive wildcard",
    '"x\\\\/**\\\\/b"',
    [
      ["quote_open", '"'],
      ["glob_literal", "x"],
      ["escape", "\\\\/"],
      ["recursive_wildcard", "**"],
      ["escape", "\\\\/"],
      ["glob_literal", "b"],
      ["quote_close", '"'],
    ],
  ],
  [
    "octal spellings preserve escaped separator boundaries",
    '"x\\134\\057\\052\\052\\134\\057b"',
    [
      ["quote_open", '"'],
      ["glob_literal", "x"],
      ["escape", "\\134\\057"],
      ["recursive_wildcard", "\\052\\052"],
      ["escape", "\\134\\057"],
      ["glob_literal", "b"],
      ["quote_close", '"'],
    ],
  ],
  [
    "empty class retains its four delimiters without a name",
    "[[::]]",
    [
      ["set_open", "["],
      ["[", "["],
      [":", ":"],
      [":", ":"],
      ["]", "]"],
      ["set_close", "]"],
    ],
  ],
  [
    "encoded empty class retains delimiter source ranges",
    String.raw`"[\133\072\072\135]"`,
    [
      ["quote_open", '"'],
      ["set_open", "["],
      ["[", "\\133"],
      [":", "\\072"],
      [":", "\\072"],
      ["]", "\\135"],
      ["set_close", "]"],
      ["quote_close", '"'],
    ],
  ],
  [
    "quoted range upper bracket takes precedence over an encoded class prefix",
    '"[A-\\133:digit:]]"',
    [
      ["quote_open", '"'],
      ["set_open", "["],
      ["range_character", "A"],
      ["range_operator", "-"],
      ["quoted_escape", "\\133"],
      ["set_text", ":digit:"],
      ["set_close", "]"],
      ["glob_literal", "]"],
      ["quote_close", '"'],
    ],
  ],
  [
    "class after a failed candidate whose escaped bracket ends a range",
    "[[:a-\\]-[:digit:]]",
    [
      ["set_open", "["],
      ["set_text", "[:"],
      ["range_character", "a"],
      ["range_operator", "-"],
      ["escape", "\\]"],
      ["set_text", "-"],
      ["[", "["],
      [":", ":"],
      ["class_name", "digit"],
      [":", ":"],
      ["]", "]"],
      ["set_close", "]"],
    ],
  ],
  [
    "class search after a class respects the next range",
    "[[:alpha:]A-[:digit:]]",
    [
      ["set_open", "["],
      ["[", "["],
      [":", ":"],
      ["class_name", "alpha"],
      [":", ":"],
      ["]", "]"],
      ["range_character", "A"],
      ["range_operator", "-"],
      ["range_character", "["],
      ["set_text", ":digit:"],
      ["set_close", "]"],
      ["glob_literal", "]"],
    ],
  ],
  [
    "leading close can be the lower endpoint before a class prefix",
    "[]-[:digit:]]",
    [
      ["set_open", "["],
      ["range_character", "]"],
      ["range_operator", "-"],
      ["range_character", "["],
      ["set_text", ":digit:"],
      ["set_close", "]"],
      ["glob_literal", "]"],
    ],
  ],
  [
    "three asterisks between separators follow the manual",
    "a/***/b",
    [
      ["glob_literal", "a"],
      ["path_separator", "/"],
      ["wildcard", "***"],
      ["path_separator", "/"],
      ["glob_literal", "b"],
    ],
  ],
  [
    "modified attributes keep assignments",
    "* -name=value !other=value",
    [
      ["wildcard", "*"],
      ["unset_marker", "-"],
      ["name_text", "name"],
      ["assignment_operator", "="],
      ["value_text", "value"],
      ["unspecified_marker", "!"],
      ["name_text", "other"],
      ["assignment_operator", "="],
      ["value_text", "value"],
    ],
  ],
  [
    "encoded macro marker and name",
    '"\\133attr]\\146oo" text',
    [
      ["quote_open", '"'],
      ["macro_marker", "\\133attr]"],
      ["quoted_escape", "\\146"],
      ["name_text", "oo"],
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],
  [
    "attribute name punctuation and digits",
    "* _name .name 1name foo-bar",
    [
      ["wildcard", "*"],
      ["name_text", "_name"],
      ["name_text", ".name"],
      ["name_text", "1name"],
      ["name_text", "foo-bar"],
    ],
  ],
  [
    "four attribute forms",
    "*.txt text -diff !merge eol=lf",
    [
      ["wildcard", "*"],
      ["glob_literal", ".txt"],
      ["name_text", "text"],
      ["unset_marker", "-"],
      ["name_text", "diff"],
      ["unspecified_marker", "!"],
      ["name_text", "merge"],
      ["name_text", "eol"],
      ["assignment_operator", "="],
      ["value_text", "lf"],
    ],
  ],
  [
    "macro definition",
    "[attr]binary -diff -merge -text",
    [
      ["macro_marker", "[attr]"],
      ["name_text", "binary"],
      ["unset_marker", "-"],
      ["name_text", "diff"],
      ["unset_marker", "-"],
      ["name_text", "merge"],
      ["unset_marker", "-"],
      ["name_text", "text"],
    ],
  ],
  [
    "layout and indented comments",
    " \t# note  \r\n\r\n a text \t\n",
    [
      ["comment_marker", "#"],
      ["comment_text", " note  "],
      ["line_ending", "\r\n"],
      ["line_ending", "\r\n"],
      ["glob_literal", "a"],
      ["name_text", "text"],
      ["line_ending", "\n"],
    ],
  ],
  [
    "empty attribute values",
    "a foo= bar=a=b",
    [
      ["glob_literal", "a"],
      ["name_text", "foo"],
      ["assignment_operator", "="],
      ["name_text", "bar"],
      ["assignment_operator", "="],
      ["value_text", "a=b"],
    ],
  ],
  [
    "quoted whitespace and wildcard",
    '"a b/*.c" text',
    [
      ["quote_open", '"'],
      ["glob_literal", "a b"],
      ["path_separator", "/"],
      ["wildcard", "*"],
      ["glob_literal", ".c"],
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],
  [
    "octal wildcard",
    '"\\052.c" text',
    [
      ["quote_open", '"'],
      ["wildcard", "\\052"],
      ["glob_literal", ".c"],
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],
  [
    "quoted glob escape",
    '"\\\\*.c" text',
    [
      ["quote_open", '"'],
      ["escape", "\\\\*"],
      ["glob_literal", ".c"],
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],
  [
    "quoted control character remains content",
    '"a\\tb" text',
    [
      ["quote_open", '"'],
      ["glob_literal", "a"],
      ["quoted_escape", "\\t"],
      ["glob_literal", "b"],
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],
  [
    "character range and POSIX class",
    "[!a-z[:digit:]] text",
    [
      ["set_open", "["],
      ["set_negation", "!"],
      ["range_character", "a"],
      ["range_operator", "-"],
      ["range_character", "z"],
      ["[", "["],
      [":", ":"],
      ["class_name", "digit"],
      [":", ":"],
      ["]", "]"],
      ["set_close", "]"],
      ["name_text", "text"],
    ],
  ],

  [
    "literal brace syntax",
    "{a,b} text",
    [
      ["glob_literal", "{a,b}"],
      ["name_text", "text"],
    ],
  ],
  [
    "recursive wildcard positions",
    "**/a/**/b/** text",
    [
      ["recursive_wildcard", "**"],
      ["path_separator", "/"],
      ["glob_literal", "a"],
      ["path_separator", "/"],
      ["recursive_wildcard", "**"],
      ["path_separator", "/"],
      ["glob_literal", "b"],
      ["path_separator", "/"],
      ["recursive_wildcard", "**"],
      ["name_text", "text"],
    ],
  ],
  [
    "malformed class remains in the outer set",
    "[[:]]",
    [
      ["set_open", "["],
      ["set_text", "[:"],
      ["set_close", "]"],
      ["glob_literal", "]"],
    ],
  ],
  [
    "missing class colon preserves the outer set boundary",
    "[[:digit]]",
    [
      ["set_open", "["],
      ["set_text", "[:digit"],
      ["set_close", "]"],
      ["glob_literal", "]"],
    ],
  ],
  [
    "bracket as a range endpoint is not a collating symbol",
    "[[-z]",
    [
      ["set_open", "["],
      ["range_character", "["],
      ["range_operator", "-"],
      ["range_character", "z"],
      ["set_close", "]"],
    ],
  ],
  [
    "dot bracket text closes the set before a following hyphen",
    "[[.a.]-z]",
    [
      ["set_open", "["],
      ["set_text", "[.a."],
      ["set_close", "]"],
      ["glob_literal", "-z]"],
    ],
  ],
  [
    "opening bracket can end a range before dot text",
    "[a-[.z.]]",
    [
      ["set_open", "["],
      ["range_character", "a"],
      ["range_operator", "-"],
      ["range_character", "["],
      ["set_text", ".z."],
      ["set_close", "]"],
      ["glob_literal", "]"],
    ],
  ],
  [
    "range endpoint is not reused",
    "[a-m-o]",
    [
      ["set_open", "["],
      ["range_character", "a"],
      ["range_operator", "-"],
      ["range_character", "m"],
      ["set_text", "-o"],
      ["set_close", "]"],
    ],
  ],
  [
    "escaped special markers",
    "\\#\\!\\*\\?\\[",
    [
      ["escape", "\\#"],
      ["escape", "\\!"],
      ["escape", "\\*"],
      ["escape", "\\?"],
      ["escape", "\\["],
    ],
  ],
  ["standalone double asterisk is ordinary", "**", [["wildcard", "**"]]],
  [
    "long asterisk run is ordinary",
    "***/",
    [
      ["wildcard", "***"],
      ["path_separator", "/"],
    ],
  ],
  [
    "adjacent text makes double asterisk ordinary",
    "a**/",
    [
      ["glob_literal", "a"],
      ["wildcard", "**"],
      ["path_separator", "/"],
    ],
  ],
  [
    "escaped slash starts a trailing recursive wildcard",
    "\\/**",
    [
      ["escape", "\\/"],
      ["recursive_wildcard", "**"],
    ],
  ],
  [
    "Unicode literal and escape",
    "日本\\é",
    [
      ["glob_literal", "日本"],
      ["escape", "\\é"],
    ],
  ],
  ["leading BOM is excluded", "﻿a", [["glob_literal", "a"]]],
  ["only the first BOM is excluded", "﻿﻿a", [["glob_literal", "﻿a"]]],

  [
    "simple set",
    "[abc]",
    [
      ["set_open", "["],
      ["set_text", "abc"],
      ["set_close", "]"],
    ],
  ],
  [
    "leading closing bracket is a member",
    "[]!]",
    [
      ["set_open", "["],
      ["set_text", "]!"],
      ["set_close", "]"],
    ],
  ],
  [
    "caret negates a character set",
    "[^a]",
    [
      ["set_open", "["],
      ["set_negation", "^"],
      ["set_text", "a"],
      ["set_close", "]"],
    ],
  ],
  [
    "edge hyphens are literal",
    "[-ab-]",
    [
      ["set_open", "["],
      ["set_text", "-ab-"],
      ["set_close", "]"],
    ],
  ],
  [
    "escaped range endpoint",
    "[\\a-z]",
    [
      ["set_open", "["],
      ["escape", "\\a"],
      ["range_operator", "-"],
      ["range_character", "z"],
      ["set_close", "]"],
    ],
  ],
  [
    "escaped set close",
    "[a\\]b]",
    [
      ["set_open", "["],
      ["set_text", "a"],
      ["escape", "\\]"],
      ["set_text", "b"],
      ["set_close", "]"],
    ],
  ],
  [
    "range upper bracket takes precedence over a class prefix",
    "[a-[:digit:]]",
    [
      ["set_open", "["],
      ["range_character", "a"],
      ["range_operator", "-"],
      ["range_character", "["],
      ["set_text", ":digit:"],
      ["set_close", "]"],
      ["glob_literal", "]"],
    ],
  ],
  [
    "class after a completed range remains independent",
    "[a-b-[:digit:]]",
    [
      ["set_open", "["],
      ["range_character", "a"],
      ["range_operator", "-"],
      ["range_character", "b"],
      ["set_text", "-"],
      ["[", "["],
      [":", ":"],
      ["class_name", "digit"],
      [":", ":"],
      ["]", "]"],
      ["set_close", "]"],
    ],
  ],
  [
    "dot bracket notation is ordinary set text",
    "[[.ch.]]",
    [
      ["set_open", "["],
      ["set_text", "[.ch."],
      ["set_close", "]"],
      ["glob_literal", "]"],
    ],
  ],
  [
    "equal bracket notation is ordinary set text",
    "[[=a=]]",
    [
      ["set_open", "["],
      ["set_text", "[=a="],
      ["set_close", "]"],
      ["glob_literal", "]"],
    ],
  ],
  [
    "class closes at its first colon bracket pair",
    "[[:a[::][.b:]c.][:d:]",
    [
      ["set_open", "["],
      ["[", "["],
      [":", ":"],
      ["class_name", "a[:"],
      [":", ":"],
      ["]", "]"],
      ["set_text", "[.b:"],
      ["set_close", "]"],
      ["glob_literal", "c.]"],
      ["set_open", "["],
      ["set_text", ":d:"],
      ["set_close", "]"],
    ],
  ],
  [
    "quoted macro definition",
    '"[attr]name" text',
    [
      ["quote_open", '"'],
      ["macro_marker", "[attr]"],
      ["name_text", "name"],
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],

  [
    "empty quotation and value have no invented children",
    '"" custom=',
    [
      ["quote_open", '"'],
      ["quote_close", '"'],
      ["name_text", "custom"],
      ["assignment_operator", "="],
    ],
  ],
  [
    "macro may have no attributes",
    "[attr]empty",
    [
      ["macro_marker", "[attr]"],
      ["name_text", "empty"],
    ],
  ],
  [
    "attribute values have no quoting or inline comments",
    'a value="x" other=\\a#b',
    [
      ["glob_literal", "a"],
      ["name_text", "value"],
      ["assignment_operator", "="],
      ["value_text", '"x"'],
      ["name_text", "other"],
      ["assignment_operator", "="],
      ["value_text", "\\a#b"],
    ],
  ],
  [
    "all specified whitespace separates attribute tokens",
    "a\tb\vc\fd\re",
    [
      ["glob_literal", "a"],
      ["name_text", "b"],
      ["name_text", "c"],
      ["name_text", "d"],
      ["name_text", "e"],
    ],
  ],

  [
    "comment preserves bare CR NUL and embedded BOM",
    "#\r\0\uFEFF",
    [
      ["comment_marker", "#"],
      ["comment_text", "\r\0\uFEFF"],
    ],
  ],

  [
    "all C control escapes preserve source",
    String.raw`"\a\b\t\n\v\f\r\"" text`,
    [
      ["quote_open", '"'],
      ...["\\a", "\\b", "\\t", "\\n", "\\v", "\\f", "\\r", '\\"'].map((s) => [
        "quoted_escape",
        s,
      ]),
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],
  [
    "octal bytes are independent from source encoding",
    String.raw`"\000\302\265\377"`,
    [
      ["quote_open", '"'],
      ...["\\000", "\\302", "\\265", "\\377"].map((s) => ["quoted_escape", s]),
      ["quote_close", '"'],
    ],
  ],
  [
    "octal spelling of set delimiters and range",
    String.raw`"\133\041a\055z\135" text`,
    [
      ["quote_open", '"'],
      ["set_open", "\\133"],
      ["set_negation", "\\041"],
      ["range_character", "a"],
      ["range_operator", "\\055"],
      ["range_character", "z"],
      ["set_close", "\\135"],
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],
  [
    "quoted range endpoint",
    String.raw`"[\141-z]"`,
    [
      ["quote_open", '"'],
      ["set_open", "["],
      ["quoted_escape", "\\141"],
      ["range_operator", "-"],
      ["range_character", "z"],
      ["set_close", "]"],
      ["quote_close", '"'],
    ],
  ],
  [
    "quoted class name and delimiters",
    String.raw`"\133\133\072di\147it\072\135\135"`,
    [
      ["quote_open", '"'],
      ["set_open", "\\133"],
      ["[", "\\133"],
      [":", "\\072"],
      ["class_name", "di"],
      ["quoted_escape", "\\147"],
      ["class_name", "it"],
      [":", "\\072"],
      ["]", "\\135"],
      ["set_close", "\\135"],
      ["quote_close", '"'],
    ],
  ],

  [
    "quoted slash and asterisks form recursive wildcard",
    String.raw`"a\057\052\052"`,
    [
      ["quote_open", '"'],
      ["glob_literal", "a"],
      ["path_separator", "\\057"],
      ["recursive_wildcard", "\\052\\052"],
      ["quote_close", '"'],
    ],
  ],
  [
    "quoted escaped negation is literal",
    String.raw`"\\!a" text`,
    [
      ["quote_open", '"'],
      ["escape", "\\\\!"],
      ["glob_literal", "a"],
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],
  [
    "initial hash inside quotation is literal",
    '"#a" text',
    [
      ["quote_open", '"'],
      ["glob_literal", "#a"],
      ["quote_close", '"'],
      ["name_text", "text"],
    ],
  ],
  [
    "leading hyphen can be a literal range endpoint",
    "[--a]",
    [
      ["set_open", "["],
      ["range_character", "-"],
      ["range_operator", "-"],
      ["range_character", "a"],
      ["set_close", "]"],
    ],
  ],
  [
    "trailing hyphen can be a literal range endpoint",
    "[%--]",
    [
      ["set_open", "["],
      ["range_character", "%"],
      ["range_operator", "-"],
      ["range_character", "-"],
      ["set_close", "]"],
    ],
  ],
  [
    "encoded hyphen makes the following bracket a range endpoint",
    String.raw`"[a\055[:alpha:]]"`,
    [
      ["quote_open", '"'],
      ["set_open", "["],
      ["range_character", "a"],
      ["range_operator", "\\055"],
      ["range_character", "["],
      ["set_text", ":alpha:"],
      ["set_close", "]"],
      ["glob_literal", "]"],
      ["quote_close", '"'],
    ],
  ],
];
for (const [name, source, expected] of validCases)
  test(`gitattributes: ${name}`, () => {
    const tree = parse(source);
    assert.deepEqual(issues(tree), []);
    assert.deepEqual(leaves(source, tree), expected);
  });

const invalidCases = [
  [
    "contiguous forbidden attribute name characters form one issue",
    "* a@@b",
    [["invalid_syntax", "invalid_name_character", 3, 5]],
    ["attribute_name"],
  ],
  [
    "contiguous forbidden macro name characters form one issue",
    "[attr]a@@b text",
    [["invalid_syntax", "invalid_name_character", 7, 9]],
    ["attribute_name"],
  ],
  [
    "separate attribute owners keep separate invalid runs",
    "* @@ @@",
    [
      ["invalid_syntax", "invalid_name_character", 2, 4],
      ["invalid_syntax", "invalid_name_character", 5, 7],
    ],
    ["attribute_name", "attribute_name"],
  ],
  [
    "empty class does not close its outer set",
    "[[::]",
    [["incomplete_syntax", "missing_set_close", 5, 5]],
    ["character_set"],
  ],
  [
    "unquoted separator ends an unclosed set before EOF",
    "[abc  ",
    [["invalid_syntax", "missing_set_close", 4, 4]],
    ["character_set"],
  ],
  [
    "invalid quoted escape stays inside a class name",
    String.raw`"[[:a\q:]]"`,
    [["invalid_syntax", "invalid_quoted_escape", 5, 7]],
    ["character_class"],
  ],
  [
    "short octal escape stays inside a class name",
    String.raw`"[[:a\12:]]"`,
    [["invalid_syntax", "incomplete_quoted_escape", 5, 8]],
    ["character_class"],
  ],
  [
    "class closing bracket does not also close its set",
    "a[:[:[:]\n",
    [["invalid_syntax", "missing_set_close", 8, 8]],
    ["character_set"],
  ],
  [
    "unfinished set before attributes",
    "[abc text",
    [["invalid_syntax", "missing_set_close", 4, 4]],
    ["character_set"],
  ],
  [
    "unfinished macro marker is an incomplete set",
    "[attr text",
    [["invalid_syntax", "missing_set_close", 5, 5]],
    ["character_set"],
  ],
  [
    "quoted octal opening bracket retains a missing close",
    '"\\133abc"',
    [["invalid_syntax", "missing_set_close", 8, 8]],
    ["character_set"],
  ],
  [
    "NUL in an attribute name is preserved as an issue",
    "a\u0000b n\u0000m=v\u0000x",
    [["invalid_syntax", "invalid_name_character", 5, 6]],
    ["attribute_name"],
  ],
  [
    "second modifier is an invalid name character",
    "a --x !!x",
    [
      ["invalid_syntax", "invalid_name_character", 3, 4],
      ["invalid_syntax", "invalid_name_character", 7, 8],
    ],
    ["attribute_name", "attribute_name"],
  ],
  [
    "dollar in an attribute name",
    "* bad$name",
    [["invalid_syntax", "invalid_name_character", 5, 6]],
    ["attribute_name"],
  ],
  [
    "non-ASCII attribute names are invalid",
    "* 日本",
    [["invalid_syntax", "invalid_name_character", 2, 8]],
    ["attribute_name"],
  ],
  [
    "quoted macro with an invalid encoded name character",
    '"[attr]a\\044b" text',
    [["invalid_syntax", "invalid_name_character", 8, 12]],
    ["attribute_name"],
  ],
  [
    "unclosed set at EOF",
    "x[abc",
    [["incomplete_syntax", "missing_set_close", 5, 5]],
    ["character_set"],
  ],
  [
    "unclosed set at line end",
    "[abc\nnext",
    [["invalid_syntax", "missing_set_close", 4, 4]],
    ["character_set"],
  ],
  [
    "leading close remains a member of an incomplete set",
    "[]",
    [["incomplete_syntax", "missing_set_close", 2, 2]],
    ["character_set"],
  ],
  [
    "wildcards inside an incomplete set remain set text",
    "x[a*?",
    [["incomplete_syntax", "missing_set_close", 5, 5]],
    ["character_set"],
  ],
  [
    "set and trailing escape are independently incomplete",
    "[a\\",
    [
      ["incomplete_syntax", "incomplete_escape", 2, 3],
      ["incomplete_syntax", "missing_set_close", 3, 3],
    ],
    ["character_set", "character_set"],
  ],
  [
    "negative pattern",
    "!a text",
    [["invalid_syntax", "negative_pattern", 0, 1]],
    ["pattern"],
  ],
  [
    "missing attribute name at EOF",
    "a -",
    [["incomplete_syntax", "missing_attribute_name", 3, 3]],
    ["attribute"],
  ],
  [
    "missing attribute name before LF",
    "a -\n",
    [["invalid_syntax", "missing_attribute_name", 3, 3]],
    ["attribute"],
  ],
  [
    "missing macro name at EOF",
    "[attr]",
    [["incomplete_syntax", "missing_attribute_name", 6, 6]],
    ["macro_definition"],
  ],
  [
    "missing quote at EOF",
    '"a b',
    [["incomplete_syntax", "missing_quote_close", 4, 4]],
    ["pattern"],
  ],
  [
    "missing quote before newline",
    '"a b\nnext text',
    [["invalid_syntax", "missing_quote_close", 4, 4]],
    ["pattern"],
  ],
  [
    "missing separator after quote",
    '"a"text',
    [["invalid_syntax", "missing_attribute_separator", 3, 3]],
    ["attribute_rule"],
  ],

  [
    "incomplete glob escape",
    "a\\",
    [["incomplete_syntax", "incomplete_escape", 1, 2]],
    ["pattern"],
  ],
  [
    "glob escape ended by separator",
    "a\\ text",
    [["invalid_syntax", "incomplete_escape", 1, 2]],
    ["pattern"],
  ],
  [
    "invalid quote escape",
    '"a\\qb" text',
    [["invalid_syntax", "invalid_quoted_escape", 2, 4]],
    ["pattern"],
  ],
  [
    "incomplete octal and quote",
    '"\\12',
    [
      ["incomplete_syntax", "incomplete_quoted_escape", 1, 4],
      ["incomplete_syntax", "missing_quote_close", 4, 4],
    ],
    ["pattern", "pattern"],
  ],
  [
    "octal ended by quote",
    '"\\12" text',
    [["invalid_syntax", "incomplete_quoted_escape", 1, 4]],
    ["pattern"],
  ],
  [
    "octal negation",
    String.raw`"\041a" text`,
    [["invalid_syntax", "negative_pattern", 1, 5]],
    ["pattern"],
  ],
  [
    "empty name before assignment",
    "a =x",
    [["invalid_syntax", "missing_attribute_name", 2, 2]],
    ["attribute"],
  ],
  [
    "empty name before modified assignment",
    "a !=x",
    [["invalid_syntax", "missing_attribute_name", 3, 3]],
    ["attribute"],
  ],
  [
    "empty name before CRLF",
    "a -\r\nnext text",
    [["invalid_syntax", "missing_attribute_name", 3, 3]],
    ["attribute"],
  ],
  [
    "quote and escape incomplete at EOF",
    '"a\\',
    [
      ["incomplete_syntax", "incomplete_quoted_escape", 2, 3],
      ["incomplete_syntax", "missing_quote_close", 3, 3],
    ],
    ["pattern", "pattern"],
  ],
  [
    "invalid hexadecimal escape",
    String.raw`"\x41"`,
    [["invalid_syntax", "invalid_quoted_escape", 1, 3]],
    ["pattern"],
  ],
  [
    "octal byte overflow",
    String.raw`"\400"`,
    [["invalid_syntax", "invalid_quoted_escape", 1, 3]],
    ["pattern"],
  ],
  [
    "glob escape ended by closing quote",
    String.raw`"a\\" text`,
    [["invalid_syntax", "incomplete_escape", 2, 4]],
    ["pattern"],
  ],
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
for (const [name, source, expected, expectedOwners] of invalidCases)
  test(`gitattributes: ${name}`, () => {
    const tree = parse(source);
    assert.deepEqual(issues(tree), expected);
    assert.deepEqual(owners(tree), expectedOwners);
    for (const node of tree.filter(({ kind }) => kind === "syntax_issue"))
      assert.equal(node.field, "issue");
  });

test("gitattributes: invalid macro name characters preserve valid quoted escapes", () => {
  const source = String.raw`"[attr]a\044b\tc" text`;
  const nodes = parse(source);
  assert.deepEqual(issues(nodes), [
    ["invalid_syntax", "invalid_name_character", 8, 12],
    ["invalid_syntax", "invalid_name_character", 13, 15],
  ]);
  assert.deepEqual(owners(nodes), ["attribute_name", "attribute_name"]);
  assert.deepEqual(
    nodes
      .filter(({ kind }) => kind === "quoted_escape")
      .map(({ parent, start, end }) => [nodes[parent].kind, start, end]),
    [
      ["invalid_name_character", 8, 12],
      ["invalid_name_character", 13, 15],
    ],
  );
  assert.deepEqual(
    leaves(source, nodes).filter(([kind]) => kind === "name_text"),
    [
      ["name_text", "a"],
      ["name_text", "b"],
      ["name_text", "c"],
      ["name_text", "text"],
    ],
  );
});

test("gitattributes: line ranges include indentation separators and terminators", () => {
  const source = "  a text \r\n\t[attr]binary -text\n";
  const nodes = parse(source);
  assert.deepEqual(
    nodes
      .filter(({ kind }) =>
        ["attribute_rule", "macro_definition"].includes(kind),
      )
      .map(({ kind, start, end }) => [kind, start, end]),
    [
      ["attribute_rule", 0, 11],
      ["macro_definition", 11, 31],
    ],
  );
});

test("gitattributes: quoted bracket remains an escape inside an incomplete set", () => {
  const source = String.raw`"[\133"`;
  assert.deepEqual(leaves(source, parse(source)), [
    ["quote_open", '"'],
    ["set_open", "["],
    ["quoted_escape", "\\133"],
    ["missing_set_close", ""],
    ["quote_close", '"'],
  ]);
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

test("gitattributes: decoded glob escape cannot hide a following invalid quoted escape", () => {
  const source = String.raw`"\\\q" text`;
  const tree = parse(source);
  assert.deepEqual(issues(tree), [
    ["invalid_syntax", "invalid_quoted_escape", 3, 5],
  ]);
  assert.deepEqual(owners(tree), ["pattern"]);
});

const compoundCases = [
  [
    "class delimiters",
    "[[:digit:]]",
    "character_class",
    [
      ["[", null, 1, 2],
      [":", null, 2, 3],
      ["class_name", "name", 3, 8],
      [":", null, 8, 9],
      ["]", null, 9, 10],
    ],
  ],
  [
    "dot bracket text preserves Unicode byte ranges",
    "[[.é.]]",
    "character_set",
    [
      ["set_open", "opening", 0, 1],
      ["set_text", null, 1, 6],
      ["set_close", "closing", 6, 7],
    ],
  ],
  [
    "equal bracket text preserves set boundaries",
    "[[=a=]]",
    "character_set",
    [
      ["set_open", "opening", 0, 1],
      ["set_text", null, 1, 5],
      ["set_close", "closing", 5, 6],
    ],
  ],
  [
    "octal bracket text keeps source ranges",
    '"[\\133\\056a\\056\\135]"',
    "character_set",
    [
      ["set_open", "opening", 1, 2],
      ["quoted_escape", null, 2, 6],
      ["quoted_escape", null, 6, 10],
      ["set_text", null, 10, 11],
      ["quoted_escape", null, 11, 15],
      ["set_close", "closing", 15, 19],
    ],
  ],
  [
    "mixed literal and octal set text",
    '"[[\\075a=\\135]"',
    "character_set",
    [
      ["set_open", "opening", 1, 2],
      ["set_text", null, 2, 3],
      ["quoted_escape", null, 3, 7],
      ["set_text", null, 7, 9],
      ["set_close", "closing", 9, 13],
    ],
  ],
];
for (const [name, source, owner, expected] of compoundCases) {
  test(`gitattributes: ${name} retain direct children and original byte ranges`, () => {
    const nodes = parse(source);
    assert.deepEqual(issues(nodes), []);
    const index = nodes.findIndex(({ kind }) => kind === owner);
    assert.notEqual(index, -1);
    assert.deepEqual(
      nodes
        .filter(({ parent }) => parent === index)
        .map(({ kind, field, start, end }) => [kind, field, start, end]),
      expected,
    );
    const last = expected.at(-1);
    assert.ok(last);
    assert.deepEqual(
      [nodes[index].start, nodes[index].end],
      [expected[0][2], last[3]],
    );
  });
}

test("gitattributes: compound delimiters are anonymous and have no opening or closing fields", () => {
  for (const type of ["[", "]", ":"]) {
    assert.equal(nodeTypes.find((node) => node.type === type)?.named, false);
  }
  for (const type of ["character_class"]) {
    const node = nodeTypes.find((node) => node.type === type);
    assert.ok(node, type);
    assert.ok(node.fields, type);
    assert.deepEqual(Object.keys(node.fields), ["issue", "name"]);
  }
});

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
      `Supplementary behavior established with Git 2.55.0 (escaped-slash boundaries: Git 2.56.0); checked with ${version.stdout.trim()}`,
    );
    assert.equal(run(["init", "--quiet"]).status, 0);
    const cases = [
      {
        source: '"[attr]foo" audit_probe\n* foo\n',
        attribute: "audit_probe",
        value: "set",
        count: 0,
      },
      {
        source: String.raw`"\133attr]\146oo" audit_probe
* foo
`,
        attribute: "audit_probe",
        value: "set",
        count: 0,
      },
      {
        source: "* -name=value\n",
        attribute: "name",
        value: "unset",
        count: 0,
      },
      {
        source: "* !name=value\n",
        attribute: "name",
        value: "unspecified",
        count: 0,
      },
      {
        source: "* bad$name audit_probe\n",
        attribute: "audit_probe",
        value: "unspecified",
        count: 1,
      },
      {
        source: "* 日本 audit_probe\n",
        attribute: "audit_probe",
        value: "unspecified",
        count: 1,
      },
      {
        source: "* --name audit_probe\n",
        attribute: "audit_probe",
        value: "unspecified",
        count: 1,
      },
      {
        source: "* _name .name 1name foo-bar audit_probe\n",
        attribute: "audit_probe",
        value: "set",
        count: 0,
      },
    ];
    for (const { source, attribute, value, count } of cases) {
      writeFileSync(join(directory, ".gitattributes"), source);
      const result = run(["check-attr", "-z", attribute, "--", "a"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `a\0${attribute}\0${value}\0`, source);
      assert.equal(issues(parse(source)).length, count, source);
      if (count) assert.match(result.stderr, /not a valid attribute name/);
    }
    const patterns = [
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
      const matched = [];
      for (let index = 0; index + 2 < fields.length; index += 3) {
        if (fields[index + 2] === "set") matched.push(fields[index]);
      }
      assert.deepEqual(matched, expected, pattern);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const largeInputCases = [
  ["many independent lines", "**/node_modules/ -text\n".repeat(10000), 0],
  ["one long literal", "a".repeat(200000), 0],
  ["many unmatched open brackets", "[".repeat(50000), 1],
  ["many incomplete class prefixes", `${"[:".repeat(16000)}]`, 1],
  ["many complete character sets", "[a-z]".repeat(10000), 0],
  ["many unmatched brackets before a class", `${"[".repeat(50000)}[:x]`, 0],
  ["many unclosed brackets holding classes", "[[:x:]".repeat(20000), 1],
  ["many independently invalid escapes", "a\\\n".repeat(10000), 10000],
  ["many octal wildcards", `"${"\\052".repeat(10000)}" text`, 0],
  ["many incomplete quoted lines", '"a\\12\n'.repeat(5000), 10000],
  ["many mixed named item prefixes", `${"[:[.[=".repeat(80000)}]`, 0],
  ["many wildcards inside an incomplete set", "[[[[?".repeat(60000), 1],
];
for (const [name, source, expectedIssues] of largeInputCases)
  test(`gitattributes: large input: ${name}`, () => {
    assert.equal(issues(parse(source)).length, expectedIssues);
  });

test("gitattributes: octal range endpoints retain individual source escapes", () => {
  const source = String.raw`"[\303\251-z]"`;
  const nodes = parse(source);
  assert.deepEqual(issues(nodes), []);
  assert.deepEqual(leaves(source, nodes), [
    ["quote_open", '"'],
    ["set_open", "["],
    ["quoted_escape", String.raw`\303`],
    ["quoted_escape", String.raw`\251`],
    ["range_operator", "-"],
    ["range_character", "z"],
    ["set_close", "]"],
    ["quote_close", '"'],
  ]);
  const rangeIndex = nodes.findIndex(({ kind }) => kind === "character_range");
  assert.deepEqual(
    nodes
      .filter(({ parent }) => parent === rangeIndex)
      .map(({ kind, field, start, end }) => [kind, field, start, end]),
    [
      ["quoted_escape", "lower", 6, 10],
      ["range_operator", null, 10, 11],
      ["range_character", "upper", 11, 12],
    ],
  );
  const edits = [{ byte: 3, deleteBytes: 3, insert: "377" }];
  assert.deepEqual(parse(source, edits), parse(String.raw`"[\377\251-z]"`));
  edits.push({ byte: 3, deleteBytes: 3, insert: "303" });
  assert.deepEqual(parse(source, edits), nodes);
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
