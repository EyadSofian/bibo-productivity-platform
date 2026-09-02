#include "livekit_publisher.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <future>
#include <mutex>
#include <optional>

#include "livekit/livekit.h"
#include "livekit/local_participant.h"
#include "livekit/local_video_track.h"
#include "livekit/logging.h"
#include "livekit/room.h"
#include "livekit/room_delegate.h"
#include "livekit/room_event_types.h"
#include "livekit/video_frame.h"
#include "livekit/video_source.h"

namespace engosoft::media {
namespace {

// Proto ordinal for H.264. room_event_types.h forward-declares `enum class
// VideoCodec;` and never defines the enumerators anywhere in the public
// headers, so there is no named constant to reference. The numbering comes from
// livekit-ffi/protocol/video_frame.proto: VP8=0, H264=1, AV1=2, VP9=3, H265=4.
constexpr int kVideoCodecH264 = 1;

// Overwrites a token buffer before releasing it. `volatile` keeps the compiler
// from eliding the write as dead.
void ZeroString(std::string& s) {
  volatile char* p = const_cast<volatile char*>(s.data());
  for (size_t i = 0; i < s.size(); ++i) p[i] = '\0';
  s.clear();
  s.shrink_to_fit();
}

// Routes SDK logs through our redactor. The SDK invokes this sequentially and
// it must not block.
void SdkLogSink(livekit::LogLevel level, const std::string& logger, const std::string& message) {
  const char* level_name = "info";
  switch (level) {
    case livekit::LogLevel::Trace:
    case livekit::LogLevel::Debug: level_name = "debug"; break;
    case livekit::LogLevel::Info: level_name = "info"; break;
    case livekit::LogLevel::Warn: level_name = "warn"; break;
    case livekit::LogLevel::Error:
    case livekit::LogLevel::Critical: level_name = "error"; break;
    case livekit::LogLevel::Off: return;
  }
  // The SDK logs connection URLs; Redact strips them along with any token.
  std::fputs(BuildLogPayload(level_name, "[livekit] " + logger + ": " + message, {}).c_str(),
             stderr);
  std::fputc('\n', stderr);
}

}  // namespace

const char* ToString(PublishStatus status) {
  switch (status) {
    case PublishStatus::kOk: return "ok";
    case PublishStatus::kConnectFailed: return "connect_failed";
    case PublishStatus::kTokenRejected: return "token_rejected";
    case PublishStatus::kIceFailed: return "ice_failed";
    case PublishStatus::kPublishFailed: return "publish_failed";
    case PublishStatus::kEncoderFailed: return "encoder_failed";
    case PublishStatus::kInternalError: return "internal_error";
  }
  return "internal_error";
}

FailureReason ToFailureReason(PublishStatus status) {
  switch (status) {
    case PublishStatus::kOk: return FailureReason::kNone;
    case PublishStatus::kConnectFailed: return FailureReason::kConnectFailed;
    case PublishStatus::kTokenRejected: return FailureReason::kTokenRejected;
    case PublishStatus::kIceFailed: return FailureReason::kIceFailed;
    case PublishStatus::kPublishFailed: return FailureReason::kInternalError;
    case PublishStatus::kEncoderFailed: return FailureReason::kEncoderFailed;
    case PublishStatus::kInternalError: return FailureReason::kInternalError;
  }
  return FailureReason::kInternalError;
}

namespace {

// Room holds this as a RAW non-owning pointer and fires onDisconnected during
// its own teardown, so it must outlive the Room. Impl guarantees that through
// member declaration order.
class PublisherDelegate : public livekit::RoomDelegate {
 public:
  PublisherDelegate(StateCallback on_state, Metrics* metrics)
      : on_state_(std::move(on_state)), metrics_(metrics) {}

  void onReconnecting(livekit::Room&, const livekit::ReconnectingEvent&) override {
    // Room::connectionState() cannot be used for this: room.cpp's
    // kConnectionStateChanged handler deliberately never updates the cached
    // state (it carries a TODO saying the event never fires). These delegate
    // callbacks are the only reliable signal.
    reconnecting_.store(true, std::memory_order_release);
    if (metrics_) {
      metrics_->OnReconnect();
      metrics_->SetState(State::kReconnecting);
    }
    Emit(State::kReconnecting, FailureReason::kNone);
  }

