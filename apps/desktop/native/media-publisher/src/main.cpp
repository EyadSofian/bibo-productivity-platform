// media-publisher — the Windows media sidecar.
//
// Captures one display with Windows Graphics Capture and publishes it to a
// LiveKit room as a video track. It is driven entirely over the named pipe
// described in docs/ipc-protocol.md; the Rust agent is the server.
//
// WHAT THIS PROCESS DELIBERATELY CANNOT DO
//   * It holds no API key or secret, and cannot mint a token. It receives a
//     short-lived publish-only JWT over the pipe and nothing else.
//   * It accepts no token on the command line. On Windows another process in
//     the same session can read a command line.
//   * It writes no image file, ever. There is no encoder for one and no path
//     that opens a file for writing.
//   * It cannot disable the system capture border. No message carries that
//     field and the API that would do it is never called.
//   * It does not outlive the agent. A broken pipe stops capture and exits.

// clang-format off
#include <windows.h>
#include <psapi.h>
// clang-format on

#include <winrt/Windows.Foundation.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "agent_ipc.h"
#include "capture_session.h"
#include "json.h"
#include "livekit_publisher.h"
#include "metrics.h"

namespace engosoft::media {
namespace {

constexpr char kVersion[] = "0.1.0";

// How often metrics are sampled and pushed to the agent.
constexpr auto kMetricsInterval = std::chrono::seconds(2);

using Clock = std::chrono::steady_clock;

// Process CPU as a share of one core, sampled between calls. Reported rather
// than derived from a single reading, so a long-running process does not report
// its lifetime average.
class CpuSampler {
 public:
  double SamplePercent() {
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user)) return 0.0;

    const auto to_ns100 = [](FILETIME ft) {
      ULARGE_INTEGER value{};
      value.LowPart = ft.dwLowDateTime;
      value.HighPart = ft.dwHighDateTime;
      return value.QuadPart;
    };
    const std::uint64_t busy = to_ns100(kernel) + to_ns100(user);
    const auto now = Clock::now();

    double percent = 0.0;
    if (last_sample_.time_since_epoch().count() != 0) {
      const double wall_ns100 =
          std::chrono::duration_cast<std::chrono::nanoseconds>(now - last_sample_).count() / 100.0;
      if (wall_ns100 > 0.0) {
        percent = 100.0 * static_cast<double>(busy - last_busy_) / wall_ns100;
      }
    }
    last_busy_ = busy;
    last_sample_ = now;
    return percent;
  }

 private:
  std::uint64_t last_busy_ = 0;
  Clock::time_point last_sample_{};
};

double WorkingSetMb() {
  PROCESS_MEMORY_COUNTERS counters{};
  counters.cb = sizeof(counters);
  if (!GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters))) return 0.0;
  return static_cast<double>(counters.WorkingSetSize) / (1024.0 * 1024.0);
}

// Owns the whole pipeline and the lifecycle rules around it.
class Sidecar {
 public:
  int Run(std::uint32_t agent_pid);

 private:
  enum class Command { kStart, kStop };

  struct Job {
    Command command = Command::kStop;
    StartSessionRequest start;
    std::string reason;
  };

  void Enqueue(Job job);
  void WorkerLoop();
  void MetricsLoop();

  void DoStart(StartSessionRequest request);
  void DoStop(const std::string& reason);

  void PublishState(State state, FailureReason reason = FailureReason::kNone);

  // The session id is read from SDK threads and the metrics thread while the
  // worker thread rewrites it, so it never leaves this pair of accessors.
  std::string SessionId();
  void SetSessionId(std::string id);

  AgentIpc ipc_;
  CaptureSession capture_;
  LiveKitPublisher publisher_;
  Metrics metrics_;

  // Serializes DoStart against DoStop so a stop arriving mid-connect cannot
  // tear down objects the start is still building.
  std::mutex session_mutex_;
  std::mutex id_mutex_;
  std::string session_id_;
  std::atomic<bool> stop_requested_{false};
  std::atomic<bool> publishing_{false};

