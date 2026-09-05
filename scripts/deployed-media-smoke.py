"""Explicit deployed API smoke test using a synthetic QA tenant and canvas video.

Run from the repository root with --base-url. Creates clearly named test accounts
and an empty test device, never reads employee telemetry. Credentials remain in
memory. Closing the harness stops sessions and archives its own test device.
The isolated QA tenant/account remains for the audit trail.
"""
import argparse
import functools
import http.server
import json
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--base-url", required=True)
parser.add_argument("--assets", default=".media-smoke")
args = parser.parse_args()
base = args.base_url.rstrip("/")
if urllib.parse.urlparse(base).scheme != "https":
    raise SystemExit("Deployed tests require HTTPS")

def call(method, path, token=None, body=None, expected=(200, 201, 204)):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status, payload = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, payload = error.code, error.read()
    if status not in expected:
        raise RuntimeError("%s %s returned HTTP %s (response withheld)" % (method, path, status))
    return json.loads(payload) if payload else None

health = call("GET", "/healthz")
if health.get("schema_version", 0) < 21:
    raise SystemExit("Deployed schema 21 is required before testing")
suffix = secrets.token_hex(5)
owner_name, agent_name = "qa_video_" + suffix, "qa_agent_" + suffix
owner_password, agent_password = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
call("POST", "/v1/auth/register", body={"username": owner_name, "password": owner_password, "display_name": "Synthetic Video QA " + suffix, "account_type": "manager"})
owner = call("POST", "/v1/auth/login", body={"identifier": owner_name, "password": owner_password})["tokens"]["access_token"]
business = call("POST", "/v1/businesses", owner, {"name": "Synthetic Video QA " + suffix})["id"]
call("POST", "/v1/employees", owner, {"username": agent_name, "password": agent_password, "display_name": "Synthetic test publisher", "business_id": business})
agent = call("POST", "/v1/auth/login", body={"identifier": agent_name, "password": agent_password, "business_id": business})["tokens"]["access_token"]
device = str(uuid.uuid4())
call("POST", "/v1/sync/batch", agent, {"device_id": device, "business_id": business, "device_label": "Synthetic QA — no screen capture", "device_os": "synthetic", "agent_version": "1.5.11-qa"})
print("PASS: deployed owner and agent login, isolated business, empty device enrollment", flush=True)
sessions = set()
lock = threading.Lock()

def cleanup():
    with lock:
        active = list(sessions)
    for session in active:
        try:
            call("POST", "/v1/media/sessions/" + session + "/stop", owner, {})
        except Exception:
            pass
    try:
        call("POST", "/v1/devices/" + device + "/archive", owner, {})
        print("PASS: synthetic test device archived", flush=True)
    except Exception:
        print("Test device archive failed; manual cleanup needed for " + device, flush=True)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.headers.get("Host") != "127.0.0.1:5192" or self.headers.get("Origin") != "http://127.0.0.1:5192":
            self.send_error(403)
            return
        try:
            if self.path == "/start":
                call("POST", "/v1/presence/heartbeat", agent, {"device_id": device, "business_id": business, "state": "active", "since": int(time.time())})
                session = call("POST", "/v1/devices/" + device + "/media/live", owner, {})["session"]["id"]
                with lock:
                    sessions.add(session)
                demand = call("GET", "/v1/media/agent/session?device_id=" + device, agent)
                assert demand["session_id"] == session and not demand["control_armed"]
                prefix = "/v1/media/sessions/" + session
                publisher = call("POST", prefix + "/publisher-token", agent, {})
                viewer = call("POST", prefix + "/viewer-token", owner, {})
                assert publisher["can_publish"] and not publisher["can_subscribe"]
                assert viewer["can_subscribe"] and not viewer["can_publish"]
                call("POST", prefix + "/heartbeat", owner, {})
                call("POST", "/v1/agent/media/sessions/" + session + "/state", agent, {"state": "live", "track": {"source": "screen", "codec": "h264", "width": 640, "height": 360, "nominal_fps": 15}})
                payload = {"url": viewer["url"], "room": session, "publisher": publisher["token"], "viewer": viewer["token"]}
                # The harness's room field is an opaque stop handle. Tokens carry
                # the actual SFU room, and the adapter does not use the field.
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())
                print("PASS: deployed API created room, scoped demand/tokens and viewer heartbeat", flush=True)
            elif self.path == "/stop":
                size = int(self.headers.get("Content-Length", "0"))
                if size > 1024:
                    raise RuntimeError("request too large")
                session = json.loads(self.rfile.read(size))["room"]
                with lock:
                    assert session in sessions
                prefix = "/v1/media/sessions/" + session
                stopped = call("POST", prefix + "/stop", owner, {})
                assert stopped["session"]["state"] == "ended"
                assert call("GET", "/v1/media/agent/session?device_id=" + device, agent, expected=(204,)) is None
                call("POST", prefix + "/publisher-token", agent, {}, expected=(409,))
                with lock:
                    sessions.discard(session)
                self.send_response(204)
                self.end_headers()
                print("PASS: deployed stop ended session, withdrew demand and refused further publication", flush=True)
            else:
                self.send_error(404)
        except Exception as error:
            print("FAIL: " + str(error), flush=True)
            self.send_error(502, "Deployed media integration failed; credentials omitted")

server = http.server.ThreadingHTTPServer(("127.0.0.1", 5192), functools.partial(Handler, directory=args.assets))
print("Open http://127.0.0.1:5192 and select Run video test", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
    cleanup()