  void onReconnected(livekit::Room&, const livekit::ReconnectedEvent&) override {
    reconnecting_.store(false, std::memory_order_release);
    // The Rust core republishes every local track across a full reconnect while
    // keeping the same Track object and its bound VideoSource, so there is
    // nothing to re-publish here — just resume submitting frames.
    if (metrics_) metrics_->SetState(State::kPublishing);
    Emit(State::kPublishing, FailureReason::kNone);
  }

  void onDisconnected(livekit::Room&, const livekit::DisconnectedEvent& e) override {
    // Terminal for this Room object: room.h states a disconnected Room must be
    // connected again to be valid, and connect() throws unless the state is
    // Disconnected. Recovery means a fresh Room and a fresh token, which the
    // owner drives — we must NOT call disconnect() from inside a delegate
    // callback, as room.h warns that deadlocks the event listener.
    disconnected_.store(true, std::memory_order_release);
    const FailureReason reason = MapDisconnect(e.reason);
    if (metrics_) metrics_->SetState(State::kStopped, reason);
    Emit(State::kStopped, reason);
  }

  bool reconnecting() const { return reconnecting_.load(std::memory_order_acquire); }
  bool disconnected() const { return disconnected_.load(std::memory_order_acquire); }

 private:
  static FailureReason MapDisconnect(livekit::DisconnectReason reason) {
    switch (reason) {
      case livekit::DisconnectReason::JoinFailure:
        return FailureReason::kTokenRejected;
      case livekit::DisconnectReason::ConnectionTimeout:
      case livekit::DisconnectReason::SignalClose:
        return FailureReason::kIceFailed;
      case livekit::DisconnectReason::MediaFailure:
        return FailureReason::kEncoderFailed;
      case livekit::DisconnectReason::ClientInitiated:
        return FailureReason::kNone;
      default:
        return FailureReason::kConnectFailed;
    }
  }

  void Emit(State state, FailureReason reason) {
    if (on_state_) on_state_(state, reason);
  }

  StateCallback on_state_;
  Metrics* metrics_ = nullptr;
  std::atomic<bool> reconnecting_{false};
  std::atomic<bool> disconnected_{false};
};

}  // namespace

struct LiveKitPublisher::Impl {
  // DECLARATION ORDER IS LOAD-BEARING. Members are destroyed in reverse order,
  // so the delegate declared first is destroyed last and outlives the Room that
  // holds a raw pointer to it and fires onDisconnected while tearing down.
  std::unique_ptr<PublisherDelegate> delegate;
  std::unique_ptr<livekit::Room> room;

  std::shared_ptr<livekit::VideoSource> source;
  std::shared_ptr<livekit::LocalVideoTrack> track;

  // One frame reused across the whole session. VideoFrame::create allocates and
  // zero-fills, which at 1280x720 BGRA is ~3.7MB per frame — unacceptable at
  // 15 FPS. captureFrame takes a const ref, so overwriting through data() is
  // safe between calls.
  std::optional<livekit::VideoFrame> frame;
  int frame_width = 0;
  int frame_height = 0;

