---
name: pipeline
description: Drive a Jira ticket through the spec2test pipeline - draft requirement and criteria, wait on Gate 1, draft and verify test cases, wait on Gate 2, certify, sync back to Jira. Resumable across sessions.
disable-model-invocation: true
allowed-tools: Bash(s2t:*), Read, Write
---

# spec2test pipeline (0.0 smoke-test stub)

This is a placeholder body used only to prove three things in Phase 0.0 of
`PLAN-5.3-5.7-WALKING-SKELETON.md`:

1. `disable-model-invocation: true` is accepted frontmatter and the skill
   loads via `--plugin-dir`.
2. `allowed-tools: Bash(s2t:*), Read, Write` is accepted and actually
   scopes Bash to commands prefixed `s2t`.
3. A command of the shape `s2t <command> --json-file <path> --model <id>`
   is permitted under that scope.

`s2t`, not `spec2test`: this developer machine already has an unrelated
Python CLI named `spec2test` (TestForge) earlier on PATH in both Git Bash
and PowerShell, confirmed during this smoke test.

The real switch-on-`stage` body lands in 5.5. Until then, invoking this skill
should just run:

```bash
s2t draft-criteria --json-file /tmp/test.json --model claude-test-model
```

and confirm the JSON echoed back on stdout matches what was passed.
