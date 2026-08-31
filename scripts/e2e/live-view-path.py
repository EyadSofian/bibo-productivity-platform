"""End-to-end proof of the pushed live-view path.

Plays both sides for real against the running backend:
  agent  -> heartbeat (registers the device), command stream, frame upload
  owner  -> live view stream

and asserts the agent is told to capture, and the owner sees the frame.
"""
import json, subprocess, sys, threading, time, uuid

API = "http://127.0.0.1:8099/v1"
state = json.load(open("/tmp/e2e_state.json"))
OTOK, ETOK, BID = state["otok"], state["etok"], state["bid"]
DEVICE = str(uuid.uuid4())

def post(path, body, tok):
    return subprocess.run(
        ["curl","-s","--max-time","20","-X","POST",API+path,
         "-H","content-type: application/json","-H",f"Authorization: Bearer {tok}",
         "-d",json.dumps(body)], capture_output=True, text=True).stdout

# 1) The agent heartbeats, which registers the device and marks it online.
hb = post("/presence/heartbeat", {
    "device_id": DEVICE, "business_id": BID, "state": "active",
    "app": "Code", "window_title": "main.rs", "since": int(time.time()),
}, ETOK)
print("1. agent heartbeat ->", hb.strip()[:120])
assert '"status":"ok"' in hb, "heartbeat failed"

# 2) The agent opens its command stream and records what it is told.
commands, agent_ready = [], threading.Event()
def agent_stream():
    p = subprocess.Popen(
        ["curl","-sN","--max-time","25", f"{API}/agent/commands/stream?device_id={DEVICE}",
         "-H",f"Authorization: Bearer {ETOK}","-H","Accept: text/event-stream"],
        stdout=subprocess.PIPE, text=True, bufsize=1)
    agent_ready.set()
    for line in p.stdout:
        line = line.strip()
        if line.startswith("data: ") and "type" in line:
            commands.append(json.loads(line[6:]))
    p.terminate()

t = threading.Thread(target=agent_stream, daemon=True); t.start()
agent_ready.wait(); time.sleep(1.5)
print("2. agent command stream open")

# 3) The owner opens the live view. This alone must make the agent start.
frames, viewer_ready = [], threading.Event()
def viewer_stream():
    p = subprocess.Popen(
        ["curl","-sN","--max-time","25", f"{API}/devices/{DEVICE}/live/stream",
         "-H",f"Authorization: Bearer {OTOK}","-H","Accept: text/event-stream"],
        stdout=subprocess.PIPE, text=True, bufsize=1)
    viewer_ready.set()
    for line in p.stdout:
        line = line.strip()
        if line.startswith("data: ") and "image" in line:
            frames.append(json.loads(line[6:]))
    p.terminate()

v = threading.Thread(target=viewer_stream, daemon=True); v.start()
viewer_ready.wait(); time.sleep(2.0)
print("3. owner live view open")
print("   commands the agent received so far:", [c["type"] for c in commands])
assert any(c["type"] == "live_view_active" for c in commands), \
    f"agent was never told to capture; got {commands}"

# 4) The agent uploads a frame, as its capture loop would.
webp = b"RIFF\x00\x00\x00\x00WEBPVP8 " + bytes(range(256)) * 4
open("/tmp/e2e_frame.webp","wb").write(webp)
up = subprocess.run(
    ["curl","-s","-o","/dev/null","-w","%{http_code}","--max-time","20","-X","POST",
     f"{API}/agent/live/frame?device_id={DEVICE}",
     "-H",f"Authorization: Bearer {ETOK}","-H","Content-Type: image/webp",
     "-H","X-Frame-Width: 1280","-H","X-Frame-Height: 720",
     "--data-binary","@/tmp/e2e_frame.webp"], capture_output=True, text=True).stdout
print("4. agent frame upload ->", up)
assert up == "204", f"upload returned {up}"

# 5) The owner must receive that exact frame over the push stream.
deadline = time.time() + 6
while not frames and time.time() < deadline:
    time.sleep(0.1)
assert frames, "owner never received the pushed frame"
import base64
got = base64.b64decode(frames[0]["image"])
print(f"5. owner received frame: {len(got)} bytes, {frames[0]['width']}x{frames[0]['height']}")
assert got == webp, "frame bytes did not round-trip"
assert frames[0]["width"] == 1280 and frames[0]["height"] == 720

# 6) Renewals keep arriving while the viewer stays attached.
time.sleep(5.5)
renewals = [c for c in commands if c["type"] == "live_view_active"]
print(f"6. renewals received while watching: {len(renewals)} (ttl {renewals[0]['expires_in_ms']}ms)")
assert len(renewals) >= 2, "capture authorization was not renewed"

print("\nPASS: live view start -> agent told to capture -> frame -> viewer, all pushed.")
