// ipc_test — end-to-end exercise of the agent pipe.
//
// This is not a unit test of a serializer. The test process becomes the agent:
// it creates the real named pipe, spawns itself as a child, and the child
// connects through AgentIpc exactly as the sidecar does. That is the only way
// to cover the parts that are easy to get wrong and impossible to see in
// isolation — the peer-PID check, message framing, and the promise that a token
// handed in over the pipe never comes back out in a log.
//
// Parent mode (no arguments) runs the assertions. `--client=<agent pid>` is the
// child half.

#include "../src/agent_ipc.h"
#include "../src/json.h"
#include "../src/metrics.h"

// clang-format off
#include <windows.h>
// clang-format on

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace engosoft::media;
using Clock = std::chrono::steady_clock;

// The token the parent hands over. It must never reappear in anything the
// child sends back.
constexpr char kToken[] = "eyJhbGciOiJIUzI1NiJ9.SUPERSECRETPAYLOAD.SIGNATURE";

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

// ---------------------------------------------------------------- watchdog ---
// A hung test is worse than a failed one: it stalls a build with no diagnosis.

std::atomic<HANDLE> g_child{nullptr};
HANDLE g_done = nullptr;

void StartWatchdog(DWORD timeout_ms) {
  g_done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::thread([timeout_ms] {
    if (WaitForSingleObject(g_done, timeout_ms) == WAIT_TIMEOUT) {
      std::printf("  FAIL: watchdog fired after %lu ms — the IPC exchange hung\n", timeout_ms);
      std::fflush(stdout);
      HANDLE child = g_child.load();
      if (child != nullptr) TerminateProcess(child, 99);
      std::_Exit(1);
    }
  }).detach();
}

// ------------------------------------------------------------- pipe helpers ---

std::wstring Widen(const std::string& text) { return std::wstring(text.begin(), text.end()); }

bool WaitForMessage(HANDLE pipe, DWORD timeout_ms) {
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  for (;;) {
    DWORD available = 0;
    if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) return false;
    if (available > 0) return true;
    if (Clock::now() >= deadline) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
}

bool ReadMessage(HANDLE pipe, std::string* out) {
  out->clear();
  std::vector<char> chunk(4096);
  for (;;) {
    DWORD read = 0;
    const BOOL ok = ReadFile(pipe, chunk.data(), static_cast<DWORD>(chunk.size()), &read, nullptr);
    out->append(chunk.data(), read);
    if (ok) return true;
    if (GetLastError() != ERROR_MORE_DATA) return false;
  }
}

bool WriteMessage(HANDLE pipe, const std::string& message) {
  DWORD written = 0;
  return WriteFile(pipe, message.data(), static_cast<DWORD>(message.size()), &written, nullptr) != 0;
}

std::string Envelope(const char* id, const char* type, const std::string& payload) {
  return std::string("{\"v\":1,\"id\":\"") + id + "\",\"type\":\"" + type +
         "\",\"ts_ms\":1756800000000,\"payload\":" + payload + "}";
}

// Reads messages until one of `type` arrives, collecting everything seen so a
// failure can show what actually came back.
bool ReadUntil(HANDLE pipe, const char* type, std::string* raw, json::Value* parsed,
               std::vector<std::string>* seen, DWORD timeout_ms = 8000) {
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  while (Clock::now() < deadline) {
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    if (!WaitForMessage(pipe, static_cast<DWORD>(remaining > 0 ? remaining : 0))) return false;
    if (!ReadMessage(pipe, raw)) return false;
    auto value = json::Parse(*raw);
    if (!value.has_value()) return false;
    const std::string actual = value->StringOr("type");
    seen->push_back(actual);
    if (actual == type) {
      *parsed = std::move(*value);
      return true;
    }
  }
  return false;
}

std::string Join(const std::vector<std::string>& items) {
  std::string out;
  for (const auto& item : items) {
    if (!out.empty()) out += ", ";
    out += item;
  }
  return out.empty() ? "(nothing)" : out;
}

// ------------------------------------------------------------------- child ---