  Metrics* metrics = nullptr;
  std::mutex frame_mutex;
  std::atomic<bool> publishing{false};
};

LiveKitPublisher::LiveKitPublisher() : impl_(std::make_unique<Impl>()) {}

LiveKitPublisher::~LiveKitPublisher() { Stop(); }

void LiveKitPublisher::InitializeSdk() {
  static std::once_flag once;
  std::call_once(once, [] {
    // Must be the first LiveKit call in the process: Room::connect checks the
    // FFI client is initialized and fails outright otherwise.
    livekit::initialize(livekit::LogLevel::Info);
    livekit::setLogCallback(&SdkLogSink);
  });
}

PublishStatus LiveKitPublisher::Start(const PublishConfig& config, std::string token,
                                      StateCallback on_state, Metrics* metrics) {
  InitializeSdk();

  if (impl_->publishing.load(std::memory_order_acquire)) {
    ZeroString(token);
    return PublishStatus::kInternalError;
  }

  impl_->metrics = metrics;
  if (metrics) metrics->SetState(State::kConnecting);

  impl_->delegate = std::make_unique<PublisherDelegate>(std::move(on_state), metrics);
  impl_->room = std::make_unique<livekit::Room>();

  // Before connect: connect() registers the FFI listener and emits events
  // during the blocking call, so a delegate attached afterwards misses them.
  impl_->room->setDelegate(impl_->delegate.get());

  livekit::RoomOptions options;
  // Publish-only. Without this the SFU would push every remote track at a
  // process that has no way to render them.
  options.auto_subscribe = false;

  bool connected = false;
  try {
    connected = impl_->room->connect(config.livekit_url, token, options);
  } catch (const std::exception&) {
    // connect() throws "already connected" rather than returning false when the
    // room is not Disconnected, so both paths need handling.
    connected = false;
  }

  // The token has done its job. Zero both our copy and the caller's argument
  // before doing anything else — it must not sit in process memory.
  ZeroString(token);

  if (!connected) {
    impl_->room.reset();
    impl_->delegate.reset();
    if (metrics) metrics->SetState(State::kFailed, FailureReason::kConnectFailed);
    return PublishStatus::kConnectFailed;
  }

  auto participant = impl_->room->localParticipant().lock();
  if (!participant) {
    impl_->room.reset();
    impl_->delegate.reset();
    if (metrics) metrics->SetState(State::kFailed, FailureReason::kInternalError);
    return PublishStatus::kInternalError;
  }

  impl_->source = std::make_shared<livekit::VideoSource>(config.width, config.height);

  // Two-step publish. publishVideoTrack(name, source, source_kind) exists but
  // builds a default TrackPublishOptions and sets only .source, discarding
  // bitrate, framerate and degradation preference. Screen content needs those.
  impl_->track = livekit::LocalVideoTrack::createLocalVideoTrack(config.track_name, impl_->source);
  if (!impl_->track) {
    Stop();
    if (metrics) metrics->SetState(State::kFailed, FailureReason::kInternalError);
    return PublishStatus::kPublishFailed;
  }

  livekit::TrackPublishOptions publish_options;
  publish_options.source = livekit::TrackSource::SOURCE_SCREENSHARE;

  livekit::VideoEncodingOptions encoding;
  // ~1.2 Mbps at 720p15 leaves headroom on a typical office uplink while
  // keeping text legible. Tuned again in V14 against the real SLOs.
  encoding.max_bitrate = 1'200'000;
  encoding.max_framerate = static_cast<double>(config.fps);
  publish_options.video_encoding = encoding;

  // The SDK always creates a VideoSource with is_screencast = false, so
  // libwebrtc applies camera heuristics and sheds resolution to protect frame
  // rate. For a screen that inverts the priority: unreadable text at 15 FPS is
  // worse than readable text at 10.
  publish_options.degradation_preference = livekit::DegradationPreference::MaintainResolution;
  publish_options.simulcast = false;
  publish_options.video_codec = static_cast<livekit::VideoCodec>(kVideoCodecH264);

  try {
    participant->publishTrack(impl_->track, publish_options);
  } catch (const std::exception&) {
    Stop();
    if (metrics) metrics->SetState(State::kFailed, FailureReason::kInternalError);
    return PublishStatus::kPublishFailed;
  }

  {
    std::lock_guard<std::mutex> lock(impl_->frame_mutex);
    impl_->frame = livekit::VideoFrame::create(config.width, config.height,
                                               livekit::VideoBufferType::BGRA);
    impl_->frame_width = config.width;
    impl_->frame_height = config.height;
  }

  impl_->publishing.store(true, std::memory_order_release);
  if (metrics) {
    metrics->SetResolution(config.width, config.height);
    metrics->SetState(State::kPublishing);
  }
  return PublishStatus::kOk;
}

void LiveKitPublisher::Stop() {
  if (!impl_) return;

  impl_->publishing.store(false, std::memory_order_release);

  {
    std::lock_guard<std::mutex> lock(impl_->frame_mutex);
    impl_->frame.reset();
  }

  impl_->track.reset();
  impl_->source.reset();

  if (impl_->room) {
    // Safe here because Stop() is never called from a delegate callback —
    // doing so would deadlock the SDK's event listener.
    try {
      impl_->room->disconnect(livekit::DisconnectReason::ClientInitiated);
    } catch (const std::exception&) {
      // Already down; nothing useful to do while tearing down.
    }
    impl_->room.reset();
  }
  // Only now, with the Room gone, is it safe to drop the delegate.
  impl_->delegate.reset();
}

bool LiveKitPublisher::publishing() const {
  return impl_ && impl_->publishing.load(std::memory_order_acquire);
}

void LiveKitPublisher::SubmitFrame(const FrameView& view) {
  if (!impl_ || !impl_->publishing.load(std::memory_order_acquire)) return;
  if (view.data == nullptr || view.width <= 0 || view.height <= 0) return;

  // Frames arriving mid-reconnect are dropped, not queued. A queue would
  // deliver a burst of stale desktop the moment the link recovers, which is
  // worse than a brief freeze — the viewer would be looking at the past
  // without knowing it.
  if (impl_->delegate && impl_->delegate->reconnecting()) {
    if (impl_->metrics) impl_->metrics->OnFrameDropped();
    return;
  }

  std::lock_guard<std::mutex> lock(impl_->frame_mutex);
  if (!impl_->frame) return;

  // Scaling belongs to the capture session; a size mismatch here means the two
  // disagree, and silently cropping would hide that.
  if (view.width != impl_->frame_width || view.height != impl_->frame_height) {
    if (impl_->metrics) impl_->metrics->OnFrameDropped();
    return;
  }

  std::uint8_t* dst = impl_->frame->data();
  if (dst == nullptr) return;

  // Row by row, never a single bulk copy. The SDK's buffer is tightly packed
  // (planeInfos() hardcodes stride = width*4 for BGRA) while a D3D11 staging
  // texture's RowPitch is only guaranteed >= width*4 and is normally padded.
  // Copying RowPitch*height in one go renders as a skewed image.
  const int row_bytes = impl_->frame_width * 4;
  const std::uint8_t* src = view.data;
  for (int y = 0; y < impl_->frame_height; ++y) {
    std::memcpy(dst + static_cast<size_t>(y) * row_bytes,
                src + static_cast<size_t>(y) * view.stride, static_cast<size_t>(row_bytes));
  }

  try {
    // BGRA goes in directly. Converting to I420 first would be strictly slower:
    // it costs a full FFI round-trip plus a copy back into a new C++ buffer,
    // and the Rust side then converts into an I420Buffer regardless.
    impl_->source->captureFrame(*impl_->frame);
  } catch (const std::exception&) {
    // captureFrame issues a synchronous FFI request and throws on a malformed
    // response. An uncaught throw here would kill the capture thread and take
    // the whole session down with it.
    if (impl_->metrics) impl_->metrics->OnFrameDropped();
    return;
  }

  if (impl_->metrics) {
    if (view.repeated) {
      impl_->metrics->OnFrameRepeated();
    } else {
      impl_->metrics->OnFrameCaptured();
    }
  }
}

TransportStats LiveKitPublisher::Stats() const {
  TransportStats stats;
  if (!impl_ || !impl_->room) return stats;
  if (!impl_->publishing.load(std::memory_order_acquire)) return stats;

  // getStats() throws synchronously when the room is not connected, which can
  // race with a disconnect between the check above and the call.
  try {
    auto future = impl_->room->getStats();
    if (future.wait_for(std::chrono::milliseconds(200)) != std::future_status::ready) {
      return stats;  // never block the metrics timer on the network
    }
    // TODO(V06): map SessionStats onto TransportStats once the quality panel
    // pins down which RTCStats members it needs. Deliberately left unmapped
    // rather than filled with plausible-looking numbers.
    (void)future.get();
  } catch (const std::exception&) {
    // Fall through with zeroed stats.
  }
  return stats;
}

}  // namespace engosoft::media
