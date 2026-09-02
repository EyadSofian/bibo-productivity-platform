#include "agent_ipc.h"

// clang-format off
#include <windows.h>
#include <tlhelp32.h>
// clang-format on

#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "json.h"

namespace engosoft::media {
namespace {

// One ReadFile chunk. A message that does not fit comes back as ERROR_MORE_DATA
// and is appended until complete.
constexpr DWORD kReadChunkBytes = 8192;

// Waiting longer than this for a busy pipe means the agent is not answering;
// the sidecar exits rather than lingering.
constexpr DWORD kConnectTimeoutMs = 5000;

std::int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

// The parent process ID, or 0 if it cannot be determined. Toolhelp is used
// rather than NtQueryInformationProcess so this stays on documented API.
std::uint32_t ParentProcessId() {
  const DWORD self = GetCurrentProcessId();
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;

  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  std::uint32_t parent = 0;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == self) {
        parent = static_cast<std::uint32_t>(entry.th32ParentProcessID);
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return parent;
}

}  // namespace

std::string PipeNameForAgent(std::uint32_t agent_pid) {
  return "\\\\.\\pipe\\engosoft-media-" + std::to_string(agent_pid);
}

struct AgentIpc::Impl {
  HANDLE pipe = INVALID_HANDLE_VALUE;
  std::atomic<bool> connected{false};
  std::atomic<bool> stopping{false};

  std::thread reader;
  IpcHandlers handlers;

  std::mutex write_mutex;
  std::atomic<std::uint64_t> next_id{1};

  // Last state pushed to the agent, so `ping` can be answered without asking
  // the owner for it. The sidecar sends `state` on every transition, so this is
  // always the current one.
  std::mutex state_mutex;
  std::string state_session_id;
  State state_value = State::kIdle;
  FailureReason state_reason = FailureReason::kNone;

  std::string NextId() {
    // Correlation only; uniqueness within this process is enough and a
    // predictable id keeps logs readable.
    return "s" + std::to_string(GetCurrentProcessId()) + "-" +
           std::to_string(next_id.fetch_add(1, std::memory_order_relaxed));
  }

