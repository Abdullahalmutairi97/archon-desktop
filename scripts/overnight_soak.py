#!/usr/bin/env python3
import hashlib, json, os, subprocess, time
from datetime import datetime, timezone
import requests
BASE=os.environ["ARCHON_BASE"].rstrip("/")
TOKEN=os.environ["ARCHON_TOKEN"]
DURATION=int(os.environ.get("SOAK_SECONDS","18000"))
INTERVAL=int(os.environ.get("SOAK_INTERVAL","300"))
H={"Authorization":f"Bearer {TOKEN}"}
TAG="ARCHON_OVERNIGHT_SOAK_"
log= open(os.environ.get("SOAK_LOG","/tmp/archon-overnight-soak.log"),"a", buffering=1)
def out(x): log.write(json.dumps({"at":datetime.now(timezone.utc).isoformat(),**x})+"\n")
def get(path,**kw): return requests.get(BASE+path,headers=H,timeout=20,**kw)
def main():
 end=time.time()+DURATION; cycle=0
 while time.time()<end:
  cycle+=1; tag=f"{TAG}{cycle}_{int(time.time())}"
  sid=None; tid=None
  try:
   r=requests.post(BASE+"/api/tasks",headers=H,json={"prompt":f"Reply exactly {tag}","cwd":"/home/archonminipc","model":"gpt-5.6-terra","provider":"openai-codex","approval_mode":"auto","skills":[]},timeout=20); r.raise_for_status(); t=r.json()["task"]; tid=t["id"]
   deadline=time.time()+120
   while time.time()<deadline:
    t=get(f"/api/tasks/{tid}").json()["task"]
    if t["status"] not in ("queued","running"): break
    time.sleep(2)
   sid=t.get("session_id") or (t.get("result") or {}).get("session_id")
   ok=t.get("status")=="completed" and tag in str((t.get("result") or {}).get("text",""))
   details={"cycle":cycle,"task":tid,"status":t.get("status"),"session":sid,"answer_ok":ok}
   if sid:
    msgs=get(f"/api/sessions/{sid}/messages?limit=2000").json()["messages"]
    row=next(x for x in get("/api/sessions?limit=500").json()["sessions"] if x["id"]==sid)
    details.update(message_count=len(msgs), listed_count=row["message_count"], count_ok=len(msgs)==row["message_count"])
   out(details)
  except Exception as e: out({"cycle":cycle,"error":repr(e)})
  finally:
   if sid:
    try: requests.delete(BASE+"/api/sessions",headers=H,json={"session_ids":[sid]},timeout=20)
    except Exception as e: out({"cleanup_error":repr(e),"session":sid})
  time.sleep(INTERVAL)
 out({"finished":True,"cycles":cycle})
if __name__=="__main__": main()