int RunClient(std::uint32_t agent_pid) {
  AgentIpc ipc;
  if (!ipc.Connect(agent_pid)) {
    std::printf("  child: Connect(%lu) failed\n", static_cast<unsigned long>(agent_pid));
    return 21;
  }

  HANDLE finished = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  IpcHandlers handlers;
  handlers.on_start = [&ipc](StartSessionRequest&& request) {
    // publisher_token is passed through deliberately: the log path must redact
    // it. If it ever comes out intact the parent fails the test.
    ipc.SendLog("info", "started",
                {{"session_id", request.session_id},
                 {"room", request.room},
                 {"track_name", request.track_name},
                 {"display_index", std::to_string(request.display_index)},
                 {"width", std::to_string(request.width)},
                 {"height", std::to_string(request.height)},
                 {"fps", std::to_string(request.fps)},
                 {"token_len", std::to_string(request.publisher_token.size())},
                 {"publisher_token", request.publisher_token}});
    ipc.SendState(request.session_id, State::kPublishing, FailureReason::kNone);
  };
  handlers.on_policy = [&ipc](const PolicyUpdate& update) {
    ipc.SendLog("info", "policy",
                {{"has_fps", update.has_fps ? "1" : "0"},
                 {"fps", std::to_string(update.fps)},
                 {"has_blackout", update.has_blackout ? "1" : "0"},
                 {"blackout", update.blackout ? "1" : "0"}});
  };
  handlers.on_stop = [&ipc](const StopSessionRequest& request) {
    ipc.SendLog("info", "stopped", {{"reason", request.reason}});
  };
  handlers.on_emergency_stop = [&ipc](const std::string& reason) {
    ipc.SendLog("warn", "emergency", {{"reason", reason}});
  };
  handlers.on_disconnected = [finished] { SetEvent(finished); };

  ipc.Run(std::move(handlers));

  // A stuck child must not wedge the parent's watchdog window.
  const DWORD wait = WaitForSingleObject(finished, 30000);
  ipc.Stop();
  CloseHandle(finished);
  return wait == WAIT_OBJECT_0 ? 0 : 22;
}

// ------------------------------------------------------------------ parent ---

void TestPipeName() {
  std::printf("pipe naming\n");
  CheckEq(PipeNameForAgent(4321), "\\\\.\\pipe\\engosoft-media-4321", "documented pipe name");
  // The PID in the name is what stops a stale sidecar attaching to a new agent.
  Check(PipeNameForAgent(1) != PipeNameForAgent(2), "the name is per-agent");
}

void TestPeerVerificationRejects() {
  std::printf("peer verification\n");

  AgentIpc ipc;
  Check(!ipc.Connect(0), "PID 0 is refused");
  // This process is not its own parent, so even though a pipe with this name
  // exists (we created it), the parent check must reject it. Without this, any
  // process that won the race to create the name would receive the token.
  Check(!ipc.Connect(GetCurrentProcessId()), "a peer that is not our parent is refused");
  Check(!ipc.connected(), "a refused connection leaves the client disconnected");
}

