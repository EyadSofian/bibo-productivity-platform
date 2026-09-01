// agent_ipc.h — named-pipe client speaking the protocol in docs/ipc-protocol.md.
//
// The Rust agent is the server; this is the client. The pipe is the sidecar's
// only input: it carries the publisher token, the session policy, and the stop
// signal.
//
// LIFETIME IS A SAFETY PROPERTY. A broken pipe means the agent is gone, and the
// sidecar must then stop capture and exit. A media process that outlives the
// agent that authorized it is exactly the failure this design prevents, so
// there is deliberately no reconnect.

#ifndef ENGOSOFT_MEDIA_PUBLISHER_AGENT_IPC_H_
#define ENGOSOFT_MEDIA_PUBLISHER_AGENT_IPC_H_

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>

#include "metrics.h"

namespace engosoft::media {

// Parsed `start_session` payload.
struct StartSessionRequest {
  std::string session_id;
  std::string room;
  std::string livekit_url;

  // Short-lived, publish-only, single room, single device. Moved out of the
  // parsed message immediately and zeroed once the room is connected.
  std::string publisher_token;

  std::string track_name = "screen0";
  int display_index = 0;
  int width = 1280;
  int height = 720;
  int fps = 15;
};

struct StopSessionRequest {
  std::string session_id;
  std::string reason;  // owner_closed | policy_stop | schedule_end | agent_shutdown | emergency_stop
};

// Parsed `update_policy` payload. Absent fields mean "leave unchanged".
struct PolicyUpdate {
  bool has_fps = false;
  int fps = 0;

  bool has_blackout = false;
  bool blackout = false;
};

// Callbacks are invoked on the IPC reader thread. Handlers must not block for
// long; emergency stop in particular is required to take effect in under 500ms.
struct IpcHandlers {
  std::function<void(StartSessionRequest&&)> on_start;
  std::function<void(const StopSessionRequest&)> on_stop;
  std::function<void(const PolicyUpdate&)> on_policy;
  std::function<void(const std::string& reason)> on_emergency_stop;

  // The pipe closed or errored: the agent is gone. The sidecar must stop
  // capture and exit.
  std::function<void()> on_disconnected;
};

class AgentIpc {
 public:
  AgentIpc();
  ~AgentIpc();

  AgentIpc(const AgentIpc&) = delete;
  AgentIpc& operator=(const AgentIpc&) = delete;

  // Connects to \\.\pipe\engosoft-media-<agent_pid> and verifies the server
  // process is the expected parent before any message is exchanged. Returns
  // false if the pipe is missing, access is denied, or the peer is not the
  // expected PID.
  bool Connect(std::uint32_t agent_pid);

  // Starts the reader thread. Handlers are borrowed and must outlive this.
  void Run(IpcHandlers handlers);

  // Idempotent; blocks until the reader thread has stopped.
  void Stop();

  bool connected() const;

  // --- outbound ---------------------------------------------------------

  void SendState(const std::string& session_id, State state, FailureReason reason);
  void SendMetrics(const Snapshot& snapshot);
  void SendAck(const std::string& request_id, bool ok, const std::string& error);

  // Redaction is applied inside, so callers cannot leak by accident.
  void SendLog(const std::string& level, const std::string& message,
               const std::map<std::string, std::string>& fields = {});

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Builds the pipe name for an agent PID. Exposed so the Rust side's expected
// name can be asserted against this in tests.
std::string PipeNameForAgent(std::uint32_t agent_pid);

}  // namespace engosoft::media

#endif  // ENGOSOFT_MEDIA_PUBLISHER_AGENT_IPC_H_
