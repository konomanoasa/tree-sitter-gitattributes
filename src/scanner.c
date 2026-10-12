#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"
#include <string.h>

enum Token {
  LINE_START,
  BLANK_START,
  COMMENT_START,
  RULE_START,
  MACRO_START,
  END_OF_FILE,
  LAYOUT,
  SEPARATOR,
  ATTRIBUTE_START,
  ATTRIBUTE_END,
  NAME_START,
  NAME_END,
  VALUE_START,
  VALUE_END,
  PATTERN_END,
  GLOB_START,
  SET_ITEM_START,
  COMMENT_MARKER,
  COMMENT_TEXT,
  MACRO_MARKER,
  UNSET_MARKER,
  UNSPECIFIED_MARKER,
  ASSIGNMENT_OPERATOR,
  NAME_TEXT,
  VALUE_TEXT,
  QUOTE_OPEN,
  QUOTE_CLOSE,
  LITERAL,
  WILDCARD,
  RECURSIVE_WILDCARD,
  SINGLE_CHARACTER,
  PATH_SEPARATOR,
  ESCAPE,
  QUOTED_ESCAPE,
  ESCAPE_PREFIX,
  SET_OPEN,
  SET_NEGATION,
  SET_TEXT,
  SET_CLOSE,
  RANGE_START,
  RANGE_CHARACTER,
  RANGE_OPERATOR,
  COMPOUND_OPEN,
  COMPOUND_CLOSE,
  CLASS_OPEN,
  CLASS_NAME,
  CLASS_CLOSE,
  MISSING_SET_CLOSE,
  INCOMPLETE_SET_CLOSE,
  INVALID_ENCODING,
  NEGATIVE_PATTERN,
  ENDED_ESCAPE,
  INCOMPLETE_ESCAPE,
  INVALID_QUOTED_ESCAPE,
  ENDED_QUOTED_ESCAPE,
  INCOMPLETE_QUOTED_ESCAPE,
  MISSING_QUOTE_CLOSE,
  INCOMPLETE_QUOTE_CLOSE,
  MISSING_ATTRIBUTE_SEPARATOR,
  MISSING_ATTRIBUTE_NAME,
  INCOMPLETE_ATTRIBUTE_NAME,
  INVALID_NAME_CHARACTER,
  INCOMPLETE_NAME_CHARACTER,
  INVALID_NAME_ESCAPE,
  ERROR_SENTINEL
};

#define NONE UINT32_MAX

enum { DECODE_ERROR = -1, CURSOR_END = -2, INVALID_UNIT = -3 };

typedef struct {
  uint32_t kind, end;
} Item;

// Class bounds include brackets; inner bounds exclude both colons.
typedef struct {
  uint32_t start, opening_end, closing_start, end;
} Class;

// Positions are line-relative character offsets.
typedef struct {
  uint32_t position, leading, line_end, content_end;
  uint32_t token_end, name_start, name_end;
  uint32_t next_end, prefix_end, set_end, set_close_end;
  Class class;
  uint32_t lower_end, range_operator_end, upper_end;
  uint8_t kind, next, prefix_kind, lower_kind, upper_kind;
  uint8_t quoted, component_start, after_separator;
} Scanner;

typedef char scanner_fits_buffer
  [sizeof(Scanner) <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE ? 1 : -1];

typedef struct {
  const Scanner *s;
  TSLexer *lexer;
  uint32_t raw, limit, start, end, kind;
  int32_t c;
} Cursor;

static bool whitespace(int32_t c) {
  return c == ' ' || c == '\t' || c == '\r';
}

