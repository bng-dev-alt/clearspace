"""RUN 08: END-TO-END test of `hub-live.sh setup` in a real pseudo-terminal (the same /dev/tty path a person types into), with SYNTHETIC
values and THROWAWAY Keychain services (the owner's items are never read or touched). Covers: bracketed-paste markers, spaces, a rejected
value that is asked for again, an optional item skipped with Enter, resume exactly at step 5b, read-back of every stored value, and that the
transcript never contains a secret.   python3 -I scripts/hub-live-setup.test.py
"""
import base64, json, os, pty, re, secrets, select, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
TID = "de4b0d15-7d47-4566-927c-bf1906f44358"
SVC, NSVC = "ClearSpace V1 - Hub setuptest", "ClearSpace V1 - Notify setuptest"
ITEMS = [(SVC, a) for a in ("cloudflare_tunnel_token", "telegram_hub_bot_token", "telegram_hub_bot_username", "telegram_pi_bot_token",
         "telegram_pi_bot_username", "telegram_pi_bot_skipped", "slack_hub_client_id", "slack_hub_client_secret", "slack_hub_signing_secret")] + \
        [(NSVC, a) for a in ("telegram_bot_token", "telegram_bot_username", "slack_client_id", "slack_client_secret")]
PASTE = lambda v: f"\x1b[200~{v}\x1b[201~"
fails = 0

def ok(cond, msg):
    global fails
    print(("ok   - " if cond else "FAIL - ") + msg); fails += 0 if cond else 1

def kc_get(svc, acct):
    r = subprocess.run(["security", "find-generic-password", "-s", svc, "-a", acct, "-w"], capture_output=True, text=True)
    return r.stdout.rstrip("\n") if r.returncode == 0 else None

def kc_put(svc, acct, v):
    subprocess.run(["security", "-i"], input=f'add-generic-password -U -s "{svc}" -a "{acct}" -w "{v}"\n', text=True, capture_output=True)

def wipe():
    for svc, acct in ITEMS:
        subprocess.run(["security", "delete-generic-password", "-s", svc, "-a", acct], capture_output=True)

def cf_token(tid):
    s = "???~~~" + base64.b64encode(os.urandom(32)).decode()
    return base64.b64encode(json.dumps({"a": "d" * 32, "t": tid, "s": s}, separators=(",", ":")).encode()).decode()

def run(script):
    """script: list of (prompt regex, text to type). Returns (exit code, transcript, prompts seen)."""
    env = {**os.environ, "HUB_LIVE_KEYCHAIN_SERVICE": SVC, "NOTIFY_LIVE_KEYCHAIN_SERVICE": NSVC}
    env.pop("HUB_INPUT", None)
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("bash", ["bash", os.path.join(HERE, "hub-live.sh"), "setup"], env)
    out, seen, i, deadline = b"", [], 0, time.time() + 25
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        text = out.decode(errors="replace")
        if i < len(script) and re.search(script[i][0] + r"[^\n]*: $", text):
            seen.append(script[i][0]); os.write(fd, (script[i][1] + "\r").encode()); i += 1
            out += b"\n"      # separate this prompt from the next one in the transcript
    if time.time() >= deadline:
        print("    (timeout; transcript tail:) " + repr(out.decode(errors="replace")[-300:]))
        os.kill(pid, 9)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status), out.decode(errors="replace"), seen