int RunParent(const std::wstring& exe_path) {
  std::printf("== ipc_test ==\n");
  StartWatchdog(60000);

  TestPipeName();

  const std::uint32_t self = GetCurrentProcessId();
  const std::wstring pipe_name = Widen(PipeNameForAgent(self));

  HANDLE pipe = CreateNamedPipeW(pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
                                 PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1, 65536,
                                 65536, 0, nullptr);
  Check(pipe != INVALID_HANDLE_VALUE, "the agent side of the pipe is created");
  if (pipe == INVALID_HANDLE_VALUE) return 1;

  TestPeerVerificationRejects();

  std::printf("child handshake\n");
  std::wstring command = L"\"" + exe_path + L"\" --client=" + std::to_wstring(self);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  const BOOL spawned = CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, 0, nullptr,
                                      nullptr, &startup, &process);
  Check(spawned != 0, "the child sidecar process starts");
  if (!spawned) {
    CloseHandle(pipe);
    return 1;
  }
  g_child.store(process.hProcess);

  const BOOL connected = ConnectNamedPipe(pipe, nullptr);
  Check(connected != 0 || GetLastError() == ERROR_PIPE_CONNECTED, "the child connects");

  // --- start_session ---------------------------------------------------------
  std::printf("start_session\n");
  const std::string start_payload =
      std::string("{\"session_id\":\"e1f2\",\"room\":\"org_42__device_7\",") +
      "\"livekit_url\":\"wss://example.livekit.cloud\"," + "\"publisher_token\":\"" + kToken +
      "\",\"track_name\":\"screen0\",\"display_id\":1," +
      "\"video\":{\"width\":1280,\"height\":720,\"fps\":15}}";
  Check(WriteMessage(pipe, Envelope("req-1", "start_session", start_payload)),
        "start_session is written");

  std::vector<std::string> seen;
  std::string raw;
  json::Value message;

  Check(ReadUntil(pipe, "ack", &raw, &message, &seen), "an ack comes back", Join(seen));
  if (const json::Value* payload = message.Find("payload"); payload != nullptr) {
    CheckEq(payload->StringOr("for"), "req-1", "the ack correlates to the request");
    Check(payload->BoolOr("ok"), "the ack is positive");
  }
  CheckEq(message.StringOr("id"), "req-1", "the envelope id is echoed too");

  seen.clear();
  Check(ReadUntil(pipe, "log", &raw, &message, &seen), "the child logs what it parsed", Join(seen));

  // THE ASSERTION THIS WHOLE TEST EXISTS FOR. The child was handed the token and
  // deliberately logged it. It must not have come back.
  Check(raw.find(kToken) == std::string::npos,
        "the publisher token does not appear anywhere in the log message", raw);
  Check(raw.find("[redacted]") != std::string::npos, "the token field is redacted", raw);

  if (const json::Value* payload = message.Find("payload"); payload != nullptr) {
    if (const json::Value* fields = payload->Find("fields"); fields != nullptr) {
      CheckEq(fields->StringOr("room"), "org_42__device_7", "room survived the round trip");
      CheckEq(fields->StringOr("fps"), "15", "video.fps was parsed");
      CheckEq(fields->StringOr("width"), "1280", "video.width was parsed");
      CheckEq(fields->StringOr("height"), "720", "video.height was parsed");
      CheckEq(fields->StringOr("display_index"), "1", "display_id mapped onto display_index");
      CheckEq(fields->StringOr("track_name"), "screen0", "track_name was parsed");
      CheckEq(fields->StringOr("token_len"), std::to_string(std::strlen(kToken)),
              "the child received the whole token");
      CheckEq(fields->StringOr("publisher_token"), "[redacted]", "the token field is redacted");
    } else {
      Check(false, "the log payload has a fields object");
    }
  }

  seen.clear();
  Check(ReadUntil(pipe, "state", &raw, &message, &seen), "a state message arrives", Join(seen));
  if (const json::Value* payload = message.Find("payload"); payload != nullptr) {
    CheckEq(payload->StringOr("state"), "publishing", "the state value");
    CheckEq(payload->StringOr("session_id"), "e1f2", "the state carries the session id");
    Check(payload->Find("reason") != nullptr && payload->Find("reason")->is_null(),
          "no failure reason on a healthy state");
  }

  // --- ping ------------------------------------------------------------------
  std::printf("ping\n");
  Check(WriteMessage(pipe, Envelope("req-2", "ping", "{}")), "ping is written");
  seen.clear();
  Check(ReadUntil(pipe, "pong", &raw, &message, &seen), "pong comes back", Join(seen));
  CheckEq(message.StringOr("id"), "req-2", "pong echoes the request id");
  if (const json::Value* payload = message.Find("payload"); payload != nullptr) {
    // The pong must report the live state, not a placeholder.
    CheckEq(payload->StringOr("state"), "publishing", "pong carries the current state");
  }

  // --- update_policy ---------------------------------------------------------
  std::printf("update_policy\n");
  Check(WriteMessage(pipe, Envelope("req-3", "update_policy",
                                    "{\"video\":{\"fps\":10},\"privacy_blackout\":true}")),
        "update_policy is written");
  seen.clear();
  Check(ReadUntil(pipe, "log", &raw, &message, &seen), "the policy update is applied", Join(seen));
  if (const json::Value* payload = message.Find("payload"); payload != nullptr) {
    if (const json::Value* fields = payload->Find("fields"); fields != nullptr) {
      CheckEq(fields->StringOr("has_fps"), "1", "fps was present");
      CheckEq(fields->StringOr("fps"), "10", "fps value");
      CheckEq(fields->StringOr("has_blackout"), "1", "blackout was present");
      CheckEq(fields->StringOr("blackout"), "1", "blackout value");
    }
  }

  // --- malformed and unknown input -------------------------------------------
  std::printf("malformed and unknown messages\n");
  Check(WriteMessage(pipe, "{\"v\":1,\"type\":"), "a truncated message is written");
  seen.clear();
  Check(ReadUntil(pipe, "log", &raw, &message, &seen), "malformed input is logged, not fatal",
        Join(seen));
  Check(raw.find("malformed") != std::string::npos, "the warning names the cause", raw);

  Check(WriteMessage(pipe, Envelope("req-9", "not_a_real_type", "{}")),
        "an unknown message type is written");
  seen.clear();
  Check(ReadUntil(pipe, "log", &raw, &message, &seen), "an unknown type is logged, not fatal",
        Join(seen));
  Check(raw.find("unknown message type") != std::string::npos, "the warning names the cause", raw);

  // The child must still be alive and answering after both.
  Check(WriteMessage(pipe, Envelope("req-10", "ping", "{}")), "ping after bad input");
  seen.clear();
  Check(ReadUntil(pipe, "pong", &raw, &message, &seen),
        "the child survives malformed and unknown input", Join(seen));

  // --- emergency stop --------------------------------------------------------
  std::printf("emergency_stop\n");
  const auto emergency_started = Clock::now();
  Check(WriteMessage(pipe, Envelope("req-4", "emergency_stop", "{\"reason\":\"owner_pressed\"}")),
        "emergency_stop is written");
  seen.clear();
  Check(ReadUntil(pipe, "ack", &raw, &message, &seen, 2000), "emergency_stop is acked", Join(seen));
  const double emergency_ms =
      std::chrono::duration<double, std::milli>(Clock::now() - emergency_started).count();
  // The protocol's hard requirement. The ack is sent only after the handler has
  // run, so this measures the stop, not just the round trip.
  Check(emergency_ms < 500.0, "emergency stop is acknowledged in under 500 ms",
        std::to_string(emergency_ms) + " ms");
  std::printf("  emergency stop round trip: %.1f ms\n", emergency_ms);
  CheckEq(message.Find("payload") != nullptr ? message.Find("payload")->StringOr("for") : "",
          "req-4", "the emergency ack correlates");

  // --- the agent going away --------------------------------------------------
  std::printf("agent disconnect\n");
  DisconnectNamedPipe(pipe);
  CloseHandle(pipe);

  // A media process must never outlive the agent that authorized it.
  const DWORD waited = WaitForSingleObject(process.hProcess, 10000);
  Check(waited == WAIT_OBJECT_0, "the sidecar exits when the agent pipe closes");
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  Check(exit_code == 0, "the sidecar exits cleanly", "exit code " + std::to_string(exit_code));

  if (g_done != nullptr) SetEvent(g_done);
  g_child.store(nullptr);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);

  std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
  for (int i = 1; i < argc; ++i) {
    if (std::strncmp(argv[i], "--client=", 9) == 0) {
      return RunClient(static_cast<std::uint32_t>(std::strtoul(argv[i] + 9, nullptr, 10)));
    }
  }

  wchar_t exe_path[MAX_PATH]{};
  if (GetModuleFileNameW(nullptr, exe_path, MAX_PATH) == 0) {
    std::printf("  FAIL: could not resolve this executable's path\n");
    return 1;
  }
  return RunParent(exe_path);
}