static bool alphanumeric(int32_t c) {
  return (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9');
}

static bool name_character(int32_t c, bool first) {
  return alphanumeric(c) || c == '_' || c == '.' || (!first && c == '-');
}

static void advance(Scanner *s, TSLexer *lexer) {
  lexer->advance(lexer, false);
  s->position++;
}

static bool emit(TSLexer *lexer, const bool *valid, enum Token token) {
  if (!valid[token]) return false;
  lexer->result_symbol = token;
  return true;
}

static enum Token
absent(TSLexer *lexer, enum Token missing, enum Token incomplete) {
  return lexer->eof(lexer) ? incomplete : missing;
}

// Include the next decoded character so edits invalidate the run.
static bool invalid_run(Scanner *s, TSLexer *lexer, const bool *valid) {
  do advance(s, lexer);
  while (!lexer->eof(lexer) && lexer->lookahead == DECODE_ERROR);
  lexer->mark_end(lexer);
  if (!lexer->eof(lexer)) lexer->advance(lexer, false);
  return emit(lexer, valid, INVALID_ENCODING);
}

static bool consume(
  Scanner *s,
  TSLexer *lexer,
  const bool *valid,
  enum Token token,
  uint32_t end
) {
  if (token == INVALID_ENCODING) return invalid_run(s, lexer, valid);
  while (s->position < end) advance(s, lexer);
  lexer->mark_end(lexer);
  return emit(lexer, valid, token);
}

static bool text_run(
  Scanner *s,
  TSLexer *lexer,
  const bool *valid,
  enum Token token,
  uint32_t end
) {
  if (lexer->lookahead == DECODE_ERROR) return invalid_run(s, lexer, valid);
  while (s->position < end && lexer->lookahead != DECODE_ERROR)
    advance(s, lexer);
  lexer->mark_end(lexer);
  return emit(lexer, valid, token);
}

static void raw_step(Cursor *r) {
  r->lexer->advance(r->lexer, false);
  r->raw++;
}

static int32_t simple_escape(int32_t c) {
  switch (c) {
    case 'a':
      return '\a';
    case 'b':
      return '\b';
    case 't':
      return '\t';
    case 'n':
      return '\n';
    case 'v':
      return '\v';
    case 'f':
      return '\f';
    case 'r':
      return '\r';
    case '\\':
    case '"':
      return c;
    default:
      return INVALID_UNIT;
  }
}

// The cursor has passed the backslash.
static void quoted_escape(Cursor *r) {
  const int32_t c = r->lexer->lookahead;
  r->kind = QUOTED_ESCAPE;
  if (r->raw >= r->limit) {
    r->c = INVALID_UNIT;
    r->kind = absent(r->lexer, ENDED_QUOTED_ESCAPE, INCOMPLETE_QUOTED_ESCAPE);
  } else if (c == DECODE_ERROR) {
    r->c = INVALID_UNIT;
    r->kind = ESCAPE_PREFIX;
  } else if (c >= '0' && c <= '3') {
    int32_t value = 0;
    unsigned digits = 0;
    while (digits < 3 && r->raw < r->limit) {
      const int32_t digit = r->lexer->lookahead;
      if (digit < '0' || digit > '7') break;
      value = value * 8 + digit - '0';
      raw_step(r);
      digits++;
    }
    if (digits == 3) r->c = value;
    else {
      r->c = INVALID_UNIT;
      r->kind = r->raw == r->limit
        ? absent(r->lexer, ENDED_QUOTED_ESCAPE, INCOMPLETE_QUOTED_ESCAPE)
        : ENDED_QUOTED_ESCAPE;
    }
  } else {
    raw_step(r);
    r->c = simple_escape(c);
    if (r->c == INVALID_UNIT) r->kind = INVALID_QUOTED_ESCAPE;
  }
}

static void step(Cursor *r) {
  r->start = r->end = r->raw;
  r->kind = 0;
  r->c = CURSOR_END;
  if (r->raw >= r->limit) return;
  const int32_t c = r->lexer->lookahead;
  raw_step(r);
  r->c = c;
  if (c == DECODE_ERROR) {
    r->kind = INVALID_ENCODING;
    while (r->raw < r->limit && r->lexer->lookahead == DECODE_ERROR)
      raw_step(r);
  } else if (r->s->quoted && r->start < r->s->content_end && c == '\\')
    quoted_escape(r);
  r->end = r->raw;
}

static uint32_t content_start(const Scanner *s) {
  return s->leading + s->quoted;
}

static Cursor cursor(const Scanner *s, TSLexer *lexer, uint32_t limit) {
  Cursor r = {.s = s, .lexer = lexer, .raw = s->position, .limit = limit};
  step(&r);
  return r;
}

static bool start_line(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (lexer->eof(lexer)) return false;
  memset(s, 0, sizeof(*s));
  s->class.start = NONE;
  s->component_start = true;
  int32_t last = 0;
  lexer->mark_end(lexer);
  while (!lexer->eof(lexer) && whitespace(lexer->lookahead)) {
    last = lexer->lookahead;
    advance(s, lexer);
  }
  s->leading = s->position;
  s->kind = lexer->lookahead == '#' ? COMMENT_START : RULE_START;
  s->quoted = lexer->lookahead == '"';
  const uint32_t start = content_start(s);
  s->content_end = NONE;
  bool escaped = false;
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    const int32_t c = lexer->lookahead;
    if (s->position >= start && s->content_end == NONE) {
      if (s->quoted) {
        if (c == '"' && !escaped) s->content_end = s->position;
        escaped = c == '\\' && !escaped;
      } else if (whitespace(c)) s->content_end = s->position;
    }
    last = c;
    advance(s, lexer);
  }
  s->line_end = s->position;
  if (last == '\r' && lexer->lookahead == '\n') s->line_end--;
  if (s->leading > s->line_end) s->leading = s->line_end;
  if (s->content_end == NONE) s->content_end = s->line_end;
  if (s->leading >= s->line_end) s->kind = BLANK_START;
  s->position = 0;
  return emit(lexer, valid, LINE_START);
}