wipe()
try:
    v = {"cf": cf_token(TID), "ptok": f"{secrets.randbelow(9 * 10**9) + 10**9}:AA{secrets.token_urlsafe(24)[:33]}",
         "htok": f"{secrets.randbelow(9 * 10**9) + 10**9}:AA{secrets.token_urlsafe(24)[:33]}",
         "pid": f"{secrets.randbelow(10**13)}.{secrets.randbelow(10**13)}".replace(".0.", ".1."), "psec": secrets.token_hex(16),
         "hid": "1234567890123.9876543210987", "hsec": secrets.token_hex(16), "hsig": secrets.token_hex(16)}
    v["pid"] = "4455667788990.1122334455667"
    # ---------- A: fresh run, everything asked, with paste markers, spaces, a rejected value and a skipped optional item
    code, t, seen = run([
        (r"Tunnel token", cf_token("00000000-0000-4000-8000-000000000000")),     # another tunnel -> rejected, asked again
        (r"Tunnel token", PASTE(v["cf"])),
        (r"Personal bot token", PASTE(v["ptok"])), (r"Personal bot username", "@cs_osobni_test_bot"),
        (r"Project bot token", v["htok"]), (r"Project bot username", PASTE("cs_projekty_test_bot")),
        (r"PI bot token", ""),                                                     # optional: Enter skips
        (r"Personal app Client ID", v["pid"] + "1234567890123.1"),                 # two values pasted together -> rejected
        (r"Personal app Client ID", PASTE("  " + v["pid"] + " ")),
        (r"Personal app Client Secret", PASTE(v["psec"])),
        (r"Project app Client ID", PASTE(v["hid"])), (r"Project app Client Secret", v["hsec"]), (r"Project app Signing Secret", PASTE(v["hsig"]))])
    ok(code == 0, f"A: setup finished (exit {code})")
    ok(len(seen) == 13, f"A: every prompt was reached in order ({len(seen)}/13)")
    ok(t.count("rejected (attempt") == 2, "A: the two wrong values were rejected and asked for again (not skipped)")
    ok("ANOTHER tunnel" in t and "more than one dot" in t, "A: diagnostics explain both rejections")
    ok("removed" in t and "paste markers" in t, "A: terminal paste markers removed and reported")
    ok("command not found" not in t, "A: no shell errors (bash 3.2)")
    want = {(SVC, "cloudflare_tunnel_token"): v["cf"], (NSVC, "telegram_bot_token"): v["ptok"], (NSVC, "telegram_bot_username"): "cs_osobni_test_bot",
            (SVC, "telegram_hub_bot_token"): v["htok"], (SVC, "telegram_hub_bot_username"): "cs_projekty_test_bot", (NSVC, "slack_client_id"): v["pid"],
            (NSVC, "slack_client_secret"): v["psec"], (SVC, "slack_hub_client_id"): v["hid"], (SVC, "slack_hub_client_secret"): v["hsec"],
            (SVC, "slack_hub_signing_secret"): v["hsig"]}
    ok(all(kc_get(*k) == w for k, w in want.items()), "A: the Keychain holds exactly the clean values (10 items)")
    ok(kc_get(SVC, "telegram_pi_bot_token") is None and kc_get(SVC, "telegram_pi_bot_skipped") == "yes", "A: the skipped optional PI bot was not stored; the choice is remembered")
    leaked = [k for k in ("cf", "ptok", "htok", "psec", "hsec", "hsig") if v[k] in t or v[k][8:24] in t]
    ok(not leaked, f"A: no secret (or part of one) appears in the terminal transcript {leaked or ''}")
    for k in leaked:   # synthetic values: safe to show where they appeared
        j = t.find(v[k][8:24]); print("    context:", repr(t[max(0, j - 120):j + 40]))
    # ---------- B: resume -- everything present except the PROJECT Slack app: the first question must be its Client ID
    for acct in ("slack_hub_client_id", "slack_hub_client_secret", "slack_hub_signing_secret"):
        subprocess.run(["security", "delete-generic-password", "-s", SVC, "-a", acct], capture_output=True)
    kc_put(SVC, "slack_hub_client_id", v["hid"])                                   # partially stored group: only the rest is asked
    code, t, seen = run([(r"Project app Client Secret", PASTE(v["hsec"])), (r"Project app Signing Secret", v["hsig"])])
    first_q = re.search(r"\(hidden[^)]*\): |[A-Za-z ]+: $", t)
    ok(code == 0 and seen == [r"Project app Client Secret", r"Project app Signing Secret"], f"B: resumes at the first missing item only (exit {code}, asked {len(seen)})")
    ok("Tunnel token: already in the Keychain" in t and "Personal app Client Secret: already in the Keychain" in t and "skipped earlier" in t, "B: earlier items (and the skipped PI bot) reported, not asked")
    ok(kc_get(SVC, "slack_hub_client_secret") == v["hsec"] and kc_get(SVC, "slack_hub_signing_secret") == v["hsig"], "B: the remaining two stored and verified")
    # ---------- C: Ctrl-D (input closed) stops cleanly instead of looping
    subprocess.run(["security", "delete-generic-password", "-s", SVC, "-a", "slack_hub_signing_secret"], capture_output=True)
    code, t, seen = run([(r"Project app Signing Secret", "\x04")])
    ok(code != 0 and "stopping" in t, "C: closed input stops the setup (no endless loop), nothing half-stored")
finally:
    wipe()
    ok(all(kc_get(*k) is None for k in ITEMS), "cleanup: throwaway Keychain services removed")
print("\nSETUP E2E: " + ("PASS" if fails == 0 else f"{fails} FAIL"))
sys.exit(1 if fails else 0)