  std::mutex queue_mutex_;
  std::condition_variable queue_cv_;
  std::deque<Job> queue_;
  std::atomic<bool> quit_{false};

  std::atomic<bool> shutdown_{false};
  std::mutex shutdown_mutex_;
  std::condition_variable shutdown_cv_;
};

std::string Sidecar::SessionId() {
  std::lock_guard<std::mutex> lock(id_mutex_);
  return session_id_;
}

void Sidecar::SetSessionId(std::string id) {
  std::lock_guard<std::mutex> lock(id_mutex_);
  session_id_ = std::move(id);
}

void Sidecar::PublishState(State state, FailureReason reason) {
  metrics_.SetState(state, reason);
  ipc_.SendState(SessionId(), state, reason);
}

void Sidecar::Enqueue(Job job) {
  {
    std::lock_guard<std::mutex> lock(queue_mutex_);
    queue_.push_back(std::move(job));
  }
  queue_cv_.notify_one();
}

void Sidecar::DoStart(StartSessionRequest request) {
  std::lock_guard<std::mutex> lock(session_mutex_);
  if (stop_requested_.load(std::memory_order_acquire)) {
    json::ScrubString(request.publisher_token);
    return;
  }

  SetSessionId(request.session_id);
  metrics_.SetSessionId(request.session_id);
  PublishState(State::kStarting);

  if (!CaptureSession::IsSupported()) {
    // Reported, never worked around. Falling back to a capture API with no
    // on-screen indicator is the one thing this product must not do.
    json::ScrubString(request.publisher_token);
    PublishState(State::kFailed, FailureReason::kCaptureUnsupported);
    return;
  }

  PublishConfig publish_config;
  publish_config.livekit_url = request.livekit_url;
  publish_config.room = request.room;
  publish_config.track_name = request.track_name;
  publish_config.width = request.width;
  publish_config.height = request.height;
  publish_config.fps = request.fps;

  PublishState(State::kConnecting);

  // The publisher goes up first: capture must have somewhere to put frames
  // before it starts producing them.
  const PublishStatus status = publisher_.Start(
      publish_config, std::move(request.publisher_token),
      [this, id = request.session_id](State state, FailureReason reason) {
        // Fires on SDK threads during reconnect and disconnect. The id is
        // captured by value so this cannot race the worker rewriting it.
        ipc_.SendState(id, state, reason);
        if (state == State::kStopped || state == State::kFailed) {
          publishing_.store(false, std::memory_order_release);
        }
      },
      &metrics_);
  json::ScrubString(request.publisher_token);

  if (status != PublishStatus::kOk) {
    PublishState(State::kFailed, ToFailureReason(status));
    publisher_.Stop();
    return;
  }

  CaptureConfig capture_config;
  capture_config.display_index = request.display_index;
  capture_config.width = request.width;
  capture_config.height = request.height;
  capture_config.fps = request.fps;
  capture_config.capture_cursor = true;

  const CaptureStatus capture_status = capture_.Start(
      capture_config, [this](const FrameView& frame) { publisher_.SubmitFrame(frame); }, &metrics_);

  if (capture_status != CaptureStatus::kOk) {
    publisher_.Stop();
    PublishState(State::kFailed, ToFailureReason(capture_status));
    return;
  }

  if (stop_requested_.load(std::memory_order_acquire)) {
    // A stop landed while we were connecting. Honour it rather than publishing
    // a session the owner has already ended.
    capture_.Stop();
    publisher_.Stop();
    PublishState(State::kStopped);
    return;
  }

  publishing_.store(true, std::memory_order_release);
  PublishState(State::kPublishing);
  ipc_.SendLog("info", "publishing",
               {{"room", request.room},
                {"display_index", std::to_string(request.display_index)},
                {"fps", std::to_string(request.fps)},
                {"border_enabled", capture_.BorderEnabled() ? "true" : "false"}});
}

void Sidecar::DoStop(const std::string& reason) {
  std::lock_guard<std::mutex> lock(session_mutex_);
  const bool was_publishing = publishing_.exchange(false, std::memory_order_acq_rel);

  PublishState(State::kStopping);
  capture_.Stop();
  publisher_.Stop();

  if (was_publishing || !SessionId().empty()) {
    ipc_.SendLog("info", "session stopped", {{"reason", reason}});
  }
  PublishState(State::kStopped);
  SetSessionId({});
  stop_requested_.store(false, std::memory_order_release);
}