static bool start_content(Scanner *s, TSLexer *lexer, const bool *valid) {
  while (s->position < s->leading) advance(s, lexer);
  lexer->mark_end(lexer);
  if (s->kind == RULE_START) {
    // The opening quote is lookahead; QUOTE_OPEN consumes it later.
    if (s->quoted) lexer->advance(lexer, false);
    Cursor r = {
      .s = s,
      .lexer = lexer,
      .raw = content_start(s),
      .limit = s->content_end
    };
    static const char marker[] = "[attr]";
    bool macro = true;
    for (unsigned i = 0; i < sizeof(marker) - 1; i++) {
      step(&r);
      if (r.c != marker[i]) {
        macro = false;
        break;
      }
    }
    if (macro) {
      s->kind = MACRO_START;
      s->name_start = r.end;
      s->name_end = s->content_end;
    }
  }
  return emit(lexer, valid, (enum Token)s->kind);
}

static void skip_escaped(Cursor *r, Cursor *last, uint32_t *candidate) {
  *last = *r;
  if (r->c == ']') *candidate = NONE;
  step(r);
}

static bool next_class(Cursor *r, bool lower, Class *class) {
  Class a = {NONE, 0, 0, 0};
  Cursor last = *r;
  while (r->c != CURSOR_END) {
    const int32_t here = r->c;
    if (here == ']') {
      if (a.start == NONE || last.c != ':' || last.end == a.opening_end)
        return false;
      a.closing_start = last.start;
      a.end = r->end;
      step(r);
      *class = a;
      return true;
    }
    last = *r;
    step(r);
    if (here == '\\') {
      lower = r->c >= 0;
      if (r->c != CURSOR_END) skip_escaped(r, &last, &a.start);
      continue;
    }
    if (here == '-' && lower && r->c != CURSOR_END && r->c != ']') {
      const int32_t upper = r->c;
      skip_escaped(r, &last, &a.start);
      if (upper == '\\' && r->c != CURSOR_END) skip_escaped(r, &last, &a.start);
      lower = false;
      continue;
    }
    lower = here >= 0;
    if (a.start == NONE && here == '[' && r->c == ':') {
      a.start = last.start;
      a.opening_end = r->end;
    }
  }
  return false;
}

