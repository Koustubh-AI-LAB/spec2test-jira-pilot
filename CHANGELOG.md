# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-07

First public release: the walking skeleton, end to end.

### Added

- **State Service** (`service/`): Postgres-backed pipeline state with Gate 1
  (PO approval in Jira) and Gate 2 (developer approval), an append-only audit
  ledger enforced by a constrained database role, content-hash binding of every
  decision, and an environment allowlist whose capabilities derive from the
  environment class.
- **Jira integration**: read-back and write-back with no webhook. Each run
  reconciles against the ticket's current state, including approval,
  rejection with the PO's comment as the reason, and drift detection.
- **Runner** (`runner/`): Playwright API test generation from validated specs,
  a five-stage validator, and tier-1 fault injection (Kill Set / Immunity Set)
  that certifies a test only when it catches the bug it claims to.
- **Claude Code plugin** (`plugin/`): the resumable `/pipeline` skill, the
  `s2t` CLI it drives, and hash-locked, versioned drafting prompts.
- **Background verification**: `verify` enqueues a job that a worker poller
  runs; requirement-level locking serializes concurrent writers; a durable cap
  limits failed spec-drafting attempts.
- **Project tooling**: CI (lint, format, typecheck, tests on Node 22 and 24
  against Postgres), CodeQL, OpenSSF Scorecard, Dependabot, and contributor
  documentation.

[Unreleased]: https://github.com/Koustubh-AI-LAB/spec2test-jira-pilot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Koustubh-AI-LAB/spec2test-jira-pilot/releases/tag/v0.1.0