  void Write(const std::string& type, const std::string& payload, const std::string& id);
  void Ack(const std::string& request_id, bool ok, const char* error);
  void Log(const std::string& level, const std::string& message,
           const std::map<std::string, std::string>& fields);
  void ReaderLoop();
  void Dispatch(const json::Value& envelope, std::string& raw);
};

void AgentIpc::Impl::Write(const std::string& type, const std::string& payload,
                           const std::string& id) {
  if (!connected.load(std::memory_order_acquire)) return;

  std::string message;
  message.reserve(payload.size() + 128);
  message += "{\"v\":1,\"id\":\"";
  message += EscapeJson(id);
  message += "\",\"type\":\"";
  message += EscapeJson(type);
  message += "\",\"ts_ms\":";
  message += std::to_string(NowMs());
  message += ",\"payload\":";
  message += payload;
  message += '}';

  std::lock_guard<std::mutex> lock(write_mutex);
  if (pipe == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  // One WriteFile is one message on a message-mode pipe, so there is no framing
  // to get wrong and no partial-write loop to write.
  if (!WriteFile(pipe, message.data(), static_cast<DWORD>(message.size()), &written, nullptr)) {
    connected.store(false, std::memory_order_release);
  }
}

void AgentIpc::Impl::Ack(const std::string& request_id, bool ok, const char* error) {
  std::string payload = "{\"for\":\"" + EscapeJson(request_id) + "\",\"ok\":";
  payload += ok ? "true" : "false";
  payload += ",\"error\":";
  payload += (error == nullptr) ? "null" : "\"" + EscapeJson(error) + "\"";
  payload += '}';
  // The envelope id echoes the request as well, so either field correlates.
  Write("ack", payload, request_id);
}

void AgentIpc::Impl::Log(const std::string& level, const std::string& message,
                         const std::map<std::string, std::string>& fields) {
  Write("log", BuildLogPayload(level, message, fields), NextId());
}

void AgentIpc::Impl::Dispatch(const json::Value& envelope, std::string& raw) {
  const std::string type = envelope.StringOr("type");
  const std::string id = envelope.StringOr("id");
  const json::Value* payload = envelope.Find("payload");

  if (type == "start_session") {
    if (payload == nullptr || !payload->is_object()) {
      Ack(id, false, "bad_payload");
      return;
    }
    // const_cast: TakeString has to move the token out of the tree and zero the
    // bytes behind it. Parsing yields an owned tree, so this mutates only our
    // own copy.
    auto& mutable_payload = const_cast<json::Value&>(*payload);

    StartSessionRequest request;
    request.session_id = mutable_payload.StringOr("session_id");
    request.room = mutable_payload.StringOr("room");
    request.livekit_url = mutable_payload.StringOr("livekit_url");
    request.publisher_token = mutable_payload.TakeString("publisher_token");
    request.track_name = mutable_payload.StringOr("track_name", "screen0");
    // `display_id` is the protocol's name; `display_index` is accepted as an
    // alias so an older agent build still works.
    request.display_index = mutable_payload.IntOr(
        "display_id", mutable_payload.IntOr("display_index", 0));

    if (const json::Value* video = mutable_payload.Find("video"); video != nullptr) {
      request.width = video->IntOr("width", request.width);
      request.height = video->IntOr("height", request.height);
      request.fps = video->IntOr("fps", request.fps);
    }

    const bool usable = !request.session_id.empty() && !request.room.empty() &&
                        !request.livekit_url.empty() && !request.publisher_token.empty();
    if (!usable) {
      json::ScrubString(request.publisher_token);
      Ack(id, false, "incomplete");
      return;
    }

    {
      std::lock_guard<std::mutex> lock(state_mutex);
      state_session_id = request.session_id;
    }
    Ack(id, true, nullptr);

    // The raw message still holds the token; zero it before the handler starts
    // the (slow) connect, so it is never sitting in a stale buffer.
    json::ScrubString(raw);
    if (handlers.on_start) {
      handlers.on_start(std::move(request));
    } else {
      json::ScrubString(request.publisher_token);
    }
    return;
  }

  if (type == "stop_session") {
    StopSessionRequest request;
    if (payload != nullptr) {
      request.session_id = payload->StringOr("session_id");
      request.reason = payload->StringOr("reason", "owner_closed");
    }
    if (handlers.on_stop) handlers.on_stop(request);
    Ack(id, true, nullptr);
    return;
  }

  if (type == "emergency_stop") {
    const std::string reason = payload != nullptr ? payload->StringOr("reason", "emergency_stop")
                                                  : std::string("emergency_stop");
    // Capture stops before the ack is written. An ack that never arrives
    // therefore still means capture is down — the process died instead.
    if (handlers.on_emergency_stop) handlers.on_emergency_stop(reason);
    Ack(id, true, nullptr);
    return;
  }

  if (type == "update_policy") {
    PolicyUpdate update;
    if (payload != nullptr) {
      if (const json::Value* video = payload->Find("video"); video != nullptr) {
        if (const json::Value* fps = video->Find("fps"); fps != nullptr && fps->is_number()) {
          update.has_fps = true;
          update.fps = video->IntOr("fps", 0);
        }
      }
      if (const json::Value* blackout = payload->Find("privacy_blackout");
          blackout != nullptr && blackout->is_bool()) {
        update.has_blackout = true;
        update.blackout = blackout->boolean;
      }
    }
    if (handlers.on_policy) handlers.on_policy(update);
    Ack(id, true, nullptr);
    return;
  }

  if (type == "ping") {
    std::string session_id;
    State state = State::kIdle;
    FailureReason reason = FailureReason::kNone;
    {
      std::lock_guard<std::mutex> lock(state_mutex);
      session_id = state_session_id;
      state = state_value;
      reason = state_reason;
    }
    std::string payload_json = "{\"session_id\":\"" + EscapeJson(session_id) + "\",\"state\":\"" +
                               ToString(state) + "\",\"reason\":";
    payload_json += reason == FailureReason::kNone
                        ? "null"
                        : "\"" + std::string(ToString(reason)) + "\"";
    payload_json += '}';
    Write("pong", payload_json, id);
    return;
  }

  // Unknown types are a warning, not a fatal error, so the two ends can be
  // upgraded independently.
  Log("warn", "ignored unknown message type", {{"type", type}});
}

void AgentIpc::Impl::ReaderLoop() {
  std::vector<char> chunk(kReadChunkBytes);
  std::string message;
  bool discarding = false;

  while (!stopping.load(std::memory_order_acquire)) {
    DWORD read = 0;
    const BOOL ok = ReadFile(pipe, chunk.data(), static_cast<DWORD>(chunk.size()), &read, nullptr);
    const DWORD error = ok ? ERROR_SUCCESS : GetLastError();

    if (!ok && error != ERROR_MORE_DATA) {
      // ERROR_OPERATION_ABORTED is our own CancelIoEx during Stop; anything
      // else means the agent's end of the pipe is gone.
      break;
    }

    if (!discarding) {
      if (message.size() + read > json::kMaxDocumentBytes) {
        // Refuse rather than grow without bound. The remaining chunks of this
        // message are read and thrown away so the stream stays aligned.
        discarding = true;
        json::ScrubString(message);
      } else {
        message.append(chunk.data(), read);
      }
    }

    if (error == ERROR_MORE_DATA) continue;  // more of the same message follows

    if (discarding) {
      discarding = false;
      Log("warn", "dropped oversized IPC message", {});
      continue;
    }
    if (message.empty()) continue;

    if (auto parsed = json::Parse(message); parsed.has_value()) {
      if (parsed->IntOr("v", 1) != 1) {
        Log("warn", "ignored message with unsupported envelope version", {});
      } else {
        Dispatch(*parsed, message);
      }
      json::Scrub(*parsed);
    } else {
      Log("warn", "ignored malformed IPC message", {});
    }

    // The buffer may have held a publisher token.
    json::ScrubString(message);
  }

  const bool deliberate = stopping.load(std::memory_order_acquire);
  connected.store(false, std::memory_order_release);
  if (!deliberate && handlers.on_disconnected) {
    // The agent is gone. Capture must stop; the sidecar must not outlive the
    // process that authorized it.
    handlers.on_disconnected();
  }
}

AgentIpc::AgentIpc() : impl_(std::make_unique<Impl>()) {}

AgentIpc::~AgentIpc() { Stop(); }

bool AgentIpc::Connect(std::uint32_t agent_pid) {
  if (agent_pid == 0) return false;

  // The agent must be this process's parent. A pipe named for some other PID —
  // or squatted by a third process — is refused before a byte is exchanged.
  const std::uint32_t parent = ParentProcessId();
  if (parent == 0 || parent != agent_pid) return false;

  const std::string name = PipeNameForAgent(agent_pid);
  const std::wstring wide(name.begin(), name.end());

  HANDLE pipe = INVALID_HANDLE_VALUE;
  for (;;) {
    pipe = CreateFileW(wide.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                       0, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) break;
    if (GetLastError() != ERROR_PIPE_BUSY) return false;
    if (!WaitNamedPipeW(wide.c_str(), kConnectTimeoutMs)) return false;
  }

  // Verify the peer actually is the agent. Without this, any process that won
  // the race to create the pipe name would receive the publisher token.
  ULONG server_pid = 0;
  if (!GetNamedPipeServerProcessId(pipe, &server_pid) ||
      static_cast<std::uint32_t>(server_pid) != agent_pid) {
    CloseHandle(pipe);
    return false;
  }

  DWORD mode = PIPE_READMODE_MESSAGE;
  if (!SetNamedPipeHandleState(pipe, &mode, nullptr, nullptr)) {
    CloseHandle(pipe);
    return false;
  }

  impl_->pipe = pipe;
  impl_->connected.store(true, std::memory_order_release);
  impl_->stopping.store(false, std::memory_order_release);
  return true;
}

void AgentIpc::Run(IpcHandlers handlers) {
  if (!impl_->connected.load(std::memory_order_acquire)) return;
  if (impl_->reader.joinable()) return;
  impl_->handlers = std::move(handlers);
  Impl* impl = impl_.get();
  impl_->reader = std::thread([impl] { impl->ReaderLoop(); });
}

void AgentIpc::Stop() {
  if (!impl_) return;
  if (impl_->stopping.exchange(true, std::memory_order_acq_rel)) {
    if (impl_->reader.joinable()) impl_->reader.join();
    return;
  }

  if (impl_->pipe != INVALID_HANDLE_VALUE) {
    // Unblocks the reader's ReadFile; without it the thread would sit until the
    // agent happened to send something.
    CancelIoEx(impl_->pipe, nullptr);
  }
  if (impl_->reader.joinable()) impl_->reader.join();

  {
    std::lock_guard<std::mutex> lock(impl_->write_mutex);
    if (impl_->pipe != INVALID_HANDLE_VALUE) {
      CloseHandle(impl_->pipe);
      impl_->pipe = INVALID_HANDLE_VALUE;
    }
  }
  impl_->connected.store(false, std::memory_order_release);
}

bool AgentIpc::connected() const {
  return impl_ && impl_->connected.load(std::memory_order_acquire);
}

void AgentIpc::SendState(const std::string& session_id, State state, FailureReason reason) {
  {
    std::lock_guard<std::mutex> lock(impl_->state_mutex);
    impl_->state_session_id = session_id;
    impl_->state_value = state;
    impl_->state_reason = reason;
  }

  std::string payload = "{\"session_id\":\"" + EscapeJson(session_id) + "\",\"state\":\"" +
                        ToString(state) + "\",\"reason\":";
  payload += reason == FailureReason::kNone ? "null" : "\"" + std::string(ToString(reason)) + "\"";
  payload += '}';
  impl_->Write("state", payload, impl_->NextId());
}

void AgentIpc::SendMetrics(const Snapshot& snapshot) {
  // ToJson has no field that could carry a token, a signed URL, or pixel data —
  // redaction is structural rather than a filter that could be forgotten.
  impl_->Write("metrics", ToJson(snapshot), impl_->NextId());
}

void AgentIpc::SendAck(const std::string& request_id, bool ok, const std::string& error) {
  impl_->Ack(request_id, ok, error.empty() ? nullptr : error.c_str());
}

void AgentIpc::SendLog(const std::string& level, const std::string& message,
                       const std::map<std::string, std::string>& fields) {
  impl_->Log(level, message, fields);
}

}  // namespace engosoft::media
