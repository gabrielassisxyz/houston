# Security policy

Houston is a local web UI. It runs on your machine, reads and writes your beads
through the `br` or `bd` CLI, and serves a small HTTP API on `127.0.0.1`. A bug
that lets a web page you visit, another user, or another process change your
beads, read your files, or run commands is a security issue, and we want to
hear about it.

## Supported versions

Security fixes land on `main`. Pull and rebuild the latest commit before
reporting, if you can.

| Version | Supported |
| ------- | --------- |
| `main` (latest) | Yes |
| Older commits | No |

## Reporting a vulnerability

**Please don't open a public issue, pull request or discussion for a
vulnerability.**

Report it privately through GitHub instead:
[**Report a vulnerability**](https://github.com/gabrielassisxyz/houston/security/advisories/new)
(the *Security* tab, then *Report a vulnerability*). Only the repository
maintainers can see the report.

These help reproduce it quickly:

- the Houston build (shown in the sidebar) and how you launch it
- your `br` or `bd` version and operating system
- the launch settings involved, such as `SCOTTY_ALLOWED_HOSTS`,
  `SCOTTY_READ_ONLY` or a reverse proxy in front of Houston
- the steps or a proof of concept, and what an attacker gains

## Scope

In scope: anything that crosses the boundaries Houston is meant to keep.
Examples are cross-site or DNS-rebinding requests reaching the API, writes
accepted in read-only mode, path traversal through attachments or the folder
picker, and command or argument injection into `br`, `bd` or other tools
Houston runs.

Out of scope: setups that deliberately remove a protection, such as
`SCOTTY_ALLOWED_HOSTS=*` without anything else controlling who can reach the
server, or exposing Houston to an untrusted network. Read-only mode is a
viewing preference, not access control (see the README). Vulnerabilities in
`br` or `bd` themselves belong with their upstream projects.