void Sidecar::WorkerLoop() {
  for (;;) {
    Job job;
    {
      std::unique_lock<std::mutex> lock(queue_mutex_);
      queue_cv_.wait(lock, [this] { return quit_.load(std::memory_order_acquire) || !queue_.empty(); });
      if (queue_.empty()) {
        if (quit_.load(std::memory_order_acquire)) return;
        continue;
      }
      job = std::move(queue_.front());
      queue_.pop_front();
    }

    if (job.command == Command::kStart) {
      DoStart(std::move(job.start));
    } else {
      DoStop(job.reason);
    }
  }
}

void Sidecar::MetricsLoop() {
  CpuSampler cpu;
  cpu.SamplePercent();  // prime the delta
  auto last = Clock::now();

  while (!shutdown_.load(std::memory_order_acquire)) {
    {
      std::unique_lock<std::mutex> lock(shutdown_mutex_);
      shutdown_cv_.wait_for(lock, kMetricsInterval,
                            [this] { return shutdown_.load(std::memory_order_acquire); });
    }
    if (shutdown_.load(std::memory_order_acquire)) break;

    const auto now = Clock::now();
    const double elapsed = std::chrono::duration<double>(now - last).count();
    last = now;

    // A capture failure detected on a WinRT threadpool thread surfaces here, so
    // teardown never runs inside the event handler that reported it.
    const CaptureStatus capture_status = capture_.status();
    if (capture_status != CaptureStatus::kOk && publishing_.load(std::memory_order_acquire)) {
      publishing_.store(false, std::memory_order_release);
      ipc_.SendState(SessionId(), State::kFailed, ToFailureReason(capture_status));
      Enqueue({Command::kStop, {}, ToString(capture_status)});
      continue;
    }

    if (!publishing_.load(std::memory_order_acquire)) continue;

    const TransportStats transport = publisher_.Stats();
    metrics_.SetTransport(transport.bitrate_bps, transport.rtt_ms, transport.packet_loss);
    metrics_.SetProcessUsage(cpu.SamplePercent(), WorkingSetMb());
    metrics_.Tick(elapsed);
    ipc_.SendMetrics(metrics_.Get());
  }
}

int Sidecar::Run(std::uint32_t agent_pid) {
  if (!ipc_.Connect(agent_pid)) {
    std::fprintf(stderr,
                 "{\"level\":\"error\",\"msg\":\"could not connect to the agent pipe or the peer "
                 "was not the expected parent process\",\"fields\":{}}\n");
    return 3;
  }

  std::thread worker([this] { WorkerLoop(); });
  std::thread metrics_thread([this] { MetricsLoop(); });

  IpcHandlers handlers;
  handlers.on_start = [this](StartSessionRequest&& request) {
    stop_requested_.store(false, std::memory_order_release);
    Job job;
    job.command = Command::kStart;
    job.start = std::move(request);
    Enqueue(std::move(job));
  };
  handlers.on_stop = [this](const StopSessionRequest& request) {
    stop_requested_.store(true, std::memory_order_release);
    Enqueue({Command::kStop, {}, request.reason});
  };
  handlers.on_emergency_stop = [this](const std::string& reason) {
    // Runs on the IPC reader thread and must return in well under 500 ms, so it
    // does no network work and takes no lock that a slow connect could hold.
    //
    // Blackout is the immediate guarantee: it is an atomic store, and capture
    // checks it before reading a single pixel off the GPU, so real pixels stop
    // within one frame interval (<= 67 ms at 15 FPS) even while the orderly
    // teardown is still queued behind a connect in progress.
    stop_requested_.store(true, std::memory_order_release);
    capture_.SetBlackout(true);
    Enqueue({Command::kStop, {}, reason});
  };
  handlers.on_policy = [this](const PolicyUpdate& update) {
    if (update.has_fps) capture_.SetTargetFps(update.fps);
    if (update.has_blackout) capture_.SetBlackout(update.blackout);
  };
  handlers.on_disconnected = [this] {
    // The agent died. A media process that outlives the agent that authorized
    // it is exactly the failure this design prevents.
    shutdown_.store(true, std::memory_order_release);
    shutdown_cv_.notify_all();
  };

  ipc_.Run(std::move(handlers));

  {
    std::unique_lock<std::mutex> lock(shutdown_mutex_);
    shutdown_cv_.wait(lock, [this] { return shutdown_.load(std::memory_order_acquire); });
  }

  // Capture goes down before anything else, whatever else is still in flight.
  capture_.SetBlackout(true);
  capture_.Stop();

  quit_.store(true, std::memory_order_release);
  queue_cv_.notify_all();
  shutdown_cv_.notify_all();
  if (worker.joinable()) worker.join();
  if (metrics_thread.joinable()) metrics_thread.join();

  publisher_.Stop();
  ipc_.Stop();
  return 0;
}

