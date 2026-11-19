#!/usr/bin/env bash
# Owner launcher for S1 (ONE real Soniox job). Expects the loopback-only local stack to be up (s1-local-stack.sh up). The key is typed into the HIDDEN prompt
# of soniox-real-test.sh; the Soniox region is detected from the key (free read-only call), never assumed. Stops the stack afterwards.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export S1_STACK_DIR=${S1_STACK_DIR:-/var/folders/p2/m_143hxx5b76yxwqjnwmr5500000gn/T/cs-intel-sb}
eval "$(frontend/scripts/s1-local-stack.sh env)"
CONFIRM_REAL_SONIOX_JOBS=1 frontend/scripts/soniox-real-test.sh; RC=$?
echo "== S1 finished with exit code $RC"; exit $RC
