import json, os, subprocess, sys, time, uuid
API = "http://127.0.0.1:8099/v1"
SUF = sys.argv[1]

def curl(args, timeout=20):
    r = subprocess.run(["curl","-s","--max-time",str(timeout)]+args, capture_output=True, text=True)
    return r.stdout

def jpost(path, body, tok=None):
    a = ["-X","POST", API+path, "-H","content-type: application/json","-d",json.dumps(body)]
    if tok: a += ["-H", f"Authorization: Bearer {tok}"]
    return curl(a)

owner = json.loads(jpost("/auth/login", {"identifier": f"owner{SUF}@e2e.test", "password":"CorrectHorse9!"}))
otok = owner["tokens"]["access_token"]
print("owner logged in")

biz = json.loads(jpost("/businesses", {"name":"E2E Co","kind":"team"}, otok))
bid = biz.get("business",biz).get("id")
print("business:", bid)

emp = json.loads(jpost("/auth/register", {"email": f"emp{SUF}@e2e.test","password":"CorrectHorse9!","display_name":"E2E Employee"}))
etok = emp["tokens"]["access_token"]
euid = emp.get("user",{}).get("id")
print("employee registered:", euid)
open("/tmp/e2e_state.json","w").write(json.dumps({"otok":otok,"etok":etok,"bid":bid,"euid":euid}))