// Runs the real WGC capture path for a few seconds and reports what it
// measured. No frame is written anywhere: the callback only counts.
//
// This exists so the capture half can be verified on a Windows machine without
// a LiveKit room or an agent. It is a diagnostic of the real pipeline, not a
// substitute for one — nothing here can stand in as evidence that publishing
// works.
int CaptureProbe(int seconds, int display_index, int width, int height, int fps) {
  if (!CaptureSession::IsSupported()) {
    std::printf("capture: UNSUPPORTED (GraphicsCaptureSession::IsSupported() == false)\n");
    return 4;
  }
  std::printf("capture: supported, displays=%d\n", CaptureSession::DisplayCount());

  Metrics metrics;
  CaptureSession capture;

  std::atomic<int> frames{0};
  std::atomic<int> repeats{0};
  std::atomic<std::uint64_t> checksum{0};

  CaptureConfig config;
  config.display_index = display_index;
  config.width = width;
  config.height = height;
  config.fps = fps;

  CpuSampler cpu;
  cpu.SamplePercent();  // prime the delta so the reading covers the run, not the process lifetime

  const auto started = Clock::now();
  const CaptureStatus status = capture.Start(
      config,
      [&](const FrameView& frame) {
        if (frame.repeated) {
          repeats.fetch_add(1, std::memory_order_relaxed);
        } else {
          frames.fetch_add(1, std::memory_order_relaxed);
        }
        // Touch the pixels so the compiler cannot optimise the path away and
        // the timing reflects a real consumer. Sampled, never stored.
        std::uint64_t sum = 0;
        for (int y = 0; y < frame.height; y += 32) {
          const std::uint8_t* row = frame.data + static_cast<std::size_t>(y) * frame.stride;
          for (int x = 0; x < frame.width * 4; x += 128) sum += row[x];
        }
        checksum.fetch_add(sum, std::memory_order_relaxed);
      },
      &metrics);

  if (status != CaptureStatus::kOk) {
    std::printf("capture: START FAILED (%s)\n", ToString(status));
    return 5;
  }

  std::this_thread::sleep_for(std::chrono::seconds(seconds));
  const double wall = std::chrono::duration<double>(Clock::now() - started).count();
  const CaptureStatus final_status = capture.status();

  const auto stop_started = Clock::now();
  capture.Stop();
  const double stop_ms = std::chrono::duration<double, std::milli>(Clock::now() - stop_started).count();

  const int new_frames = frames.load();
  const int repeated = repeats.load();
  std::printf("capture: backend=%s border=%s status=%s\n",
              ToString(metrics.Get().backend), capture.BorderEnabled() ? "on" : "off",
              ToString(final_status));
  std::printf("capture: %dx%d target %d fps over %.2fs\n", width, height, fps, wall);
  std::printf("capture: new frames    %d (%.2f/s)\n", new_frames, new_frames / wall);
  std::printf("capture: repeated      %d (%.2f/s)\n", repeated, repeated / wall);
  std::printf("capture: delivered     %d (%.2f/s)\n", new_frames + repeated,
              (new_frames + repeated) / wall);
  std::printf("capture: stop latency  %.1f ms\n", stop_ms);
  std::printf("capture: pixel sum     %llu (sampled, never stored)\n",
              static_cast<unsigned long long>(checksum.load()));
  std::printf("capture: process CPU   %.1f%% of one core\n", cpu.SamplePercent());
  std::printf("capture: working set   %.1f MB\n", WorkingSetMb());
  return (new_frames + repeated) > 0 && final_status == CaptureStatus::kOk ? 0 : 6;
}

