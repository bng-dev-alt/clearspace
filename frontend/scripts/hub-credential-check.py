"""RUN 08: shell-independent credential validator for hub-live.sh (macOS ships bash 3.2).

  printf '%s' "$value" | python3 -I scripts/hub-credential-check.py sanitize          -> cleaned value on stdout, removal note on stderr
  printf '%s' "$value" | python3 -I scripts/hub-credential-check.py validate KIND     -> exit 0 ok | 1 + diagnostics on stderr

Diagnostics describe only the SHAPE of a value (length, character classes, yes/no facts) -- never the value or any part of it.
KIND: cf_tunnel | tg_token | tg_user | slack_id | slack_secret
"""
import base64, json, os, re, sys

PASTE = re.compile(r"\x1b\[20[01]~")          # bracketed-paste markers some terminals wrap pasted text in
RULES = {
    "tg_token": re.compile(r"[0-9]{6,12}:[A-Za-z0-9_-]{30,64}"),
    "tg_user": re.compile(r"[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]"),
    "slack_id": re.compile(r"[0-9]{3,20}\.[0-9]{3,20}"),
    "slack_secret": re.compile(r"[0-9a-f]{32}"),  # RUN 09: Slack client / signing secrets are exactly 32 hex (a 64-char paste = two values)
}

def sanitize(v):
    cleaned = PASTE.sub("", v)
    cleaned = "".join(c for c in cleaned if "!" <= c <= "~")       # printable ASCII without spaces
    removed = len(v) - len(cleaned)
    return cleaned, removed

def shape(v):
    return {
        "length": len(v),
        "digits": sum(c.isdigit() for c in v),
        "letters": sum(c.isalpha() and c.isascii() for c in v),
        "dots": v.count("."),
        "colons": v.count(":"),
        "other_characters": sum(not (c.isalnum() and c.isascii()) and c not in ".:" for c in v),
    }

def cf_tunnel(v, expected):
    d = {"only_base64_chars": bool(re.fullmatch(r"[A-Za-z0-9+/_=-]+", v)),
         "looks_like_a_command_was_pasted": bool(re.search(r"cloudflared|service|install|sudo", v))}
    raw = None
    for f in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            raw = f(v + "=" * (-len(v) % 4)); break
        except Exception:
            pass
    d["base64_decodes"] = raw is not None
    j = None
    if raw is not None:
        try:
            j = json.loads(raw)
        except Exception:
            pass
    d["decodes_to_json"] = isinstance(j, dict)
    d["has_account_tunnel_secret_keys"] = isinstance(j, dict) and all(k in j for k in ("a", "t", "s"))
    d["tunnel_is_clearspace_hub_live"] = isinstance(j, dict) and j.get("t") == expected
    ok = d["only_base64_chars"] and d["has_account_tunnel_secret_keys"] and d["tunnel_is_clearspace_hub_live"]
    hints = []
    if d["has_account_tunnel_secret_keys"] and not d["tunnel_is_clearspace_hub_live"]:
        hints.append("this is a valid token of ANOTHER tunnel; open clearspace-hub-live")
    return ok, d, hints

def validate(kind, v):
    if kind == "cf_tunnel":
        ok, d, hints = cf_tunnel(v, os.environ.get("TID", ""))
    elif kind in RULES:
        if kind == "tg_user":
            v = v[1:] if v.startswith("@") else v
        ok = bool(RULES[kind].fullmatch(v)); d = {}; hints = []
        if not ok:
            if kind == "slack_id":
                parts = v.split(".")
                d["form_digits_dot_digits"] = len(parts) == 2 and all(p.isdigit() for p in parts)
                d["digits_per_part"] = [sum(c.isdigit() for c in p) for p in parts][:4]
                if v.count(".") > 1:
                    hints.append("more than one dot: two values may have been pasted together")
                if any(c.isalpha() for c in v):
                    hints.append("letters found: maybe the App ID, Client Secret or a label was copied instead of the Client ID")
            elif kind == "tg_token":
                head, _, tail = v.partition(":")
                d["digits_before_colon"] = sum(c.isdigit() for c in head)
                d["characters_after_colon"] = len(tail)
                d["starts_with_bot"] = v.startswith("bot")
            elif kind == "tg_user":
                d["ends_with_bot"] = v.lower().endswith("bot")
            elif kind == "slack_secret":
                d["only_letters_and_digits"] = v.isalnum() and v.isascii()
                if len(v) > 32:
                    hints.append("too long: two values may have been pasted together (copy only the one secret)")
    else:
        print(f"    unknown kind {kind}", file=sys.stderr); return False
    if not ok:
        for key, val in {**shape(v), **d}.items():
            print(f"    {key}: {val}", file=sys.stderr)
        for h in hints:
            print(f"    -> {h}", file=sys.stderr)
    return ok

if __name__ == "__main__":
    value = sys.stdin.read()
    if sys.argv[1] == "sanitize":
        cleaned, removed = sanitize(value)
        if removed:
            print(f"  note: removed {removed} invisible / space / control character(s) from the input (e.g. terminal paste markers)", file=sys.stderr)
        sys.stdout.write(cleaned)
    else:
        sys.exit(0 if validate(sys.argv[2], value) else 1)