static void find_set(Scanner *s, Cursor *r) {
  s->set_end = s->set_close_end = s->content_end;
  s->class.start = NONE;
  if (r->c == '!' || r->c == '^') step(r);
  bool lower = r->c == ']';
  if (lower) step(r);
  Class class;
  while (next_class(r, lower, &class)) {
    lower = false;
    if (s->class.start == NONE) s->class = class;
  }
  if (r->c == ']') {
    s->set_end = r->start;
    s->set_close_end = r->end;
  }
}

static Item item(Cursor *r) {
  Item a = {SET_TEXT, 0};
  const int32_t c = r->c;
  const uint32_t end = r->end;
  if (c == '[' && r->start == r->s->class.start) {
    a = (Item){CLASS_OPEN, r->s->class.end};
    while (r->c != CURSOR_END && r->start < a.end) step(r);
    return a;
  }
  if (r->kind) a.kind = r->kind;
  step(r);
  if (c == '\\') {
    if (r->c == CURSOR_END)
      a.kind = absent(r->lexer, ENDED_ESCAPE, INCOMPLETE_ESCAPE);
    else if (r->c < 0) a.kind = ESCAPE_PREFIX;
    else {
      a.kind = ESCAPE;
      a.end = r->end;
      step(r);
      return a;
    }
  }
  a.end = end;
  return a;
}

static bool endpoint(Item a) {
  return a.kind == SET_TEXT || a.kind == ESCAPE || a.kind == QUOTED_ESCAPE;
}

static bool literal_boundary(const Cursor *r) {
  if (r->c < 0 || r->kind == QUOTED_ESCAPE) return true;
  const int32_t c = r->c;
  return c == '\\' || c == '*' || c == '?' || c == '/' || c == '[';
}

static void hold_prefix(Scanner *s, Cursor *r, uint32_t prefix_end) {
  s->next = ESCAPE_PREFIX;
  s->prefix_end = prefix_end;
  s->prefix_kind = r->kind;
  if (r->kind == ESCAPE_PREFIX) {
    s->prefix_end = r->end;
    s->prefix_kind = INVALID_ENCODING;
    step(r);
  }
  s->next_end = r->end;
}

// Consume lookahead units fully so edits inside them invalidate the decision.
static bool prepare_glob(Scanner *s, TSLexer *lexer, const bool *valid) {
  Cursor r = cursor(s, lexer, s->content_end);
  bool separator = r.c == '/';
  const uint32_t start = s->position;
  s->next_end = r.end;
  if (r.c < 0) {
    if (r.kind == ESCAPE_PREFIX) hold_prefix(s, &r, r.end);
    else s->next = r.kind;
  } else if (r.c == '!' && start == content_start(s))
    s->next = NEGATIVE_PATTERN;
  else if (r.c == '?') s->next = SINGLE_CHARACTER;
  else if (r.c == '/') s->next = PATH_SEPARATOR;
  else if (r.c == '\\') {
    step(&r);
    if (r.c == CURSOR_END)
      s->next = absent(lexer, ENDED_ESCAPE, INCOMPLETE_ESCAPE);
    else if (r.c < 0) hold_prefix(s, &r, s->next_end);
    else {
      s->next = ESCAPE;
      s->next_end = r.end;
      separator = r.c == '/';
    }
  } else if (r.c == '*') {
    unsigned count = 0;
    while (r.c == '*') {
      count++;
      s->next_end = r.end;
      step(&r);
    }
    const bool pair = count == 2 && s->component_start;
    const bool tail = r.c == CURSOR_END && s->after_separator;
    if (r.c == '\\') step(&r);
    const bool slash = r.c == '/';
    s->next = pair && (slash || tail) ? RECURSIVE_WILDCARD : WILDCARD;
  } else if (r.kind == QUOTED_ESCAPE && r.c != '[') s->next = QUOTED_ESCAPE;
  else if (r.c == '[') {
    s->next = SET_OPEN;
    step(&r);
    find_set(s, &r);
  } else {
    uint32_t end = r.end;
    lexer->mark_end(lexer);
    step(&r);
    while (!literal_boundary(&r)) {
      end = r.end;
      lexer->mark_end(lexer);
      step(&r);
    }
    s->position = end;
    s->component_start = false;
    return emit(lexer, valid, LITERAL);
  }
  s->component_start = separator || s->next == NEGATIVE_PATTERN;
  if (separator) s->after_separator = true;
  return emit(lexer, valid, GLOB_START);
}

