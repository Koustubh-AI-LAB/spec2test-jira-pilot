#!/usr/bin/env bash
# Source this in any Bash session to use the s2t CLI directly, without the
# claude --plugin-dir plugin slash command:
#
#   source scripts/s2t-env.sh
#   s2t preflight
#   s2t status --issue S2T-3
#
# Assumes the stack is already up: Docker Postgres containers running, the
# Conduit dev server on :3000, and the State Service on :8787 (see the
# README for how to start each).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export SPEC2TEST_SERVICE_URL=http://127.0.0.1:8787
export SPEC2TEST_PROJECT_KEY=S2T-PILOT
# Actor defaults to your git email; set SPEC2TEST_ACTOR first to override.
export SPEC2TEST_ACTOR="${SPEC2TEST_ACTOR:-$(git config user.email)}"
export CONDUIT_BASE_URL=http://localhost:3000/api
# Conduit clone defaults to a sibling of this repo; set CONDUIT_REPO_PATH first to override.
export CONDUIT_REPO_PATH="${CONDUIT_REPO_PATH:-$(cd "$REPO_ROOT/.." && pwd)/conduit}"

s2t() {
  node --experimental-strip-types "$REPO_ROOT/plugin/cli/bin/s2t.mjs" "$@"
}

echo "s2t env ready - project $SPEC2TEST_PROJECT_KEY, actor $SPEC2TEST_ACTOR, target $CONDUIT_BASE_URL"
echo "try: s2t preflight"
