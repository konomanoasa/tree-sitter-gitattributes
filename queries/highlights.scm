[
  (comment_marker)
  (comment_text)
] @comment

[
  (glob_literal)
  (set_text)
  (range_character)
] @string.special.path

[
  (quote_open)
  (quote_close)
  (value_text)
] @string

[
  (escape)
  (quoted_escape)
] @string.escape

[
  (unset_marker)
  (unspecified_marker)
  (set_negation)
  (range_operator)
  (assignment_operator)
] @operator

[
  (wildcard)
  (recursive_wildcard)
  (single_character)
] @character.special

[
  (path_separator)
  ":"
] @punctuation.delimiter

[
  (set_open)
  (set_close)
  "["
  "]"
] @punctuation.bracket

(class_name) @type

(macro_marker) @keyword

(name_text) @attribute
