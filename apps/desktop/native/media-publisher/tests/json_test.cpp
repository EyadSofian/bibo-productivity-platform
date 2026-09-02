// json_test — the read half of the IPC codec.
//
// Self-contained, no test framework, matching metrics_test.cpp.
//
// The rejection cases carry the weight here. This parser reads the only channel
// that carries a publisher token, so "refuses malformed input" has to mean
// refuses, not "recovers into a partial tree a caller might still read".

#include "../src/json.h"

#include <cstdio>
#include <string>

namespace {

int g_failures = 0;
int g_checks = 0;

void Check(bool condition, const char* what, const std::string& detail = "") {
  ++g_checks;
  if (condition) return;
  ++g_failures;
  std::printf("  FAIL: %s\n", what);
  if (!detail.empty()) std::printf("        %s\n", detail.c_str());
}

void CheckEq(const std::string& actual, const std::string& expected, const char* what) {
  ++g_checks;
  if (actual == expected) return;
  ++g_failures;
  std::printf("  FAIL: %s\n", what);
  std::printf("        expected: %s\n", expected.c_str());
  std::printf("        actual  : %s\n", actual.c_str());
}

void CheckRejected(const char* text, const char* what) {
  ++g_checks;
  if (!engosoft::media::json::Parse(text).has_value()) return;
  ++g_failures;
  std::printf("  FAIL: accepted invalid JSON (%s): %s\n", what, text);
}

using namespace engosoft::media;

void TestScalars() {
  std::printf("scalars\n");

  auto value = json::Parse(R"({"a":"x","b":42,"c":true,"d":null,"e":-1.5e2})");
  Check(value.has_value(), "parses a flat object");
  if (!value) return;

  CheckEq(value->StringOr("a"), "x", "string member");
  Check(value->IntOr("b") == 42, "integer member");
  Check(value->BoolOr("c"), "bool member");
  Check(value->Find("d") != nullptr && value->Find("d")->is_null(), "null is present, not missing");
  Check(value->Find("missing") == nullptr, "absent member returns nullptr");
  Check(value->Find("e")->number == -150.0, "exponent and sign");
}

void TestTypeMismatchUsesFallback() {
  std::printf("type mismatches fall back rather than coerce\n");

  auto value = json::Parse(R"({"n":"42","s":42,"b":"true"})");
  Check(value.has_value(), "parses");
  if (!value) return;

  // Coercion would let a sender pass "15" where a number is expected and have
  // it silently work here but not on the Rust side. Refusing keeps the two ends
  // honest about the contract.
  Check(value->IntOr("n", -1) == -1, "a quoted number is not an int");
  CheckEq(value->StringOr("s", "fallback"), "fallback", "a number is not a string");
  Check(value->BoolOr("b", false) == false, "a quoted bool is not a bool");
}

void TestNesting() {
  std::printf("nesting\n");

  auto value = json::Parse(R"({"payload":{"video":{"fps":15,"width":1280}},"list":[1,"two",null]})");
  Check(value.has_value(), "parses nested objects and arrays");
  if (!value) return;

  const json::Value* payload = value->Find("payload");
  Check(payload != nullptr && payload->is_object(), "payload is an object");
  const json::Value* video = payload->Find("video");
  Check(video != nullptr, "nested object reachable");
  Check(video->IntOr("fps") == 15, "nested int");
  Check(video->IntOr("width") == 1280, "nested int 2");

  const json::Value* list = value->Find("list");
  Check(list != nullptr && list->is_array() && list->array.size() == 3, "array of three");
  Check(list->array[1]->string == "two", "array element by index");
}

void TestStringEscapes() {
  std::printf("string escapes\n");

  auto value = json::Parse(R"({"s":"a\"b\\c\/d\ne\tf"})");
  Check(value.has_value(), "parses escapes");
  if (value) CheckEq(value->StringOr("s"), "a\"b\\c/d\ne\tf", "escape decoding");

  auto unicode = json::Parse(R"({"s":"\u0041\u00e9\u4e2d"})");
  Check(unicode.has_value(), "parses \\u escapes");
  if (unicode) CheckEq(unicode->StringOr("s"), "A\xc3\xa9\xe4\xb8\xad", "\\u decoded to UTF-8");

  // U+1F600, as a surrogate pair.
  auto surrogate = json::Parse(R"({"s":"\ud83d\ude00"})");
  Check(surrogate.has_value(), "parses a surrogate pair");
  if (surrogate) CheckEq(surrogate->StringOr("s"), "\xf0\x9f\x98\x80", "surrogate pair to UTF-8");
}

