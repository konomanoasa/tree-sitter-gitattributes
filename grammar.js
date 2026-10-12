const missingKinds = (name) => [
  [`missing_${name}`, "invalid_syntax", `missing_${name}`],
  [`incomplete_${name}`, "incomplete_syntax", `missing_${name}`],
];
const issueKinds = [
  ...missingKinds("set_close"),
  ["invalid_encoding", "invalid_syntax", "invalid_encoding"],
  ["negative_pattern", "invalid_syntax", "negative_pattern"],
  ["ended_escape", "invalid_syntax", "incomplete_escape"],
  ["incomplete_escape", "incomplete_syntax", "incomplete_escape"],
  ["invalid_quoted_escape", "invalid_syntax", "invalid_quoted_escape"],
  ["ended_quoted_escape", "invalid_syntax", "incomplete_quoted_escape"],
  ["incomplete_quoted_escape", "incomplete_syntax", "incomplete_quoted_escape"],
  ...missingKinds("quote_close"),
  [
    "missing_attribute_separator",
    "invalid_syntax",
    "missing_attribute_separator",
  ],
  ...missingKinds("attribute_name"),
  ["invalid_name_character", "invalid_syntax", "invalid_name_character"],
  ["incomplete_name_character", "incomplete_syntax", "invalid_name_character"],
  [
    "invalid_name_escape",
    "invalid_syntax",
    "invalid_name_character",
    "quoted_escape",
  ],
];
const quotedEscapeIssues = [
  "invalid_quoted_escape",
  "ended_quoted_escape",
  "incomplete_quoted_escape",
];

const issueRules = Object.fromEntries(
  issueKinds.flatMap(([token, outcome, reason, child]) => [
    ...(child
      ? [[`_${token}_reason`, ($) => alias($[`_${token}`], $[child])]]
      : []),
    [
      `_${token}_outcome`,
      ($) => alias($[child ? `_${token}_reason` : `_${token}`], $[reason]),
    ],
    [`_${token}_issue`, ($) => alias($[`_${token}_outcome`], $[outcome])],
  ]),
);
const issue = ($, name) =>
  field("issue", alias($[`_${name}_issue`], $.syntax_issue));
const issues = ($, ...names) => names.map((name) => issue($, name));
const missing = ($, name) =>
  choice(issue($, `missing_${name}`), issue($, `incomplete_${name}`));
const heldPrefix = ($, ...names) =>
  seq($._escape_prefix, choice(...issues($, ...names)));
const quoteClose = ($) =>
  optional(choice(field("closing", $.quote_close), missing($, "quote_close")));
const attributeName = ($) =>
  choice(field("name", $.attribute_name), missing($, "attribute_name"));
const globIssues = ($) => [
  ...issues(
    $,
    "invalid_encoding",
    "ended_escape",
    "incomplete_escape",
    ...quotedEscapeIssues,
  ),
  heldPrefix($, "invalid_encoding", ...quotedEscapeIssues),
];

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
    $._escape_prefix,
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
    ...issueKinds.map(([name]) => $[`_${name}`]),
    $._error_sentinel,
  ],
  extras: () => [],
  rules: {
    document: ($) =>
      repeat(
        seq(
          $._line_start,
          choice($.blank_line, $.comment, $.attribute_rule, $.macro_definition),
        ),
      ),
    line_ending: () => /\r?\n/,
    _end: ($) => seq(optional($._layout), choice($.line_ending, $._eof)),
    blank_line: ($) => seq($._blank_start, $._end),
    comment: ($) =>
      seq(
        $._comment_start,
        $.comment_marker,
        repeat(choice($.comment_text, issue($, "invalid_encoding"))),
        $._end,
      ),
    attribute_rule: ($) =>
      seq(
        $._rule_start,
        field("pattern", $.pattern),
        optional($._attributes),
        $._end,
      ),
    macro_definition: ($) =>
      seq(
        $._macro_start,
        optional(field("opening", $.quote_open)),
        field("marker", $.macro_marker),
        attributeName($),
        quoteClose($),
        optional($._attributes),
        $._end,
      ),
    _attributes: ($) =>
      repeat1(
        seq(
          choice($._separator, issue($, "missing_attribute_separator")),
          $.attribute,
        ),
      ),
    attribute: ($) =>
      seq(
        $._attribute_start,
        optional(
          field("modifier", choice($.unset_marker, $.unspecified_marker)),
        ),
        attributeName($),
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
        repeat1(
          choice(
            $.name_text,
            $.quoted_escape,
            ...issues(
              $,
              "invalid_encoding",
              "invalid_name_character",
              "incomplete_name_character",
              "invalid_name_escape",
              ...quotedEscapeIssues,
            ),
            heldPrefix($, "invalid_encoding"),
          ),
        ),
        $._name_end,
      ),
    attribute_value: ($) =>
      seq(
        $._value_start,
        repeat1(choice($.value_text, issue($, "invalid_encoding"))),
        $._value_end,
      ),
    pattern: ($) =>
      seq(
        optional(field("opening", $.quote_open)),
        repeat(
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
                issue($, "negative_pattern"),
                ...globIssues($),
              ),
            ),
          ),
        ),
        quoteClose($),
        $._pattern_end,
      ),
    glob_literal: ($) => $._literal,
    character_set: ($) =>
      seq(
        field("opening", $.set_open),
        optional(field("negation", $.set_negation)),
        repeat(
          seq(
            $._set_item_start,
            choice(
              $.set_text,
              $.escape,
              $.quoted_escape,
              $.character_range,
              $.character_class,
              ...globIssues($),
            ),
          ),
        ),
        choice(field("closing", $.set_close), missing($, "set_close")),
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
        repeat(
          choice(
            field("name", choice($.class_name, $.quoted_escape)),
            ...issues(
              $,
              "invalid_encoding",
              "invalid_quoted_escape",
              "ended_quoted_escape",
            ),
            heldPrefix($, "invalid_encoding"),
          ),
        ),
        alias($._class_close, ":"),
        alias($._compound_close, "]"),
      ),
    ...issueRules,
  },
});
