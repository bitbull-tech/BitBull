# Security Policy

## Supported versions

Only the latest `main` is supported. BitBob is a single-owner, self-hosted project —
you run your own copy, so keep it updated (`git pull` + redeploy).

## Reporting a vulnerability

**Please report privately via GitHub:** open a
[security advisory](https://github.com/tommyhgunz14/BitBob/security/advisories/new)
(Security tab → Advisories → "Report a vulnerability").

> Repository owner: enable **Private vulnerability reporting**
> (Settings → Security → Code security and analysis) so that link works.

- Please **do not** open public issues for vulnerabilities.
- Include: affected file/area, reproduction steps or PoC, impact, and suggested fix if
  you have one.
- **Never include real secrets** (API keys, tokens) in a report — describe the type of
  secret instead.
- Expect an acknowledgement within 7 days. We aim to confirm or refute within 30 days and
  will credit reporters in the fix notes unless you prefer otherwise.

## Scope notes

Read [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) first. The residual risks documented
there — most importantly the shared-uid limits (GAPS #11: `/proc` readability, egress
self-approval with `APP_TOKEN`, agent-writable database) — are **known and accepted** for
now; please report *new* instances or escalations of them only if they come with a
practical exploit beyond what the threat model already describes.

In scope for reports: RCE (server, engines, Windows scripts, desktop app), auth bypass,
secret exposure beyond the documented residuals, sandbox/egress escapes, supply-chain
poisoning of CI/dependencies, upload/link path escapes.

Out of scope: attacks that require the owner to deliberately disable protections
(`ALLOW_NO_AUTH=true`, `ALLOW_HOST_SHELL=true`, weakening the allowlist), and
denial-of-service against a single-owner instance.
