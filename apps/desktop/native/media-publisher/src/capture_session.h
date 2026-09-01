// capture_session.h — screen capture with rate pacing.
//
// Backend is Windows Graphics Capture (ADR 0003). The choice was not made on
// throughput — WGC and DXGI measured within 1.2% of each other — but on the
// system-enforced capture border, which an application cannot silently disable.
// DXGI Desktop Duplication has no indicator at all, which is disqualifying for
// a monitoring product.
//
// PACING. Both Windows capture APIs are change-driven: they emit frames when
// the desktop changes and go silent when it does not. Measured idle gaps reach
// 0.9s (ADR 0003). A publisher that forwarded only real capture events would
// look frozen to the viewer, so this class holds the last frame and re-emits it
// to sustain the configured rate. Repeats are reported separately in metrics so
// they are never mistaken for genuine capture output.

#ifndef ENGOSOFT_MEDIA_PUBLISHER_CAPTURE_SESSION_H_
#define ENGOSOFT_MEDIA_PUBLISHER_CAPTURE_SESSION_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "metrics.h"

namespace engosoft::media {

struct CaptureConfig {
  // Index into the monitor enumeration. 0 is the primary display.
  int display_index = 0;

  // Target size handed to the encoder. The captured desktop is scaled to fit
  // while preserving aspect ratio.
  int width = 1280;
  int height = 720;

  int fps = 15;

  // Required visible in the published stream.
  bool capture_cursor = true;
};

// A borrowed view of one BGRA frame. Valid only for the duration of the
// callback — the receiver must copy or submit synchronously.
//
// BGRA is deliberate: WGC yields B8G8R8A8UIntNormalized and the LiveKit SDK
// accepts VideoBufferType::BGRA, so no colour conversion sits in the path.
struct FrameView {
  const std::uint8_t* data = nullptr;
  int width = 0;
  int height = 0;
  int stride = 0;  // bytes per row; may exceed width * 4

  // True when this is a re-emission of the previous frame because the screen
  // did not change. The publisher still sends it; metrics count it apart.
  bool repeated = false;
};

using FrameCallback = std::function<void(const FrameView&)>;

// Reported through the IPC `state` message when capture cannot continue.
enum class CaptureStatus {
  kOk,
  kUnsupported,   // GraphicsCaptureSession::IsSupported() == false
  kItemFailed,    // capture item could not be created
  kDisplayGone,   // the captured display disappeared
  kDeviceLost,    // D3D device reset
  kInternalError,
};

const char* ToString(CaptureStatus status);
FailureReason ToFailureReason(CaptureStatus status);

class CaptureSession {
 public:
  CaptureSession();
  ~CaptureSession();

  CaptureSession(const CaptureSession&) = delete;
  CaptureSession& operator=(const CaptureSession&) = delete;

  // Must be checked before Start. When false the sidecar reports
  // `capture_unsupported` and stops — it does NOT fall back to a capture path
  // without an indicator, which would defeat the border guarantee.
  static bool IsSupported();

  // Number of monitors currently attached.
  static int DisplayCount();

  // Begins capture and pacing. `on_frame` is invoked on the pacing thread at
  // roughly config.fps, whether or not the screen is changing.
  //
  // `metrics` is borrowed and must outlive this session.
  CaptureStatus Start(const CaptureConfig& config, FrameCallback on_frame, Metrics* metrics);

  // Idempotent. Blocks until the pacing thread has stopped and no further
  // callback can run, so the caller can safely tear down what the callback
  // touches. Emergency stop depends on this returning promptly.
  void Stop();

  bool running() const;

  // Live policy changes, applied without reconnecting.
  void SetTargetFps(int fps);

  // Replaces captured pixels with a solid frame at the source, so real pixels
  // never reach the encoder. A blackout enforced anywhere downstream would not
  // be a blackout.
  void SetBlackout(bool enabled);

  // Always true for the WGC backend. Exposed so the publisher can report it in
  // metrics and the backend can audit that the indicator was on for the whole
  // session. There is deliberately no setter.
  bool BorderEnabled() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace engosoft::media

#endif  // ENGOSOFT_MEDIA_PUBLISHER_CAPTURE_SESSION_H_
