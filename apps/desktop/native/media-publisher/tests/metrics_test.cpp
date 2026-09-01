// metrics_test — self-contained, no test framework dependency so it builds and
// runs with nothing but a compiler.
//
// The redaction cases carry real weight: a publisher token reaching a log file
// is a credential leak, so these assert on the exact output rather than merely
// checking the token is "not present".

#include "../src/metrics.h"

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

bool Contains(const std::string& haystack, const std::string& needle) {
  return haystack.find(needle) != std::string::npos;
}

using namespace engosoft::media;

// A realistic JWT shape — three base64 segments. If any test lets this through,
// redaction is broken.
const char* kToken =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXZpY2VfNyIsInZpZGVvIjp7InJvb21Kb2luIjp0cnVlfX0."
    "8xQe1ZbT2mKzq3Vd5nR7yPwLcXaHgFjE";

void TestRedactJsonKeys() {
  std::printf("redact: JSON keys\n");

  CheckEq(Redact(std::string("{\"publisher_token\":\"") + kToken + "\"}"),
          "{\"publisher_token\":\"[redacted]\"}", "publisher_token is redacted");

  CheckEq(Redact("{\"token\":\"abc\"}"), "{\"token\":\"[redacted]\"}", "bare token key");

  CheckEq(Redact("{\"api_key\":\"sk-live-123\"}"), "{\"api_key\":\"[redacted]\"}",
          "api_key suffix match");

  CheckEq(Redact("{\"livekit_url\":\"wss://x.livekit.cloud?access=sig\"}"),
          "{\"livekit_url\":\"[redacted]\"}", "signed URL is redacted");

  CheckEq(Redact("{\"authorization\":\"Bearer abc\"}"), "{\"authorization\":\"[redacted]\"}",
          "authorization header");

  CheckEq(Redact("{\"jwt\":\"a.b.c\"}"), "{\"jwt\":\"[redacted]\"}", "jwt key");

  // Non-sensitive keys must survive untouched, or logs become useless.
  CheckEq(Redact("{\"session_id\":\"e1f2\",\"width\":1280}"),
          "{\"session_id\":\"e1f2\",\"width\":1280}", "ordinary keys are preserved");

  CheckEq(Redact("{\"reason\":\"token_rejected\"}"), "{\"reason\":\"token_rejected\"}",
          "a VALUE mentioning token is not a key and must survive");
}

void TestRedactNested() {
  std::printf("redact: nesting and mixed payloads\n");

  const std::string input =
      std::string("{\"type\":\"start_session\",\"payload\":{\"room\":\"org_42\",\"publisher_token\":\"") +
      kToken + "\",\"video\":{\"fps\":15}}}";
  const std::string out = Redact(input);

  Check(!Contains(out, "eyJhbGciOiJIUzI1NiJ9"), "no JWT header segment survives nesting", out);
  Check(!Contains(out, "8xQe1ZbT2mKzq3Vd5nR7yPwLcXaHgFjE"), "no JWT signature survives", out);
  Check(Contains(out, "\"room\":\"org_42\""), "sibling fields survive", out);
  Check(Contains(out, "\"fps\":15"), "nested non-sensitive fields survive", out);
}

void TestRedactBarePairs() {
  std::printf("redact: bare key=value in free text\n");

  CheckEq(Redact("connecting token=abc123 room=org_42"),
          "connecting token=[redacted] room=org_42", "bare token= pair");

  CheckEq(Redact("failed url=wss://host/path?sig=xyz retry=1"),
          "failed url=[redacted] retry=1", "bare url= pair");

  CheckEq(Redact("frames=120 dropped=2"), "frames=120 dropped=2",
          "ordinary bare pairs are untouched");
}

void TestRedactUnterminated() {
  std::printf("redact: malformed input does not throw or truncate wrongly\n");
  const std::string out = Redact("{\"token\":\"abc");
  Check(!out.empty(), "unterminated JSON still returns output", out);
  const std::string out2 = Redact("");
  CheckEq(out2, "", "empty input");
}

