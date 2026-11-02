import assert from "node:assert/strict";
import { test } from "node:test";
import language from "@konomanoasa/tree-sitter-gitattributes";
import Parser from "tree-sitter";

test("Node.js language parses gitattributes and exposes node metadata and highlights", () => {
  const parser = new Parser();
  parser.setLanguage(language);
  const source = "*.txt text eol=lf\n";
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.type, "document");
  assert.equal(tree.rootNode.hasError, false);
  assert.equal(tree.rootNode.text, source);
  assert.ok(
    language.nodeTypeInfo.some(
      (node) => node.type === "document" && node.named,
    ),
  );
  const query = new Parser.Query(language, language.HIGHLIGHTS_QUERY);
  assert.deepEqual(
    query.captures(tree.rootNode).map(({ name, node }) => [name, node.text]),
    [
      ["character.special", "*"],
      ["string.special.path", ".txt"],
      ["attribute", "text"],
      ["attribute", "eol"],
      ["operator", "="],
      ["string", "lf"],
    ],
  );
});
