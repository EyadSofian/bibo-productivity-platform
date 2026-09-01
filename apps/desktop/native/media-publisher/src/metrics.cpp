#include "metrics.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <sstream>

namespace engosoft::media {
namespace {

// Keys whose values must never leave the process. Matched case-insensitively
// against a JSON key, and also against bare `key=value` pairs in free text.
constexpr std::array<const char*, 7> kSensitiveKeys = {
    "token", "jwt", "secret", "url", "authorization", "password", "key",
};

bool IEqualsAt(const std::string& haystack, size_t pos, const char* needle) {
  size_t i = 0;
  for (; needle[i] != '\0'; ++i) {
    if (pos + i >= haystack.size()) return false;
    const char a = static_cast<char>(std::tolower(static_cast<unsigned char>(haystack[pos + i])));
    const char b = static_cast<char>(std::tolower(static_cast<unsigned char>(needle[i])));
    if (a != b) return false;
  }
  return true;
}

// True when the identifier ending at `end` is exactly one of the sensitive
// keys, or ends with one (so "publisher_token" and "api_key" match too).
bool IsSensitiveIdentifier(const std::string& text, size_t start, size_t end) {
  for (const char* key : kSensitiveKeys) {
    const size_t len = std::char_traits<char>::length(key);
    if (end < start + len) continue;
    if (IEqualsAt(text, end - len, key)) return true;
  }
  return false;
}

std::string FormatDouble(double value, int decimals) {
  char buffer[64];
  std::snprintf(buffer, sizeof(buffer), "%.*f", decimals, value);
  return buffer;
}

}  // namespace

const char* ToString(State state) {
  switch (state) {
    case State::kIdle: return "idle";
    case State::kStarting: return "starting";
    case State::kConnecting: return "connecting";
    case State::kPublishing: return "publishing";
    case State::kReconnecting: return "reconnecting";
    case State::kStopping: return "stopping";
    case State::kStopped: return "stopped";
    case State::kFailed: return "failed";
  }
  return "unknown";
}

const char* ToString(FailureReason reason) {
  switch (reason) {
    case FailureReason::kNone: return "";
    case FailureReason::kCaptureUnsupported: return "capture_unsupported";
    case FailureReason::kCaptureFailed: return "capture_failed";
    case FailureReason::kEncoderFailed: return "encoder_failed";
    case FailureReason::kConnectFailed: return "connect_failed";
    case FailureReason::kTokenRejected: return "token_rejected";
    case FailureReason::kIceFailed: return "ice_failed";
    case FailureReason::kDisplayGone: return "display_gone";
    case FailureReason::kInternalError: return "internal_error";
  }
  return "internal_error";
}

const char* ToString(CaptureBackend backend) {
  switch (backend) {
    case CaptureBackend::kNone: return "none";
    case CaptureBackend::kWgc: return "wgc";
    case CaptureBackend::kDxgi: return "dxgi";
  }
  return "none";
}

const char* ToString(EncoderKind kind) {
  switch (kind) {
    case EncoderKind::kUnknown: return "unknown";
    case EncoderKind::kHardwareH264: return "hardware_h264";
    case EncoderKind::kSoftwareH264: return "software_h264";
  }
  return "unknown";
}

void Metrics::SetSessionId(std::string id) {
  std::lock_guard<std::mutex> lock(mutex_);
  snapshot_.session_id = std::move(id);
}

void Metrics::SetState(State state, FailureReason reason) {
  std::lock_guard<std::mutex> lock(mutex_);
  snapshot_.state = state;
  snapshot_.reason = reason;
}

void Metrics::SetBackend(CaptureBackend backend) {
  std::lock_guard<std::mutex> lock(mutex_);
  snapshot_.backend = backend;
}

void Metrics::SetEncoder(EncoderKind kind) {
  std::lock_guard<std::mutex> lock(mutex_);
  snapshot_.encoder = kind;
}

void Metrics::SetResolution(int width, int height) {
  std::lock_guard<std::mutex> lock(mutex_);
  snapshot_.width = width;
  snapshot_.height = height;
}

void Metrics::SetBorderEnabled(bool enabled) {
  std::lock_guard<std::mutex> lock(mutex_);
  snapshot_.border_enabled = enabled;
}

void Metrics::OnFrameCaptured() {
  std::lock_guard<std::mutex> lock(mutex_);
  ++snapshot_.frames_captured;
}

void Metrics::OnFrameRepeated() {
  std::lock_guard<std::mutex> lock(mutex_);
  ++snapshot_.frames_repeated;
}

void Metrics::OnFrameDropped() {
  std::lock_guard<std::mutex> lock(mutex_);
  ++snapshot_.frames_dropped;
}

void Metrics::OnReconnect() {
  std::lock_guard<std::mutex> lock(mutex_);
  ++snapshot_.reconnect_count;
}

void Metrics::SetTransport(std::uint64_t bitrate_bps, std::uint32_t rtt_ms, double packet_loss) {
  std::lock_guard<std::mutex> lock(mutex_);
  snapshot_.bitrate_bps = bitrate_bps;
  snapshot_.rtt_ms = rtt_ms;
  snapshot_.packet_loss = packet_loss;
}

void Metrics::SetProcessUsage(double cpu_percent, double memory_mb) {
  std::lock_guard<std::mutex> lock(mutex_);
  snapshot_.cpu_percent = cpu_percent;
  snapshot_.memory_mb = memory_mb;
}

void Metrics::Tick(double elapsed_seconds) {
  if (elapsed_seconds <= 0.0) return;
  std::lock_guard<std::mutex> lock(mutex_);

  const std::uint64_t captured = snapshot_.frames_captured;
  // What the viewer actually receives is captured plus repeated: a still screen
  // still has to be published at the configured rate.
  const std::uint64_t published = snapshot_.frames_captured + snapshot_.frames_repeated;

  snapshot_.capture_fps = static_cast<double>(captured - last_captured_) / elapsed_seconds;
  snapshot_.published_fps = static_cast<double>(published - last_published_) / elapsed_seconds;

  last_captured_ = captured;
  last_published_ = published;
}

Snapshot Metrics::Get() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return snapshot_;
}

