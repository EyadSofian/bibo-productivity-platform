// metrics.h — publisher state, failure reasons, counters, and safe log emission.
//
// Deliberately free of LiveKit and Windows capture types so it can be unit
// tested on any platform and cannot be broken by an SDK upgrade.
//
// Redaction is enforced here rather than at each call site: anything that could
// carry a token, a signed URL, or screen content must go through Redact().

#ifndef ENGOSOFT_MEDIA_PUBLISHER_METRICS_H_
#define ENGOSOFT_MEDIA_PUBLISHER_METRICS_H_

#include <cstdint>
#include <map>
#include <mutex>
#include <string>

namespace engosoft::media {

// Mirrors the `state` values in docs/ipc-protocol.md. Keep the two in step.
enum class State {
  kIdle,
  kStarting,
  kConnecting,
  kPublishing,
  kReconnecting,
  kStopping,
  kStopped,
  kFailed,
};

// Mirrors the failure `reason` table in docs/ipc-protocol.md. Each maps onto a
// player error state, so a viewer sees a cause rather than a spinner.
enum class FailureReason {
  kNone,
  kCaptureUnsupported,
  kCaptureFailed,
  kEncoderFailed,
  kConnectFailed,
  kTokenRejected,
  kIceFailed,
  kDisplayGone,
  kInternalError,
};

const char* ToString(State state);
const char* ToString(FailureReason reason);

// Which capture backend actually ran. Reported in metrics so a silent fallback
// can never masquerade as the intended path (ADR 0003).
enum class CaptureBackend { kNone, kWgc, kDxgi };
const char* ToString(CaptureBackend backend);

// Whether encoding was hardware accelerated. Never inferred — only set from
// what the SDK reports.
enum class EncoderKind { kUnknown, kHardwareH264, kSoftwareH264 };
const char* ToString(EncoderKind kind);

// A point-in-time copy, safe to serialize outside the lock.
struct Snapshot {
  State state = State::kIdle;
  FailureReason reason = FailureReason::kNone;
  CaptureBackend backend = CaptureBackend::kNone;
  EncoderKind encoder = EncoderKind::kUnknown;

  std::string session_id;

  double capture_fps = 0.0;
  double published_fps = 0.0;

  std::uint64_t frames_captured = 0;
  // Frames re-sent because the screen did not change. Both Windows capture APIs
  // are change-driven with idle gaps up to ~0.9s (ADR 0003), so holding the
  // rate means repeating. Counted separately so it is never mistaken for real
  // capture output.
  std::uint64_t frames_repeated = 0;
  std::uint64_t frames_dropped = 0;

  int width = 0;
  int height = 0;

  std::uint64_t bitrate_bps = 0;
  std::uint32_t rtt_ms = 0;
  double packet_loss = 0.0;
  std::uint32_t reconnect_count = 0;

  double cpu_percent = 0.0;
  double memory_mb = 0.0;

  // Audited by the backend: the tamper-proof capture indicator must have been
  // on for the whole session.
  bool border_enabled = true;
};

class Metrics {
 public:
  void SetSessionId(std::string id);
  void SetState(State state, FailureReason reason = FailureReason::kNone);
  void SetBackend(CaptureBackend backend);
  void SetEncoder(EncoderKind kind);
  void SetResolution(int width, int height);
  void SetBorderEnabled(bool enabled);

  void OnFrameCaptured();
  void OnFrameRepeated();
  void OnFrameDropped();
  void OnReconnect();

  // Transport stats sampled from the SDK.
  void SetTransport(std::uint64_t bitrate_bps, std::uint32_t rtt_ms, double packet_loss);
  void SetProcessUsage(double cpu_percent, double memory_mb);

  // Rates are computed from counters over the interval since the last call, so
  // a stalled capture shows as a falling FPS rather than a stale value.
  void Tick(double elapsed_seconds);

  Snapshot Get() const;

  State state() const;

 private:
  mutable std::mutex mutex_;
  Snapshot snapshot_;
  std::uint64_t last_captured_ = 0;
  std::uint64_t last_published_ = 0;
};

// Serializes a snapshot as the `metrics` payload in docs/ipc-protocol.md.
// Contains no token, URL, or pixel data by construction — there is no field for
// any of them.
std::string ToJson(const Snapshot& snapshot);

// Replaces the value of any sensitive key with "[redacted]", at any nesting
// depth. Applied to every log line before it leaves the process.
//
// Redacted keys: token, jwt, secret, url, authorization, password, key.
std::string Redact(const std::string& text);

// Builds a `log` payload with redaction already applied.
std::string BuildLogPayload(const std::string& level, const std::string& message,
                            const std::map<std::string, std::string>& fields);

// Minimal JSON string escaping. Exposed for tests.
std::string EscapeJson(const std::string& in);

}  // namespace engosoft::media

#endif  // ENGOSOFT_MEDIA_PUBLISHER_METRICS_H_