static bool prepare_set(Scanner *s, TSLexer *lexer, const bool *valid) {
  Cursor r = cursor(s, lexer, s->set_end);
  const uint32_t start = s->position;
  if (valid[SET_NEGATION] && (r.c == '!' || r.c == '^')) {
    s->position = r.end;
    lexer->mark_end(lexer);
    return emit(lexer, valid, SET_NEGATION);
  }
  s->next = SET_TEXT;
  s->next_end = start;
  Item current = item(&r);
  for (;;) {
    if (endpoint(current) && r.c == '-' && r.end < s->set_end) {
      const uint32_t operator_end = r.end;
      const bool plain_operator = r.kind != QUOTED_ESCAPE;
      step(&r);
      const Item upper = item(&r);
      if (endpoint(upper)) {
        if (s->next_end == start) {
          s->next = RANGE_START;
          s->lower_kind = current.kind;
          s->lower_end = current.end;
          s->range_operator_end = operator_end;
          s->upper_kind = upper.kind;
          s->upper_end = upper.end;
        }
        break;
      }
      if (current.kind == SET_TEXT) {
        if (!plain_operator) {
          s->next_end = current.end;
          break;
        }
        s->next_end = operator_end;
        current = upper;
        continue;
      }
    }
    if (current.kind != SET_TEXT) {
      if (s->next_end == start) {
        s->next = current.kind;
        s->next_end = current.end;
        if (current.kind == ESCAPE_PREFIX) hold_prefix(s, &r, current.end);
      }
      break;
    }
    s->next_end = current.end;
    if (r.c == CURSOR_END) break;
    current = item(&r);
  }
  return emit(lexer, valid, SET_ITEM_START);
}

static bool class_delimiter(
  Scanner *s,
  TSLexer *lexer,
  const bool *valid,
  enum Token token
) {
  Cursor r = cursor(s, lexer, s->class.end);
  s->position = r.end;
  lexer->mark_end(lexer);
  return emit(lexer, valid, token);
}

static bool class_piece(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (s->position < s->class.opening_end)
    return consume(s, lexer, valid, CLASS_OPEN, s->class.opening_end);
  if (s->position == s->class.closing_start)
    return class_delimiter(s, lexer, valid, CLASS_CLOSE);
  if (s->position > s->class.closing_start) {
    while (s->position < s->class.end) advance(s, lexer);
    lexer->mark_end(lexer);
    Cursor r = cursor(s, lexer, s->set_end);
    if (!next_class(&r, false, &s->class)) s->class.start = NONE;
    return emit(lexer, valid, COMPOUND_CLOSE);
  }
  if (lexer->lookahead == DECODE_ERROR) return invalid_run(s, lexer, valid);
  Cursor r = cursor(s, lexer, s->class.closing_start);
  const enum Token token = r.kind ? (enum Token)r.kind : CLASS_NAME;
  uint32_t end = r.end;
  lexer->mark_end(lexer);
  if (token == CLASS_NAME) {
    step(&r);
    while (r.c >= 0 && !r.kind) {
      end = r.end;
      lexer->mark_end(lexer);
      step(&r);
    }
  }
  s->position = end;
  return emit(lexer, valid, token);
}

static bool range_piece(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (s->position == s->lower_end)
    return consume(s, lexer, valid, RANGE_OPERATOR, s->range_operator_end);
  const bool lower = s->position < s->lower_end;
  const enum Token kind = (enum Token)(lower ? s->lower_kind : s->upper_kind);
  return consume(
    s,
    lexer,
    valid,
    kind == SET_TEXT ? RANGE_CHARACTER : kind,
    lower ? s->lower_end : s->upper_end
  );
}

