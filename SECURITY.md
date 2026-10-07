# Security policy

## Supported versions

spec2test-jira-pilot is pre-1.0. Security fixes are made on the latest release
and on `main` only.

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public issues,
discussions, or pull requests.**

Report them privately through GitHub:
[**Report a vulnerability**](https://github.com/Koustubh-AI-LAB/spec2test-jira-pilot/security/advisories/new)
(the repository's *Security* tab → *Report a vulnerability*).

Please include:

- the affected component (`service/`, `runner/`, or `plugin/`) and version or
  commit;
- a description of the issue and its impact;
- steps to reproduce, or a proof of concept;
- any suggested fix, if you have one.

You can expect an acknowledgement within **5 business days**. The maintainer
will keep you updated on progress, coordinate a fix and a release, and credit
you in the advisory unless you prefer to stay anonymous.

## Scope notes

This project handles Jira API tokens and a target app's auth token, and it
runs generated test code. Issues of particular interest include:

- credential exposure (logs, error messages, audit records, Jira comments);
- ways to make the service mutate an environment registered as `production`;
- generated or validated test code escaping the validator's import allowlist;
- tampering with the append-only audit ledger through the application role.
