"""RUN 08: verify every live credential in the Keychain WITHOUT printing any value (yes/no facts only).
  python3 -I scripts/hub-live-verify.py
Telegram: getMe (token valid, username matches the stored one, privacy mode as required per bot role, the three bots are distinct).
Slack:    oauth.v2.access with a deliberately invalid code -> Slack says `invalid_code` only when client id + secret are correct.
Cloudflare: token decodes to the clearspace-hub-live tunnel. Signing Secret: shape only (checked live when Slack verifies the events URL).
"""
import json, os, subprocess, sys, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SVC, NSVC = "ClearSpace V1 - Hub dev (live)", "ClearSpace V1 - Notify dev (live)"
fails = 0
def res(ok, msg):
    global fails
    fails += 0 if ok else 1
    print(("ok   - " if ok else "FAIL - ") + msg)
def kc(svc, acct):
    r = subprocess.run(["security", "find-generic-password", "-s", svc, "-a", acct, "-w"], capture_output=True, text=True)
    return r.stdout.rstrip("\n") if r.returncode == 0 else None
def shape(kind, v):
    return subprocess.run(["python3", "-I", os.path.join(HERE, "hub-credential-check.py"), "validate", kind], input=v, text=True, capture_output=True,
                          env={**os.environ, "TID": "de4b0d15-7d47-4566-927c-bf1906f44358"}).returncode == 0
def post(url, data=None, timeout=15):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method="POST"), timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"{}")
        except Exception: return e.code, {}
    except Exception as e:
        return 0, {"error": type(e).__name__}

# --- Cloudflare
t = kc(SVC, "cloudflare_tunnel_token")
res(t is not None and shape("cf_tunnel", t), "Cloudflare: token present and belongs to tunnel clearspace-hub-live")
# --- Telegram bots
bots = {}
for role, svc, tok, usr, want_privacy_off in [("personal", NSVC, "telegram_bot_token", "telegram_bot_username", False),
                                               ("project", SVC, "telegram_hub_bot_token", "telegram_hub_bot_username", False),
                                               ("PI (optional)", SVC, "telegram_pi_bot_token", "telegram_pi_bot_username", True)]:
    token, user = kc(svc, tok), kc(svc, usr)
    if token is None and role.startswith("PI"):
        print("skip - optional PI bot not configured"); continue
    res(token is not None and user is not None and shape("tg_token", token) and shape("tg_user", user), f"Telegram {role}: token + username present, valid shape")
    code, b = post(f"https://api.telegram.org/bot{token}/getMe") if token else (0, {})
    r = b.get("result") or {}
    res(code == 200 and b.get("ok") is True, f"Telegram {role}: token accepted by Telegram (getMe)")
    res(bool(r) and str(r.get("username", "")).lower() == str(user).lstrip("@").lower(), f"Telegram {role}: stored username matches the bot")
    if r:
        if want_privacy_off:
            res(r.get("can_read_all_group_messages") is True, f"Telegram {role}: privacy mode OFF (reads the whole group, as intended for the read-only PI bot)")
        else:
            res(r.get("can_read_all_group_messages") is False, f"Telegram {role}: privacy mode ON (reads only commands and replies to itself)")
        res(r.get("can_join_groups") is True, f"Telegram {role}: may be added to groups")
        bots[role] = r.get("id")
ids = [i for i in bots.values() if i]
res(len(ids) == len(set(ids)), f"Telegram: the {len(ids)} bots are distinct")
# --- Slack apps
apps = {}
for role, svc, cid, csec, sig in [("personal", NSVC, "slack_client_id", "slack_client_secret", None),
                                   ("project", SVC, "slack_hub_client_id", "slack_hub_client_secret", "slack_hub_signing_secret")]:
    i, s = kc(svc, cid), kc(svc, csec)
    res(i is not None and s is not None and shape("slack_id", i) and shape("slack_secret", s), f"Slack {role}: Client ID + Client Secret present, valid shape")
    if sig:
        g = kc(svc, sig)
        res(g is not None and shape("slack_secret", g) and g != s, f"Slack {role}: Signing Secret present, valid shape, differs from the Client Secret")
    if i and s:
        code, b = post("https://slack.com/api/oauth.v2.access", urllib.parse.urlencode({"client_id": i, "client_secret": s, "code": "clearspace-run08-probe-invalid"}).encode())
        err = b.get("error")
        res(err == "invalid_code", f"Slack {role}: Slack accepts the client id + secret (probe answered '{err}', expected 'invalid_code')")
        apps[role] = i
res(len(apps) < 2 or apps["personal"] != apps["project"], "Slack: personal and project apps are two different apps")
print("\nVERIFY: " + ("PASS" if fails == 0 else f"{fails} FAIL"))
sys.exit(1 if fails else 0)