static enum Token name_token(const Cursor *r, bool first) {
  if (r->c < 0) return (enum Token)r->kind;
  if (!r->kind && r->c == '\r' && r->lexer->eof(r->lexer))
    return INCOMPLETE_NAME_CHARACTER;
  if (!name_character(r->c, first))
    return r->kind == QUOTED_ESCAPE ? INVALID_NAME_ESCAPE
                                    : INVALID_NAME_CHARACTER;
  return r->kind == QUOTED_ESCAPE ? QUOTED_ESCAPE : NAME_TEXT;
}

static bool name_piece(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (lexer->lookahead == DECODE_ERROR) return invalid_run(s, lexer, valid);
  Cursor r = cursor(s, lexer, s->name_end);
  if (r.kind == ESCAPE_PREFIX) s->next = INVALID_ENCODING;
  const enum Token token = name_token(&r, s->position == s->name_start);
  uint32_t end = r.end;
  lexer->mark_end(lexer);
  if (token == NAME_TEXT || token == INVALID_NAME_CHARACTER) {
    step(&r);
    while (name_token(&r, false) == token) {
      end = r.end;
      lexer->mark_end(lexer);
      step(&r);
    }
  }
  s->position = end;
  return emit(lexer, valid, token);
}

static bool prepare_attribute(Scanner *s, TSLexer *lexer, const bool *valid) {
  Cursor r = cursor(s, lexer, s->line_end);
  const bool modified = r.c == '-' || r.c == '!';
  s->name_start = s->position + (modified ? 1 : 0);
  s->name_end = NONE;
  while (r.c != CURSOR_END && !whitespace(r.c)) {
    if (r.c == '=' && s->name_end == NONE) s->name_end = r.start;
    step(&r);
  }
  s->token_end = r.start;
  if (s->name_end == NONE) s->name_end = r.start;
  return emit(lexer, valid, ATTRIBUTE_START);
}