void TestRejections() {
  std::printf("rejections\n");

  CheckRejected("", "empty input");
  CheckRejected("{", "unterminated object");
  CheckRejected("{\"a\":1", "missing closing brace");
  CheckRejected("{\"a\":1,}", "trailing comma");
  CheckRejected("{a:1}", "unquoted key");
  CheckRejected("{'a':1}", "single quotes");
  CheckRejected("{\"a\":01}", "leading zero");
  CheckRejected("{\"a\":.5}", "bare decimal point");
  CheckRejected("{\"a\":1.}", "trailing decimal point");
  CheckRejected("{\"a\":+1}", "leading plus");
  CheckRejected("{\"a\":NaN}", "NaN");
  CheckRejected("{\"a\":Infinity}", "Infinity");
  CheckRejected("{\"a\":1}{\"b\":2}", "two documents in one message");
  CheckRejected("{\"a\":1} trailing", "trailing garbage");
  CheckRejected("{\"a\":\"\\x\"}", "invalid escape");
  CheckRejected("{\"a\":\"\\ud83d\"}", "lone high surrogate");
  CheckRejected("{\"a\":\"\\udc00\"}", "lone low surrogate");
  CheckRejected("{\"a\":\"\\u00zz\"}", "bad hex in \\u");
  CheckRejected("[1,2", "unterminated array");
  CheckRejected("tru", "truncated literal");

  // A duplicate key is how a sender smuggles a second value past a first-wins
  // reader. Both ends must see the same message or neither should proceed.
  CheckRejected("{\"publisher_token\":\"a\",\"publisher_token\":\"b\"}", "duplicate key");

  // A raw control character inside a string is not legal JSON.
  const std::string raw_control = std::string("{\"a\":\"x") + '\n' + "\"}";
  ++g_checks;
  if (json::Parse(raw_control).has_value()) {
    ++g_failures;
    std::printf("  FAIL: accepted a raw newline inside a string\n");
  }
}

void TestLimits() {
  std::printf("limits\n");

  std::string deep;
  for (int i = 0; i < json::kMaxDepth + 4; ++i) deep += "[";
  for (int i = 0; i < json::kMaxDepth + 4; ++i) deep += "]";
  Check(!json::Parse(deep).has_value(), "nesting past kMaxDepth is refused");

  std::string shallow;
  for (int i = 0; i < json::kMaxDepth - 2; ++i) shallow += "[";
  shallow += "1";
  for (int i = 0; i < json::kMaxDepth - 2; ++i) shallow += "]";
  Check(json::Parse(shallow).has_value(), "nesting inside kMaxDepth is accepted");

  const std::string huge = "{\"a\":\"" + std::string(json::kMaxDocumentBytes + 16, 'x') + "\"}";
  Check(!json::Parse(huge).has_value(), "documents past kMaxDocumentBytes are refused");
}

void TestTakeStringScrubs() {
  std::printf("token extraction\n");

  const std::string token = "eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIGNATURE";
  auto value = json::Parse("{\"publisher_token\":\"" + token + "\",\"room\":\"r1\"}");
  Check(value.has_value(), "parses a token-bearing payload");
  if (!value) return;

  const std::string taken = value->TakeString("publisher_token");
  CheckEq(taken, token, "TakeString returns the value");

  // After extraction the token must exist in exactly one place. A parse tree
  // still holding a copy is a token sitting in process memory for the lifetime
  // of the message.
  const json::Value* member = value->Find("publisher_token");
  Check(member != nullptr, "the member itself remains, so the shape is unchanged");
  Check(member != nullptr && member->string.empty(), "the tree's copy is cleared");

  CheckEq(value->StringOr("room"), "r1", "other members survive extraction");
  CheckEq(value->TakeString("room"), "r1", "TakeString on a second member");
  CheckEq(value->TakeString("absent"), "", "TakeString on an absent key is empty");

  std::string scrub_me = token;
  json::ScrubString(scrub_me);
  Check(scrub_me.empty(), "ScrubString clears");
}

void TestProtocolShape() {
  std::printf("protocol envelope\n");

  // The exact shape from docs/ipc-protocol.md.
  const char* message = R"({
    "v": 1,
    "id": "b1c2",
    "type": "start_session",
    "ts_ms": 1756800000000,
    "payload": {
      "session_id": "e1f2",
      "room": "org_42__device_7",
      "livekit_url": "wss://example.livekit.cloud",
      "publisher_token": "TOKEN",
      "track_name": "screen0",
      "display_id": 0,
      "video": { "width": 1280, "height": 720, "fps": 15 }
    }
  })";

  auto value = json::Parse(message);
  Check(value.has_value(), "parses the documented start_session");
  if (!value) return;

  Check(value->IntOr("v") == 1, "envelope version");
  CheckEq(value->StringOr("type"), "start_session", "envelope type");
  // ts_ms is past 2^32, so it must survive as a 64-bit value.
  Check(value->Int64Or("ts_ms") == 1756800000000LL, "millisecond timestamp keeps 64-bit range");

  const json::Value* payload = value->Find("payload");
  Check(payload != nullptr, "payload present");
  CheckEq(payload->StringOr("room"), "org_42__device_7", "room");
  Check(payload->IntOr("display_id", -1) == 0, "display_id zero is read, not defaulted");
  Check(payload->Find("video")->IntOr("fps") == 15, "video.fps");
}

}  // namespace

int main() {
  std::printf("== json_test ==\n");
  TestScalars();
  TestTypeMismatchUsesFallback();
  TestNesting();
  TestStringEscapes();
  TestRejections();
  TestLimits();
  TestTakeStringScrubs();
  TestProtocolShape();

  std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