void PrintUsage() {
  std::printf(
      "media-publisher %s\n"
      "\n"
      "  --agent-pid=<pid>        run as a sidecar of that agent process (normal mode)\n"
      "  --capture-probe[=secs]   run the real capture path and report measurements\n"
      "  --display=<index>        probe: display to capture (default 0, the primary)\n"
      "  --size=<w>x<h>           probe: target resolution (default 1280x720)\n"
      "  --fps=<n>                probe: target frame rate (default 15)\n"
      "  --self-test              report capture support and exit\n"
      "  --version                print the version and exit\n"
      "\n"
      "The publisher token is never accepted on the command line. It arrives\n"
      "only over the agent pipe, after both ends verify the other's process id.\n",
      kVersion);
}

bool MatchOption(const char* arg, const char* name, const char** value) {
  const std::size_t len = std::strlen(name);
  if (std::strncmp(arg, name, len) != 0) return false;
  if (arg[len] == '\0') {
    *value = nullptr;
    return true;
  }
  if (arg[len] == '=') {
    *value = arg + len + 1;
    return true;
  }
  return false;
}

}  // namespace
}  // namespace engosoft::media

int main(int argc, char** argv) {
  using namespace engosoft::media;

  std::uint32_t agent_pid = 0;
  int probe_seconds = 0;
  bool probe = false;
  bool self_test = false;
  int display_index = 0;
  int width = 1280;
  int height = 720;
  int fps = 15;

  for (int i = 1; i < argc; ++i) {
    const char* value = nullptr;
    if (MatchOption(argv[i], "--agent-pid", &value) && value != nullptr) {
      agent_pid = static_cast<std::uint32_t>(std::strtoul(value, nullptr, 10));
    } else if (MatchOption(argv[i], "--capture-probe", &value)) {
      probe = true;
      probe_seconds = value != nullptr ? std::atoi(value) : 5;
    } else if (MatchOption(argv[i], "--display", &value) && value != nullptr) {
      display_index = std::atoi(value);
    } else if (MatchOption(argv[i], "--fps", &value) && value != nullptr) {
      fps = std::atoi(value);
    } else if (MatchOption(argv[i], "--size", &value) && value != nullptr) {
      const char* x = std::strchr(value, 'x');
      if (x != nullptr) {
        width = std::atoi(value);
        height = std::atoi(x + 1);
      }
    } else if (MatchOption(argv[i], "--self-test", &value)) {
      self_test = true;
    } else if (MatchOption(argv[i], "--version", &value)) {
      std::printf("media-publisher %s\n", kVersion);
      return 0;
    } else {
      PrintUsage();
      return 2;
    }
  }

  // Multi-threaded apartment: the frame pool is created free-threaded and
  // dispatches FrameArrived on a threadpool thread, so there is no message pump
  // and no single-threaded apartment to marshal back to.
  winrt::init_apartment(winrt::apartment_type::multi_threaded);

  if (self_test) {
    const bool supported = CaptureSession::IsSupported();
    std::printf("media-publisher %s\n", kVersion);
    std::printf("capture supported : %s\n", supported ? "yes" : "no");
    std::printf("displays          : %d\n", CaptureSession::DisplayCount());
    std::printf("capture border    : always on (never disabled by this build)\n");
    return supported ? 0 : 4;
  }

  if (probe) {
    return CaptureProbe(probe_seconds > 0 ? probe_seconds : 5, display_index, width, height, fps);
  }

  if (agent_pid == 0) {
    PrintUsage();
    return 2;
  }

  Sidecar sidecar;
  return sidecar.Run(agent_pid);
}
