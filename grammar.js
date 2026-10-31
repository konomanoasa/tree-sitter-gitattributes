export default grammar({
  name: "gitattributes",
  externals: ($) => [
    $._line_start,
    $._blank_start,
    $._comment_start,
    $._rule_start,
    $._macro_start,
    $._eof,
    $._layout,
    $._separator,
    $._attribute_start,
    $._attribute_end,
    $._name_start,
    $._name_end,
    $._value_start,
    $._value_end,
    $._pattern_end,
    $._glob_start,
    $._set_item_start,
    $.comment_marker,
    $.comment_text,
    $.macro_marker,
    $.unset_marker,
    $.unspecified_marker,
    $.assignment_operator,
    $.name_text,
    $.value_text,
    $.quote_open,
    $.quote_close,
    $._literal,
    $.wildcard,
    $.recursive_wildcard,
    $.single_character,
    $.path_separator,
    $.escape,
    $.quoted_escape,
    $.set_open,
    $.set_negation,
    $.set_text,
    $.set_close,
    $._range_start,
    $.range_character,
    $.range_operator,
    $._compound_open,
    $._compound_close,
    $._class_open,
    $.class_name,
    $._class_close,
    $._error_sentinel,
  ],
  extras: () => [],
  rules: {
    document: ($) => repeat($._line),
    _line: ($) =>
      seq(
        $._line_start,
        choice($.blank_line, $.comment, $.attribute_rule, $.macro_definition),
      ),
    line_ending: () => /\r?\n/,
    _end: ($) => seq(optional($._layout), choice($.line_ending, $._eof)),
    blank_line: ($) => seq($._blank_start, $._end),
    comment: ($) =>
      seq($._comment_start, $.comment_marker, optional($.comment_text), $._end),
    attribute_rule: ($) =>
      seq(
        $._rule_start,
        field("pattern", $.pattern),
        repeat($._attribute),
        $._end,
      ),
    macro_definition: ($) =>
      seq(
        $._macro_start,
        choice(
          $._macro_name,
          seq(
            field("opening", $.quote_open),
            $._macro_name,
            field("closing", $.quote_close),
          ),
        ),
        repeat($._attribute),
        $._end,
      ),
    _macro_name: ($) =>
      seq(field("marker", $.macro_marker), field("name", $.attribute_name)),
    _attribute: ($) => seq($._separator, $.attribute),
    attribute: ($) =>
      seq(
        $._attribute_start,
        optional(
          field("modifier", choice($.unset_marker, $.unspecified_marker)),
        ),
        field("name", $.attribute_name),
        optional(
          seq(
            field("operator", $.assignment_operator),
            optional(field("value", $.attribute_value)),
          ),
        ),
        $._attribute_end,
      ),
    attribute_name: ($) =>
      seq(
        $._name_start,
        repeat1(choice($.name_text, $.quoted_escape)),
        $._name_end,
      ),
    attribute_value: ($) => seq($._value_start, $.value_text, $._value_end),
    pattern: ($) =>
      seq(
        choice(
          repeat1($._glob),
          seq(
            field("opening", $.quote_open),
            repeat($._glob),
            field("closing", $.quote_close),
          ),
        ),
        $._pattern_end,
      ),
    _glob: ($) =>
      choice(
        $.glob_literal,
        seq(
          $._glob_start,
          choice(
            $.wildcard,
            $.recursive_wildcard,
            $.single_character,
            $.path_separator,
            $.escape,
            $.quoted_escape,
            $.character_set,
          ),
        ),
      ),
    glob_literal: ($) => $._literal,
    character_set: ($) =>
      seq(
        field("opening", $.set_open),
        optional(field("negation", $.set_negation)),
        repeat($._set_item),
        field("closing", $.set_close),
      ),
    _set_item: ($) =>
      seq(
        $._set_item_start,
        choice(
          $.set_text,
          $.escape,
          $.quoted_escape,
          $.character_range,
          $.character_class,
        ),
      ),
    character_range: ($) =>
      seq(
        $._range_start,
        field("lower", $._endpoint),
        $.range_operator,
        field("upper", $._endpoint),
      ),
    _endpoint: ($) => choice($.range_character, $.escape, $.quoted_escape),
    character_class: ($) =>
      seq(
        alias($._compound_open, "["),
        alias($._class_open, ":"),
        repeat($._class_piece),
        alias($._class_close, ":"),
        alias($._compound_close, "]"),
      ),
    _class_piece: ($) => field("name", choice($.class_name, $.quoted_escape)),
  },
});
