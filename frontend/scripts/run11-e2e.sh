#!/usr/bin/env bash
# RUN 11 regression runner (before/after). Everything LOCAL on 127.0.0.1, zero paid calls (Google mock, fake Soniox, fake Gemini).
#   scripts/run11-e2e.sh meetings   # needs `meetings-stack.sh up`: meetings, PI, audio, live, calendar, drive, gmail, resources, collaboration, runtime
#   scripts/run11-e2e.sh demo       # no stack: kanban, reflow, feature-updates, ios-zoom + monograph-style (E2E_STYLE=monograph)
#   scripts/run11-e2e.sh hub        # needs `hub-stack.sh up`: hub, notify
# Every process it starts is stopped on exit. Output: Playwright list reporter.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
MODE=${1:?usage: run11-e2e.sh meetings|demo|hub}
PIDS=(); RC=0
# the installed headless shell (playwright.config.ts honours PW_CHROMIUM_PATH); nothing is downloaded
export PW_CHROMIUM_PATH=${PW_CHROMIUM_PATH:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell 2>/dev/null | tail -1)}
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -- "-$p" 2>/dev/null; kill "$p" 2>/dev/null; done; echo "local processes stopped"; }
trap cleanup EXIT
bg() { set -m; ( exec "$@" ) >"${LOG_DIR:-${TMPDIR:-/tmp}}/run11-e2e-$MODE-${#PIDS[@]}.log" 2>&1 & PIDS+=($!); set +m; }
wait_up() { for i in $(seq 1 90); do curl -s -o /dev/null --max-time 2 "$1" && return 0; sleep 2; done; echo "not up: $1"; exit 1; }
free() { for p in "$@"; do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$p/" && { echo "refusing: something already listens on $p"; exit 2; }; done; }

case "$MODE" in
  meetings)
    GP=55648; free 3481 55642 55643 $GP
    eval "$(scripts/meetings-stack.sh env)"
    case "$E2E_SUPABASE_URL" in http://127.0.0.1:*) ;; *) echo "refusing: not a local stack"; exit 2;; esac
    ACC=${MEETINGS_STACK_DIR:-${TMPDIR:-/tmp}/${MEETINGS_STACK_NAME:-cs-run10-sb}}/collab-accounts.env
    bg scripts/meetings-stack.sh mock; bg scripts/meetings-stack.sh soniox; bg node e2e/support/fake-gemini.mjs $GP
    sleep 1
    SECRET=$(sed -n 's/^STT_SERVER_SECRET=//p' "$ACC" | head -1)
    E2E_ENV=(GOOGLE_MOCK_URL=http://127.0.0.1:55642 E2E_FAKE_GEMINI_URL="http://127.0.0.1:$GP" E2E_FAKE_SONIOX_URL=http://127.0.0.1:55643
      FAKE_SONIOX_URL=http://127.0.0.1:55643 E2E_STT_SERVER_SECRET="$SECRET" E2E_MEETINGS_STACK=1 PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3481
      E2E_COLLAB_PASSWORD="$(sed -n 's/^COLLAB_PASSWORD=//p' "$ACC" | head -1)")
    app() { # $1 = DEV_AUTO_LOGIN (0 for the regular suites, 1 for meeting-live which opens ?login=auto)
      DEV_AUTO_LOGIN=$1 GEMINI_API_KEY=fake GEMINI_BASE_URL="http://127.0.0.1:$GP" GEMINI_MODEL=fake-gemini AI_RATE_PER_USER_PER_MINUTE=60 \
        AI_DAILY_TOKEN_BUDGET_PER_USER=5000000 NEXT_PUBLIC_ENABLE_MONOGRAPH=1 bg scripts/meetings-stack.sh app
      wait_up http://127.0.0.1:3481/login; APP=${PIDS[${#PIDS[@]}-1]}
    }
    app 0
    env "${E2E_ENV[@]}" npx playwright test ${SPECS:-e2e/meetings.spec.ts e2e/project-intelligence.spec.ts e2e/meeting-audio.spec.ts \
        e2e/calendar.spec.ts e2e/google-drive.spec.ts e2e/gmail.spec.ts e2e/task-resources.spec.ts e2e/collaboration.spec.ts \
        e2e/collaboration-01b.spec.ts e2e/r6-quality.spec.ts e2e/supabase-runtime.spec.ts} --workers=1 --retries=0 --reporter=list || RC=1
    kill -- "-$APP" 2>/dev/null; for i in $(seq 1 20); do curl -s -o /dev/null --max-time 1 http://127.0.0.1:3481/ || break; sleep 1; done
    app 1
    env "${E2E_ENV[@]}" npx playwright test e2e/meeting-live.spec.ts --workers=1 --retries=0 --reporter=list || RC=1;;
  demo)
    free 3492
    NEXT_PUBLIC_FORCE_DEMO=1 NEXT_PUBLIC_ENABLE_MONOGRAPH=1 bg ./node_modules/.bin/next dev -p 3492 -H 127.0.0.1
    wait_up http://127.0.0.1:3492/login
    PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3492 npx playwright test e2e/kanban.spec.ts e2e/reflow.spec.ts e2e/feature-updates.spec.ts \
      e2e/ios-zoom.spec.ts --workers=2 --retries=0 --reporter=list || RC=1
    E2E_STYLE=monograph PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3492 npx playwright test e2e/monograph-style.spec.ts e2e/kanban.spec.ts \
      --workers=2 --retries=0 --reporter=list || RC=1;;
  hub)
    free 3471 55621 55622 55623
    eval "$(scripts/hub-stack.sh env)"
    case "$E2E_SUPABASE_URL" in http://127.0.0.1:*) ;; *) echo "refusing: not a local stack"; exit 2;; esac
    bg scripts/hub-stack.sh mock; bg scripts/hub-stack.sh notify-mock; bg scripts/hub-stack.sh hub-mock
    sleep 1
    DEV_AUTO_LOGIN=0 NEXT_PUBLIC_ENABLE_MONOGRAPH=1 bg scripts/hub-stack.sh app
    wait_up http://127.0.0.1:3471/login
    NOTIFY_DB_CONTAINER=supabase_db_cs-notify-sb PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3471 \
      npx playwright test e2e/hub.spec.ts e2e/notify.spec.ts --workers=1 --retries=0 --reporter=list || RC=1;;
  *) echo "usage: run11-e2e.sh meetings|demo|hub"; exit 2;;
esac
echo "== RUN 11 E2E ($MODE) exit code $RC"; exit $RC
