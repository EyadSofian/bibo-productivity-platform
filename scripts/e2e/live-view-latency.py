"""Measures the latency P0-1 is about, and checks the path fails closed."""
import base64, json, subprocess, threading, time, uuid

API = "http://127.0.0.1:8099/v1"
state = json.load(open("/tmp/e2e_state.json"))
OTOK, ETOK, BID = state["otok"], state["etok"], state["bid"]
DEVICE = str(uuid.uuid4())

def post(path, body, tok):
    return subprocess.run(
        ["curl","-s","--max-time","20","-X","POST",API+path,
         "-H","content-type: application/json","-H",f"Authorization: Bearer {tok}",
         "-d",json.dumps(body)], capture_output=True, text=True).stdout

post("/presence/heartbeat", {"device_id":DEVICE,"business_id":BID,"state":"active",
     "since":int(time.time())}, ETOK)

# The agent holds its command stream open and timestamps what it is told.
events, ready = [], threading.Event()
def agent():
    p = subprocess.Popen(
        ["curl","-sN","--max-time","30", f"{API}/agent/commands/stream?device_id={DEVICE}",
         "-H",f"Authorization: Bearer {ETOK}","-H","Accept: text/event-stream"],
        stdout=subprocess.PIPE, text=True, bufsize=1)
    ready.set()
    for line in p.stdout:
        line = line.strip()
        if line.startswith("data: ") and "type" in line:
            events.append((time.monotonic(), json.loads(line[6:])["type"]))
    p.terminate()

threading.Thread(target=agent, daemon=True).start()
ready.wait(); time.sleep(1.5)

# --- A. one-shot capture request (the old 0-15s heartbeat wait) ---
before = len(events); t0 = time.monotonic()
post(f"/devices/{DEVICE}/live-capture", {}, OTOK)
while len(events) == before and time.monotonic() - t0 < 5:
    time.sleep(0.001)
assert len(events) > before, "agent was never woken for the one-shot request"
ts, kind = events[-1]
print(f"A. capture_now reached the agent in {(ts-t0)*1000:.0f} ms   (was 0-15000 ms: heartbeat wait)")
assert kind == "capture_now"

# --- B. live view: owner opens the player, agent must be told to capture ---
frames, vready = [], threading.Event()
stop_viewer = threading.Event()
def viewer():
    p = subprocess.Popen(
        ["curl","-sN","--max-time","12", f"{API}/devices/{DEVICE}/live/stream",
         "-H",f"Authorization: Bearer {OTOK}","-H","Accept: text/event-stream"],
        stdout=subprocess.PIPE, text=True, bufsize=1)
    vready.set()
    for line in p.stdout:
        if stop_viewer.is_set():
            break
        line = line.strip()
        if line.startswith("data: ") and "image" in line:
            frames.append((time.monotonic(), json.loads(line[6:])))
    p.kill()

before = len(events); t0 = time.monotonic()
threading.Thread(target=viewer, daemon=True).start()
vready.wait()
while len(events) == before and time.monotonic() - t0 < 5:
    time.sleep(0.001)
assert len(events) > before
ts, kind = events[-1]
assert kind == "live_view_active"
print(f"B. live_view_active reached the agent in {(ts-t0)*1000:.0f} ms")

# --- C. agent frame -> viewer ---
webp = b"RIFF\x00\x00\x00\x00WEBPVP8 " + bytes(range(256))
open("/tmp/lat_frame.webp","wb").write(webp)
t0 = time.monotonic()
code = subprocess.run(
    ["curl","-s","-o","/dev/null","-w","%{http_code}","--max-time","20","-X","POST",
     f"{API}/agent/live/frame?device_id={DEVICE}","-H",f"Authorization: Bearer {ETOK}",
     "-H","Content-Type: image/webp","-H","X-Frame-Width: 800","-H","X-Frame-Height: 600",
     "--data-binary","@/tmp/lat_frame.webp"], capture_output=True, text=True).stdout
assert code == "204", code
while not frames and time.monotonic() - t0 < 5:
    time.sleep(0.001)
assert frames, "frame never reached the viewer"
print(f"C. frame upload -> viewer render in {(frames[0][0]-t0)*1000:.0f} ms   (was 0-3000 ms: discovery poll)")

# --- D. fail closed: viewer leaves, agent must be refused ---
stop_viewer.set()
time.sleep(13)  # let the viewer's curl time out and the stream close
code = subprocess.run(
    ["curl","-s","-o","/dev/null","-w","%{http_code}","--max-time","20","-X","POST",
     f"{API}/agent/live/frame?device_id={DEVICE}","-H",f"Authorization: Bearer {ETOK}",
     "-H","Content-Type: image/webp","-H","X-Frame-Width: 800","-H","X-Frame-Height: 600",
     "--data-binary","@/tmp/lat_frame.webp"], capture_output=True, text=True).stdout
print(f"D. upload after the viewer left -> HTTP {code} (409 = agent told to stop)")
assert code == "409", f"expected 409 once nobody is watching, got {code}"

# --- E. renewals stop once nobody is watching ---
# Anchor on the 409 above: that is the moment the backend proved no viewer is
# subscribed. Renewals before it were correct -- the viewer's socket was still
# open. Only renewals *after* it would mean capture was left authorized.
no_viewer_at = time.monotonic()
time.sleep(3 * 5.0)  # three renewal intervals
after = [e for e in events if e[0] > no_viewer_at and e[1] == "live_view_active"]
print(f"E. renewals in the {3*5.0:.0f}s after the viewer was gone: {len(after)}")
assert not after, "capture authorization kept being renewed after the viewer left"

print("\nPASS: pushed, and it fails closed when nobody is watching.")