State Metrics::state() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return snapshot_.state;
}

std::string EscapeJson(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (const char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned char>(c));
          out += buffer;
        } else {
          out += c;
        }
    }
  }
  return out;
}

std::string ToJson(const Snapshot& s) {
  std::ostringstream out;
  out << '{'
      << "\"session_id\":\"" << EscapeJson(s.session_id) << "\","
      << "\"state\":\"" << ToString(s.state) << "\","
      << "\"reason\":";
  if (s.reason == FailureReason::kNone) {
    out << "null,";
  } else {
    out << '"' << ToString(s.reason) << "\",";
  }
  out << "\"capture_backend\":\"" << ToString(s.backend) << "\","
      << "\"encoder\":\"" << ToString(s.encoder) << "\","
      << "\"capture_fps\":" << FormatDouble(s.capture_fps, 2) << ','
      << "\"published_fps\":" << FormatDouble(s.published_fps, 2) << ','
      << "\"frames_captured\":" << s.frames_captured << ','
      << "\"frames_repeated\":" << s.frames_repeated << ','
      << "\"frames_dropped\":" << s.frames_dropped << ','
      << "\"width\":" << s.width << ','
      << "\"height\":" << s.height << ','
      << "\"bitrate_bps\":" << s.bitrate_bps << ','
      << "\"rtt_ms\":" << s.rtt_ms << ','
      << "\"packet_loss\":" << FormatDouble(s.packet_loss, 4) << ','
      << "\"reconnect_count\":" << s.reconnect_count << ','
      << "\"cpu_percent\":" << FormatDouble(s.cpu_percent, 2) << ','
      << "\"memory_mb\":" << FormatDouble(s.memory_mb, 1) << ','
      << "\"border_enabled\":" << (s.border_enabled ? "true" : "false")
      << '}';
  return out.str();
}

std::string Redact(const std::string& text) {
  std::string out;
  out.reserve(text.size());

  size_t i = 0;
  while (i < text.size()) {
    // Case 1: a JSON key -- "someToken": <value>
    if (text[i] == '"') {
      const size_t key_start = i + 1;
      size_t key_end = key_start;
      while (key_end < text.size() && text[key_end] != '"') ++key_end;
      if (key_end >= text.size()) {  // unterminated; copy the rest verbatim
        out.append(text, i, std::string::npos);
        break;
      }

      const std::string key = text.substr(key_start, key_end - key_start);
      size_t after = key_end + 1;
      while (after < text.size() && std::isspace(static_cast<unsigned char>(text[after]))) ++after;

      const bool is_key = after < text.size() && text[after] == ':';
      if (is_key && IsSensitiveIdentifier(text, key_start, key_end)) {
        out += '"' + key + "\":\"[redacted]\"";
        // Skip the original value: past ':', whitespace, then a quoted string
        // or a bare literal.
        ++after;
        while (after < text.size() && std::isspace(static_cast<unsigned char>(text[after]))) ++after;
        if (after < text.size() && text[after] == '"') {
          ++after;
          while (after < text.size() && text[after] != '"') {
            if (text[after] == '\\' && after + 1 < text.size()) ++after;
            ++after;
          }
          if (after < text.size()) ++after;  // closing quote
        } else {
          while (after < text.size() && text[after] != ',' && text[after] != '}' &&
                 text[after] != ']') {
            ++after;
          }
        }
        i = after;
        continue;
      }

      out.append(text, i, key_end - i + 1);
      i = key_end + 1;
      continue;
    }

    // Case 2: a bare key=value pair in free text -- token=eyJhbGci...
    if (std::isalnum(static_cast<unsigned char>(text[i])) || text[i] == '_') {
      size_t word_end = i;
      while (word_end < text.size() &&
             (std::isalnum(static_cast<unsigned char>(text[word_end])) || text[word_end] == '_')) {
        ++word_end;
      }
      if (word_end < text.size() && text[word_end] == '=' &&
          IsSensitiveIdentifier(text, i, word_end)) {
        out.append(text, i, word_end - i);
        out += "=[redacted]";
        size_t value_end = word_end + 1;
        while (value_end < text.size() &&
               !std::isspace(static_cast<unsigned char>(text[value_end])) &&
               text[value_end] != ',' && text[value_end] != '}') {
          ++value_end;
        }
        i = value_end;
        continue;
      }
      out.append(text, i, word_end - i);
      i = word_end;
      continue;
    }

    out += text[i];
    ++i;
  }
  return out;
}

std::string BuildLogPayload(const std::string& level, const std::string& message,
                            const std::map<std::string, std::string>& fields) {
  std::ostringstream out;
  out << "{\"level\":\"" << EscapeJson(level) << "\","
      << "\"msg\":\"" << EscapeJson(Redact(message)) << "\","
      << "\"fields\":{";
  bool first = true;
  for (const auto& [key, value] : fields) {
    if (!first) out << ',';
    first = false;
    // A sensitive key is redacted whatever its value looks like, so a caller
    // cannot leak by passing a token under an innocuous-looking value.
    const bool sensitive = IsSensitiveIdentifier(key, 0, key.size());
    out << '"' << EscapeJson(key) << "\":\""
        << (sensitive ? "[redacted]" : EscapeJson(Redact(value))) << '"';
  }
  out << "}}";
  return out.str();
}

}  // namespace engosoft::media
