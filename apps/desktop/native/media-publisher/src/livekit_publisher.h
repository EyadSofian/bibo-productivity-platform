// livekit_publisher.h — publishes BGRA frames to a LiveKit room as a video track.
//
// Wraps the official LiveKit C++ SDK (livekit/client-sdk-cpp, pinned in
// CMakeLists.txt) so the rest of the sidecar never touches SDK types directly
// and an SDK upgrade lands in one file.
//
// CREDENTIALS. This class receives a short-lived, publish-only JWT that the
// backend minted for one device and one room. It never holds an API key or
// secret, and cannot mint a token. The token arrives over the IPC pipe, never
// on the command line — on Windows another process in the same session can read
// a process's command line, so a token in argv is effectively public.

#ifndef ENGOSOFT_MEDIA_PUBLISHER_LIVEKIT_PUBLISHER_H_
#define ENGOSOFT_MEDIA_PUBLISHER_LIVEKIT_PUBLISHER_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "capture_session.h"
#include "metrics.h"

namespace engosoft::media {

struct PublishConfig {
  std::string livekit_url;   // wss://…
  std::string room;
  std::string track_name = "screen0";

  int width = 1280;
  int height = 720;
  int fps = 15;
};

// Mirrors the transport half of the IPC `metrics` payload.
struct TransportStats {
  std::uint64_t bitrate_bps = 0;
  std::uint32_t rtt_ms = 0;
  double packet_loss = 0.0;
};

enum class PublishStatus {
  kOk,
  kConnectFailed,   // could not reach the SFU
  kTokenRejected,   // SFU refused the token
  kIceFailed,       // transport could not be established
  kPublishFailed,   // connected, but the track was refused
  kEncoderFailed,
  kInternalError,
};

const char* ToString(PublishStatus status);
FailureReason ToFailureReason(PublishStatus status);

// Fired on SDK threads. Implementations must not block.
using StateCallback = std::function<void(State, FailureReason)>;

class LiveKitPublisher {
 public:
  LiveKitPublisher();
  ~LiveKitPublisher();

  LiveKitPublisher(const LiveKitPublisher&) = delete;
  LiveKitPublisher& operator=(const LiveKitPublisher&) = delete;

  // Initializes the SDK process-wide and routes its logging through the
  // redacting sink. Safe to call once; later calls are ignored.
  static void InitializeSdk();

  // Connects and publishes an empty video track ready for frames.
  //
  // `token` is taken by value and the caller's copy should be zeroed after the
  // call. This class zeroes its own copy as soon as the room is connected — the
  // token is not needed afterwards and must not linger in process memory.
  PublishStatus Start(const PublishConfig& config, std::string token, StateCallback on_state,
                      Metrics* metrics);

  // Idempotent. Unpublishes, disconnects, and releases SDK objects.
  void Stop();

  bool publishing() const;

  // Submits one frame. Safe to call from the capture pacing thread. Frames
  // arriving while reconnecting are dropped and counted, not queued — a queue
  // would deliver a burst of stale desktop after recovery.
  void SubmitFrame(const FrameView& frame);

  // Samples transport statistics from the SDK for the `metrics` message.
  TransportStats Stats() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace engosoft::media

#endif  // ENGOSOFT_MEDIA_PUBLISHER_LIVEKIT_PUBLISHER_H_
