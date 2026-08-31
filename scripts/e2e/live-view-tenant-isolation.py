"""Cross-tenant checks on the new streaming endpoints, over real HTTP."""
import json, subprocess, time, uuid

API = "http://127.0.0.1:8099/v1"
state = json.load(open("/tmp/e2e_state.json"))
OTOK, ETOK, BID = state["otok"], state["etok"], state["bid"]
DEVICE = str(uuid.uuid4())
SUF = str(uuid.uuid4())[:8]

def post(path, body, tok=None):
    a = ["-s","--max-time","20","-X","POST",API+path,"-H","content-type: application/json",
         "-d",json.dumps(body)]
    if tok: a += ["-H",f"Authorization: Bearer {tok}"]
    return subprocess.run(["curl"]+a, capture_output=True, text=True).stdout

def code(path, tok, method="GET", extra=None):
    a = ["curl","-s","-o","/dev/null","-w","%{http_code}","--max-time","6",
         "-X",method,API+path]
    if tok: a += ["-H",f"Authorization: Bearer {tok}"]
    return subprocess.run(a+(extra or []), capture_output=True, text=True).stdout

post("/presence/heartbeat", {"device_id":DEVICE,"business_id":BID,"state":"active",
     "since":int(time.time())}, ETOK)

# An unrelated account with its own business.
other = json.loads(post("/auth/register", {"email":f"intruder{SUF}@e2e.test",
        "password":"CorrectHorse9!","display_name":"Intruder"}))
XTOK = other["tokens"]["access_token"]

checks = [
    ("owner may watch their own device",
     code(f"/devices/{DEVICE}/live/stream", OTOK), {"200"}),
    ("stranger may NOT watch it",
     code(f"/devices/{DEVICE}/live/stream", XTOK), {"409","403","404"}),
    ("the watched employee may NOT watch their own screen as an owner",
     code(f"/devices/{DEVICE}/live/stream", ETOK), {"409","403","404"}),
    ("no token is refused",
     code(f"/devices/{DEVICE}/live/stream", None), {"401"}),
    ("agent stream: the device's own account is allowed",
     code(f"/agent/commands/stream?device_id={DEVICE}", ETOK), {"200"}),
    ("agent stream: a stranger is refused",
     code(f"/agent/commands/stream?device_id={DEVICE}", XTOK), {"403"}),
    ("agent stream: even the owner cannot impersonate the agent",
     code(f"/agent/commands/stream?device_id={DEVICE}", OTOK), {"403"}),
    ("frame upload by a stranger is refused",
     code(f"/agent/live/frame?device_id={DEVICE}", XTOK, "POST",
          ["-H","Content-Type: image/webp","-H","X-Frame-Width: 8","-H","X-Frame-Height: 8",
           "--data-binary","x"]), {"403"}),
    ("malformed device id is rejected",
     code("/devices/not-a-uuid/live/stream", OTOK), {"400"}),
]

failed = 0
for name, got, allowed in checks:
    ok = got in allowed
    failed += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: HTTP {got} (want one of {sorted(allowed)})")

print()
print("PASS: no cross-tenant access on the new endpoints." if not failed
      else f"FAILED {failed} check(s)")
raise SystemExit(1 if failed else 0)
