#include "json.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

namespace engosoft::media::json {
namespace {

class Parser {
 public:
  explicit Parser(std::string_view text) : text_(text) {}

  bool ParseDocument(Value* out) {
    SkipWhitespace();
    if (!ParseValue(out, 0)) return false;
    SkipWhitespace();
    // Trailing content is an error, not something to ignore: two concatenated
    // documents in one message would otherwise silently become the first one.
    return pos_ == text_.size();
  }

 private:
  bool AtEnd() const { return pos_ >= text_.size(); }
  char Peek() const { return text_[pos_]; }

  void SkipWhitespace() {
    while (!AtEnd()) {
      const char c = text_[pos_];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
        ++pos_;
      } else {
        return;
      }
    }
  }

  bool Literal(std::string_view word) {
    if (text_.size() - pos_ < word.size()) return false;
    if (text_.compare(pos_, word.size(), word) != 0) return false;
    pos_ += word.size();
    return true;
  }

  bool ParseValue(Value* out, int depth) {
    if (depth > kMaxDepth) return false;
    if (AtEnd()) return false;

    switch (Peek()) {
      case 'n':
        if (!Literal("null")) return false;
        out->type = Value::Type::kNull;
        return true;
      case 't':
        if (!Literal("true")) return false;
        out->type = Value::Type::kBool;
        out->boolean = true;
        return true;
      case 'f':
        if (!Literal("false")) return false;
        out->type = Value::Type::kBool;
        out->boolean = false;
        return true;
      case '"':
        out->type = Value::Type::kString;
        return ParseString(&out->string);
      case '[':
        return ParseArray(out, depth);
      case '{':
        return ParseObject(out, depth);
      default:
        return ParseNumber(out);
    }
  }

  bool ParseArray(Value* out, int depth) {
    out->type = Value::Type::kArray;
    ++pos_;  // '['
    SkipWhitespace();
    if (!AtEnd() && Peek() == ']') {
      ++pos_;
      return true;
    }
    while (true) {
      auto element = std::make_shared<Value>();
      SkipWhitespace();
      if (!ParseValue(element.get(), depth + 1)) return false;
      out->array.push_back(std::move(element));
      SkipWhitespace();
      if (AtEnd()) return false;
      if (Peek() == ',') {
        ++pos_;
        continue;
      }
      if (Peek() == ']') {
        ++pos_;
        return true;
      }
      return false;
    }
  }

  bool ParseObject(Value* out, int depth) {
    out->type = Value::Type::kObject;
    ++pos_;  // '{'
    SkipWhitespace();
    if (!AtEnd() && Peek() == '}') {
      ++pos_;
      return true;
    }
    while (true) {
      SkipWhitespace();
      if (AtEnd() || Peek() != '"') return false;
      std::string key;
      if (!ParseString(&key)) return false;
      SkipWhitespace();
      if (AtEnd() || Peek() != ':') return false;
      ++pos_;
      SkipWhitespace();

      auto member = std::make_shared<Value>();
      if (!ParseValue(member.get(), depth + 1)) return false;
      // A duplicate key means the sender is confused or something is being
      // smuggled past a first-wins reader; refuse rather than pick.
      if (!out->object.emplace(std::move(key), std::move(member)).second) return false;

      SkipWhitespace();
      if (AtEnd()) return false;
      if (Peek() == ',') {
        ++pos_;
        continue;
      }
      if (Peek() == '}') {
        ++pos_;
        return true;
      }
      return false;
    }
  }

