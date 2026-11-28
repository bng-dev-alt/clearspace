#!/usr/bin/env bash
# Hermetic check of the preventive Docker guard in collab-stack.sh (fake supabase / node / docker on PATH; no real Docker touched).
#   bash frontend/scripts/stack-guard.test.sh
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/stackguard.XXXXXX") || exit 2; trap 'kill $(cat "$T/srv.pid" 2>/dev/null) 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/stack/supabase"; touch "$T/stack/supabase/config.toml"
cat > "$T/bin/supabase" <<'S'
#!/usr/bin/env bash
echo "DOCKER_HOST=${DOCKER_HOST:-unset} $*" >> "$GUARD_LOG"
S
printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/docker"            # docker ps: no containers, no LAN ports
cat > "$T/bin/node-dead" <<'S'
#!/usr/bin/env bash
exit 0
S
cat > "$T/bin/node-proxy" <<'S'
#!/usr/bin/env bash
# stands in for docker-loopback-proxy.mjs: answers /_ping on the given unix socket
exec python3 -c 'import http.server,socketserver,sys,os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s): s.send_response(200); s.end_headers(); s.wfile.write(b"OK")
    def log_message(*a): pass
class U(socketserver.UnixStreamServer):
    def get_request(s): r,_=super().get_request(); return r,("local",0)
U(sys.argv[1],H).serve_forever()' "$2"
S
chmod +x "$T/bin/"*
export GUARD_LOG=$T/log COLLAB_STACK_DIR=$T/stack COLLAB_STACK_NAME=guard-test-$$ COLLAB_STACK_SOCK=$T/proxy.sock
fail=0
# 1) proxy cannot start -> refused BEFORE the CLI runs
ln -sf "$T/bin/node-dead" "$T/bin/node"
out=$(PATH="$T/bin:$PATH" bash "$HERE/collab-stack.sh" sb db reset 2>&1); rc=$?
[ $rc -ne 0 ] && grep -q REFUSING <<<"$out" && [ ! -s "$T/log" ] && echo "ok   - dead proxy: refused, supabase never called" || { echo "FAIL - dead proxy: rc=$rc out=$out log=$(cat "$T/log" 2>/dev/null)"; fail=1; }
# 2) live proxy -> CLI runs with DOCKER_HOST forced to the proxy, even if the caller exported another DOCKER_HOST
rm -f "$T/stack/loopback-proxy.pid"; ln -sf "$T/bin/node-proxy" "$T/bin/node"
out=$(DOCKER_HOST=unix:///var/run/docker.sock PATH="$T/bin:$PATH" bash "$HERE/collab-stack.sh" sb db reset 2>&1); rc=$?
cp "$T/stack/loopback-proxy.pid" "$T/srv.pid" 2>/dev/null
grep -qx "DOCKER_HOST=unix://$T/proxy.sock db reset" "$T/log" && [ $rc -eq 0 ] && echo "ok   - live proxy: supabase ran only via the proxy socket" || { echo "FAIL - live proxy: rc=$rc out=$out log=$(cat "$T/log")"; fail=1; }
exit $fail
