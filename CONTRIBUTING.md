# Contributing to spec2test-jira-pilot

Thanks for your interest in improving spec2test. This guide covers how to set
up a development environment, what a good change looks like, and how to get it
merged.

## Ground rules

- Be respectful. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Report security issues privately** — see [SECURITY.md](SECURITY.md). Never
  open a public issue for a vulnerability.
- For anything larger than a small fix, open an issue first so the approach can
  be agreed before you invest time in it.

## Development setup

You need Node.js 22.9+ and Docker.

```bash
git clone https://github.com/<your-fork>/spec2test-jira-pilot.git
cd spec2test-jira-pilot
npm ci
npm run db:up    # Postgres 16 on localhost:5435
```

The test suite creates and migrates its own `spec2test_test` database. Jira and
target-app credentials are **not** needed: live tests skip themselves when
`JIRA_API_TOKEN` or `CONDUIT_BASE_URL` is unset. See the
[README](README.md#quick-start) to run the full pipeline end to end.

## Before you open a pull request

Run the same checks CI runs:

```bash
npm run lint
npm run format:check   # npm run format fixes it
npm run typecheck
npm test
```

Also:

- **Add a test for every behavior change.** Tests here prove specific
  properties (see "What the tests prove" in the README); a fix should come with
  the regression test that would have caught the bug.
- **Keep changes focused.** One logical change per pull request.
- **Never commit secrets.** `.env` is gitignored; put new settings in
  `.env.example` with an empty value and a comment explaining them.
- **Prompt files are hash-locked.** If you edit anything in `plugin/prompts/`,
  run `npm run prompts:lock -w plugin/cli` and commit the updated
  `prompts.lock.json`.
- **Schema changes go in a new migration** in `service/migrations/`; never edit
  one that has already been released.

## Commit messages

Write a short imperative summary line (under ~72 characters), a blank line,
then a body explaining *what* changed and *why*. Reference issues with
`Fixes #123` where relevant.

## Pull request process

1. Fork the repo and create a branch from `main`.
2. Make your change with tests, and run the checks above.
3. Open a pull request and fill in the template.
4. CI must pass. A maintainer will review; please respond to feedback by
   pushing new commits rather than force-pushing over review history.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