static bool scan(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (valid[ERROR_SENTINEL]) return false;
  if (valid[LINE_START]) return start_line(s, lexer, valid);
  if (
    valid[BLANK_START] ||
    valid[COMMENT_START] ||
    valid[RULE_START] ||
    valid[MACRO_START]
  )
    return start_content(s, lexer, valid);
  lexer->mark_end(lexer);
  if (
    (valid[SET_CLOSE] ||
      valid[MISSING_SET_CLOSE] ||
      valid[INCOMPLETE_SET_CLOSE]) &&
    s->position == s->set_end
  ) {
    if (s->set_close_end > s->set_end)
      return consume(s, lexer, valid, SET_CLOSE, s->set_close_end);
    return emit(
      lexer,
      valid,
      absent(lexer, MISSING_SET_CLOSE, INCOMPLETE_SET_CLOSE)
    );
  }
  if (valid[ATTRIBUTE_START]) return prepare_attribute(s, lexer, valid);
  if (valid[ATTRIBUTE_END] && s->position == s->token_end)
    return emit(lexer, valid, ATTRIBUTE_END);
  const bool at_name =
    s->position == s->name_start && s->position < s->name_end;
  if (valid[NAME_START] && at_name) return emit(lexer, valid, NAME_START);
  if (valid[NAME_END] && s->position == s->name_end)
    return emit(lexer, valid, NAME_END);
  if (valid[VALUE_START] && s->position < s->token_end)
    return emit(lexer, valid, VALUE_START);
  if (valid[VALUE_END] && s->position == s->token_end)
    return emit(lexer, valid, VALUE_END);
  if (valid[MISSING_ATTRIBUTE_NAME] && s->position == s->name_end)
    return emit(
      lexer,
      valid,
      absent(lexer, MISSING_ATTRIBUTE_NAME, INCOMPLETE_ATTRIBUTE_NAME)
    );
  if (
    (valid[UNSET_MARKER] || valid[UNSPECIFIED_MARKER]) &&
    s->position < s->name_start
  )
    return consume(
      s,
      lexer,
      valid,
      lexer->lookahead == '-' ? UNSET_MARKER : UNSPECIFIED_MARKER,
      s->position + 1
    );
  if (valid[NAME_TEXT]) return name_piece(s, lexer, valid);
  if (valid[VALUE_TEXT])
    return text_run(s, lexer, valid, VALUE_TEXT, s->token_end);
  if (valid[ASSIGNMENT_OPERATOR] && lexer->lookahead == '=')
    return consume(s, lexer, valid, ASSIGNMENT_OPERATOR, s->position + 1);
  if (
    (valid[QUOTE_CLOSE] || valid[MISSING_QUOTE_CLOSE]) &&
    s->quoted &&
    s->position == s->content_end
  ) {
    if (s->content_end < s->line_end)
      return consume(s, lexer, valid, QUOTE_CLOSE, s->position + 1);
    return emit(
      lexer,
      valid,
      absent(lexer, MISSING_QUOTE_CLOSE, INCOMPLETE_QUOTE_CLOSE)
    );
  }
  if (valid[PATTERN_END] && s->position >= s->content_end)
    return emit(lexer, valid, PATTERN_END);
  if (s->position >= s->line_end)
    return lexer->eof(lexer) && emit(lexer, valid, END_OF_FILE);
  if (s->kind == COMMENT_START) {
    if (s->position == s->leading)
      return consume(s, lexer, valid, COMMENT_MARKER, s->position + 1);
    return text_run(s, lexer, valid, COMMENT_TEXT, s->line_end);
  }
  if (valid[QUOTE_OPEN] && s->quoted && s->position == s->leading)
    return consume(s, lexer, valid, QUOTE_OPEN, s->position + 1);
  if (valid[MACRO_MARKER])
    return consume(s, lexer, valid, MACRO_MARKER, s->name_start);
  if (valid[SEPARATOR] || valid[LAYOUT]) {
    if (!whitespace(lexer->lookahead))
      return emit(lexer, valid, MISSING_ATTRIBUTE_SEPARATOR);
    while (s->position < s->line_end && whitespace(lexer->lookahead))
      advance(s, lexer);
    lexer->mark_end(lexer);
    return emit(lexer, valid, s->position < s->line_end ? SEPARATOR : LAYOUT);
  }
  if (valid[GLOB_START]) return prepare_glob(s, lexer, valid);
  if (valid[SET_ITEM_START] || valid[SET_NEGATION])
    return prepare_set(s, lexer, valid);
  if (s->class.start < s->position && s->position < s->class.end)
    return class_piece(s, lexer, valid);
  if (s->next == RANGE_START) {
    s->next = RANGE_CHARACTER;
    return emit(lexer, valid, RANGE_START);
  }
  if (s->upper_end > s->position) return range_piece(s, lexer, valid);
  const enum Token token = (enum Token)s->next;
  if (token == CLASS_OPEN)
    return class_delimiter(s, lexer, valid, COMPOUND_OPEN);
  if (token == ESCAPE_PREFIX) {
    s->next = s->prefix_kind;
    return consume(s, lexer, valid, token, s->prefix_end);
  }
  return consume(s, lexer, valid, token, s->next_end);
}

void *tree_sitter_gitattributes_external_scanner_create(void) {
  return ts_calloc(1, sizeof(Scanner));
}

void tree_sitter_gitattributes_external_scanner_destroy(void *payload) {
  ts_free(payload);
}

unsigned tree_sitter_gitattributes_external_scanner_serialize(
  void *payload,
  char *buffer
) {
  memcpy(buffer, payload, sizeof(Scanner));
  return sizeof(Scanner);
}

void tree_sitter_gitattributes_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  memset(payload, 0, sizeof(Scanner));
  if (length == sizeof(Scanner)) memcpy(payload, buffer, length);
}

bool tree_sitter_gitattributes_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid
) {
  Scanner next = *(Scanner *)payload;
  if (!scan(&next, lexer, valid)) return false;
  *(Scanner *)payload = next;
  return true;
}
