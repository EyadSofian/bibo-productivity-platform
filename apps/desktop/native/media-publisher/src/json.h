// json.h — a small, strict JSON reader for the IPC protocol.
//
// Why not a library: the sidecar links no third-party code beyond the LiveKit
// SDK, and the message set in docs/ipc-protocol.md is a handful of flat objects.
// A vendored general-purpose parser would be far more code than the protocol it
// serves. Writing is already hand-rolled in metrics.cpp; this is the read half.
//
// Strictness is deliberate. Every malformed input yields std::nullopt rather
// than a partial tree: the pipe carries a publisher token, and a parser that
// guesses at broken input is a parser that can be steered.
//
// TOKEN HANDLING. TakeString() moves a value out and zeroes the source bytes,
// so the token exists in exactly one place after extraction. Destroy() zeroes
// every string in a tree before it is released.

#ifndef ENGOSOFT_MEDIA_PUBLISHER_JSON_H_
#define ENGOSOFT_MEDIA_PUBLISHER_JSON_H_

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace engosoft::media::json {

class Value;
using ValuePtr = std::shared_ptr<Value>;

// Nesting deeper than this is rejected. The protocol's deepest message is three
// levels (envelope → payload → video), so the limit is far above anything
// legitimate and well below what would exhaust the stack.
inline constexpr int kMaxDepth = 16;

// Inputs larger than this are rejected before parsing. A publisher JWT is ~1 KB;
// nothing in the protocol approaches this.
inline constexpr std::size_t kMaxDocumentBytes = 256 * 1024;

class Value {
 public:
  enum class Type { kNull, kBool, kNumber, kString, kArray, kObject };

  Type type = Type::kNull;
  bool boolean = false;
  double number = 0.0;
  std::string string;
  std::vector<ValuePtr> array;
  // shared_ptr keeps the container's element type complete while Value is not.
  std::map<std::string, ValuePtr> object;

  bool is_null() const { return type == Type::kNull; }
  bool is_object() const { return type == Type::kObject; }
  bool is_array() const { return type == Type::kArray; }
  bool is_string() const { return type == Type::kString; }
  bool is_number() const { return type == Type::kNumber; }
  bool is_bool() const { return type == Type::kBool; }

  // Object member lookup. Returns nullptr when this is not an object or the key
  // is absent, so a missing field is never confused with a null one.
  const Value* Find(std::string_view key) const;

  // Typed accessors with defaults. A present-but-wrong-typed field yields the
  // default rather than a coerced value — silent coercion hides protocol drift.
  std::string StringOr(std::string_view key, std::string fallback = {}) const;
  int IntOr(std::string_view key, int fallback = 0) const;
  bool BoolOr(std::string_view key, bool fallback = false) const;
  std::int64_t Int64Or(std::string_view key, std::int64_t fallback = 0) const;

  // Moves a string member out and zeroes the bytes it occupied, leaving the
  // member as an empty string. Used for the publisher token so it is never
  // duplicated across the parse tree and the request struct.
  std::string TakeString(std::string_view key);
};

// Parses one complete JSON document. Trailing content other than whitespace is
// an error. Returns nullopt for anything malformed, over-deep, or over-long.
std::optional<Value> Parse(std::string_view text);

// Overwrites every string in the tree, in place, before it goes out of scope.
// `volatile` writes keep the compiler from eliding them as dead stores.
void Scrub(Value& value);

// Overwrites a string's bytes and clears it. Exposed because callers hold
// tokens outside a Value too.
void ScrubString(std::string& s);

}  // namespace engosoft::media::json

#endif  // ENGOSOFT_MEDIA_PUBLISHER_JSON_H_