void TestBuildLogPayload() {
  std::printf("log payload\n");

  const std::string payload =
      BuildLogPayload("warn", std::string("connect failed with token=") + kToken,
                      {{"publisher_token", kToken}, {"reason", "connect_failed"}});

  Check(!Contains(payload, "eyJhbGciOiJIUzI1NiJ9"), "token absent from message", payload);
  Check(!Contains(payload, "8xQe1ZbT2mKzq3Vd5nR7yPwLcXaHgFjE"), "token absent from fields",
        payload);
  Check(Contains(payload, "\"publisher_token\":\"[redacted]\""), "sensitive field redacted",
        payload);
  Check(Contains(payload, "\"reason\":\"connect_failed\""), "ordinary field kept", payload);
  Check(Contains(payload, "\"level\":\"warn\""), "level present", payload);
}

void TestEscapeJson() {
  std::printf("json escaping\n");
  CheckEq(EscapeJson("a\"b"), "a\\\"b", "quote");
  CheckEq(EscapeJson("a\\b"), "a\\\\b", "backslash");
  CheckEq(EscapeJson("a\nb"), "a\\nb", "newline");
  CheckEq(EscapeJson(std::string("a\x01") + "b"), "a\\u0001b", "control char");
}

void TestSnapshotJsonHasNoSecrets() {
  std::printf("metrics snapshot shape\n");

  Metrics m;
  m.SetSessionId("e1f2");
  m.SetState(State::kPublishing);
  m.SetBackend(CaptureBackend::kWgc);
  m.SetEncoder(EncoderKind::kHardwareH264);
  m.SetResolution(1280, 720);
  m.SetBorderEnabled(true);

  const std::string json = ToJson(m.Get());

  Check(Contains(json, "\"capture_backend\":\"wgc\""), "backend reported", json);
  Check(Contains(json, "\"encoder\":\"hardware_h264\""), "encoder reported", json);
  Check(Contains(json, "\"border_enabled\":true"), "border state auditable", json);
  Check(Contains(json, "\"state\":\"publishing\""), "state reported", json);
  Check(Contains(json, "\"reason\":null"), "no reason when healthy", json);

  // The payload has no field that could carry a secret at all.
  Check(!Contains(json, "token"), "no token field exists in metrics", json);
  Check(!Contains(json, "url"), "no url field exists in metrics", json);
}

void TestFailureReasonSerialization() {
  std::printf("failure reasons\n");
  Metrics m;
  m.SetState(State::kFailed, FailureReason::kCaptureUnsupported);
  Check(Contains(ToJson(m.Get()), "\"reason\":\"capture_unsupported\""),
        "failure reason serialized", ToJson(m.Get()));
}

void TestRepeatedFramesCountTowardPublishedRate() {
  std::printf("repeated frames and rates\n");

  Metrics m;
  // 10 real frames plus 5 repeats over one second: capture 10 fps, published 15.
  // A still screen must still publish at the configured rate (ADR 0003).
  for (int i = 0; i < 10; ++i) m.OnFrameCaptured();
  for (int i = 0; i < 5; ++i) m.OnFrameRepeated();
  m.Tick(1.0);

  const Snapshot s = m.Get();
  Check(s.capture_fps > 9.99 && s.capture_fps < 10.01, "capture_fps counts only real frames",
        std::to_string(s.capture_fps));
  Check(s.published_fps > 14.99 && s.published_fps < 15.01,
        "published_fps includes repeats", std::to_string(s.published_fps));
  Check(s.frames_repeated == 5, "repeats counted separately from captures");

  // A second interval with no new frames must show the rate fall to zero rather
  // than hold the previous value — a frozen capture has to be visible.
  m.Tick(1.0);
  const Snapshot idle = m.Get();
  Check(idle.capture_fps == 0.0, "stalled capture shows 0 fps, not a stale value",
        std::to_string(idle.capture_fps));
}

void TestTickGuards() {
  std::printf("tick guards\n");
  Metrics m;
  m.OnFrameCaptured();
  m.Tick(0.0);   // must not divide by zero
  m.Tick(-1.0);  // must not produce a negative rate
  Check(m.Get().capture_fps == 0.0, "non-positive elapsed is ignored");
}

}  // namespace

int main() {
  std::printf("== metrics_test ==\n\n");

  TestRedactJsonKeys();
  TestRedactNested();
  TestRedactBarePairs();
  TestRedactUnterminated();
  TestBuildLogPayload();
  TestEscapeJson();
  TestSnapshotJsonHasNoSecrets();
  TestFailureReasonSerialization();
  TestRepeatedFramesCountTowardPublishedRate();
  TestTickGuards();

  std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