  // Appends `cp` to `out` as UTF-8.
  static void AppendUtf8(std::uint32_t cp, std::string* out) {
    if (cp <= 0x7F) {
      out->push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
      out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
      out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out->push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  bool ParseHex4(std::uint32_t* out) {
    if (text_.size() - pos_ < 4) return false;
    std::uint32_t value = 0;
    for (int i = 0; i < 4; ++i) {
      const char c = text_[pos_ + i];
      value <<= 4;
      if (c >= '0' && c <= '9') {
        value |= static_cast<std::uint32_t>(c - '0');
      } else if (c >= 'a' && c <= 'f') {
        value |= static_cast<std::uint32_t>(c - 'a' + 10);
      } else if (c >= 'A' && c <= 'F') {
        value |= static_cast<std::uint32_t>(c - 'A' + 10);
      } else {
        return false;
      }
    }
    pos_ += 4;
    *out = value;
    return true;
  }

  bool ParseString(std::string* out) {
    ++pos_;  // opening quote
    out->clear();
    while (true) {
      if (AtEnd()) return false;
      const unsigned char c = static_cast<unsigned char>(text_[pos_]);
      if (c == '"') {
        ++pos_;
        return true;
      }
      // Raw control characters are not legal inside a JSON string.
      if (c < 0x20) return false;
      if (c != '\\') {
        out->push_back(static_cast<char>(c));
        ++pos_;
        continue;
      }

      ++pos_;  // backslash
      if (AtEnd()) return false;
      const char esc = text_[pos_++];
      switch (esc) {
        case '"': out->push_back('"'); break;
        case '\\': out->push_back('\\'); break;
        case '/': out->push_back('/'); break;
        case 'b': out->push_back('\b'); break;
        case 'f': out->push_back('\f'); break;
        case 'n': out->push_back('\n'); break;
        case 'r': out->push_back('\r'); break;
        case 't': out->push_back('\t'); break;
        case 'u': {
          std::uint32_t cp = 0;
          if (!ParseHex4(&cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF) {
            // High surrogate: a low surrogate must follow, or the text is not
            // valid UTF-16 and we refuse rather than emit a lone surrogate.
            if (text_.size() - pos_ < 2 || text_[pos_] != '\\' || text_[pos_ + 1] != 'u') {
              return false;
            }
            pos_ += 2;
            std::uint32_t low = 0;
            if (!ParseHex4(&low)) return false;
            if (low < 0xDC00 || low > 0xDFFF) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
          } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            return false;  // lone low surrogate
          }
          AppendUtf8(cp, out);
          break;
        }
        default:
          return false;
      }
    }
  }

  bool ParseNumber(Value* out) {
    const std::size_t start = pos_;
    if (!AtEnd() && Peek() == '-') ++pos_;

    // Integer part: either a single 0 or a digit sequence not starting with 0.
    if (AtEnd()) return false;
    if (Peek() == '0') {
      ++pos_;
    } else if (Peek() >= '1' && Peek() <= '9') {
      while (!AtEnd() && Peek() >= '0' && Peek() <= '9') ++pos_;
    } else {
      return false;
    }

    if (!AtEnd() && Peek() == '.') {
      ++pos_;
      if (AtEnd() || Peek() < '0' || Peek() > '9') return false;
      while (!AtEnd() && Peek() >= '0' && Peek() <= '9') ++pos_;
    }

    if (!AtEnd() && (Peek() == 'e' || Peek() == 'E')) {
      ++pos_;
      if (!AtEnd() && (Peek() == '+' || Peek() == '-')) ++pos_;
      if (AtEnd() || Peek() < '0' || Peek() > '9') return false;
      while (!AtEnd() && Peek() >= '0' && Peek() <= '9') ++pos_;
    }

    // strtod needs a NUL-terminated buffer; the slice is short by construction.
    const std::string slice(text_.substr(start, pos_ - start));
    char* end = nullptr;
    const double parsed = std::strtod(slice.c_str(), &end);
    if (end != slice.c_str() + slice.size()) return false;
    if (!std::isfinite(parsed)) return false;

    out->type = Value::Type::kNumber;
    out->number = parsed;
    return true;
  }

  std::string_view text_;
  std::size_t pos_ = 0;
};

}  // namespace

const Value* Value::Find(std::string_view key) const {
  if (type != Type::kObject) return nullptr;
  const auto it = object.find(std::string(key));
  if (it == object.end() || !it->second) return nullptr;
  return it->second.get();
}

std::string Value::StringOr(std::string_view key, std::string fallback) const {
  const Value* member = Find(key);
  if (member == nullptr || !member->is_string()) return fallback;
  return member->string;
}

int Value::IntOr(std::string_view key, int fallback) const {
  const std::int64_t wide = Int64Or(key, fallback);
  if (wide < INT32_MIN || wide > INT32_MAX) return fallback;
  return static_cast<int>(wide);
}

std::int64_t Value::Int64Or(std::string_view key, std::int64_t fallback) const {
  const Value* member = Find(key);
  if (member == nullptr || !member->is_number()) return fallback;
  const double v = member->number;
  // Anything outside the exactly-representable integer range would round on
  // conversion, so it is refused rather than silently altered.
  if (v < -9007199254740992.0 || v > 9007199254740992.0) return fallback;
  return static_cast<std::int64_t>(v);
}

bool Value::BoolOr(std::string_view key, bool fallback) const {
  const Value* member = Find(key);
  if (member == nullptr || !member->is_bool()) return fallback;
  return member->boolean;
}

std::string Value::TakeString(std::string_view key) {
  if (type != Type::kObject) return {};
  const auto it = object.find(std::string(key));
  if (it == object.end() || !it->second || !it->second->is_string()) return {};
  std::string taken = std::move(it->second->string);
  // The move leaves the source unspecified rather than empty, so clear it and
  // then overwrite the capacity it may still hold.
  ScrubString(it->second->string);
  return taken;
}

void ScrubString(std::string& s) {
  if (!s.empty()) {
    volatile char* p = const_cast<volatile char*>(s.data());
    for (std::size_t i = 0; i < s.size(); ++i) p[i] = '\0';
  }
  s.clear();
  s.shrink_to_fit();
}

void Scrub(Value& value) {
  ScrubString(value.string);
  for (auto& element : value.array) {
    if (element) Scrub(*element);
  }
  for (auto& [key, member] : value.object) {
    (void)key;
    if (member) Scrub(*member);
  }
}

std::optional<Value> Parse(std::string_view text) {
  if (text.size() > kMaxDocumentBytes) return std::nullopt;
  Value root;
  Parser parser(text);
  if (!parser.ParseDocument(&root)) {
    Scrub(root);  // a partial tree may already hold token bytes
    return std::nullopt;
  }
  return root;
}

}  // namespace engosoft::media::json
