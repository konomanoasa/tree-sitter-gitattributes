use konomanoasa_tree_sitter_gitattributes as grammar;
use tree_sitter::{Parser, Query};

#[test]
fn parses_valid_source() {
  let source = "*.txt text eol=lf\n";
  let language = grammar::LANGUAGE.into();
  let mut parser = Parser::new();
  parser.set_language(&language).unwrap();
  let tree = parser.parse(source, None).unwrap();
  let root = tree.root_node();
  assert_eq!(root.kind(), "document");
  assert_eq!(root.byte_range(), 0..source.len());
  assert!(!root.has_error());
  assert!(grammar::NODE_TYPES.contains("\"document\""));
  Query::new(&language, grammar::HIGHLIGHTS_QUERY).unwrap();
}
