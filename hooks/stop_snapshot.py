"""Stop hook: saves the session's in-flight background tasks for the hooks module.

A hooks module never receives classic.Stop under the built-in security guard,
but a plugin's settings hook does, so this hands the list over through a file.
"""
import json
import os
import sys
import time

event = json.load(sys.stdin)
if event.get("agent_id"):
    sys.exit(0)

state = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state")
os.makedirs(state, exist_ok=True)
now = time.time()
tasks = None
if event.get("hook_event_name") == "Stop":
    tasks = [{"id": t.get("id"), "type": t.get("type")} for t in event.get("background_tasks") or []]

path = os.path.join(state, f"stop-{event['session_id']}.json")
with open(path + ".tmp", "w") as f:
    json.dump({"at": int(now * 1000), "tasks": tasks}, f)
os.replace(path + ".tmp", path)

for name in os.listdir(state):
    old = os.path.join(state, name)
    if name.startswith("stop-") and now - os.path.getmtime(old) > 7 * 86400:
        os.remove(old)
