# Dot-source this in PowerShell to use the s2t CLI directly, without the
# claude --plugin-dir plugin slash command:
#
#   . .\scripts\s2t-env.ps1
#   s2t preflight
#   s2t status --issue S2T-4
#
# Assumes the stack is already up: Docker Postgres containers running, the
# Conduit dev server on :3000, and the State Service on :8787 (see the
# README for how to start each).

$RepoRoot = Split-Path -Parent $PSScriptRoot

$env:SPEC2TEST_SERVICE_URL = "http://127.0.0.1:8787"
$env:SPEC2TEST_PROJECT_KEY = "S2T-PILOT"
# Actor defaults to your git email; set $env:SPEC2TEST_ACTOR first to override.
if (-not $env:SPEC2TEST_ACTOR) { $env:SPEC2TEST_ACTOR = (git config user.email) }
$env:CONDUIT_BASE_URL = "http://localhost:3000/api"
# Conduit clone defaults to a sibling of this repo; set $env:CONDUIT_REPO_PATH first to override.
if (-not $env:CONDUIT_REPO_PATH) { $env:CONDUIT_REPO_PATH = Join-Path (Split-Path -Parent $RepoRoot) "conduit" }

function s2t {
    node --experimental-strip-types "$RepoRoot\plugin\cli\bin\s2t.mjs" @args
}

Write-Host "s2t env ready - project $env:SPEC2TEST_PROJECT_KEY, actor $env:SPEC2TEST_ACTOR, target $env:CONDUIT_BASE_URL"
Write-Host "try: s2t preflight"
