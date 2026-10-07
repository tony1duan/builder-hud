# Security Policy

## Supported versions

Only the latest release is supported. Fixes ship as a patch release on `main`; there
are no maintenance branches, and the two packages — the skin
(`dsh-plugin-souls-hud`) and the bundle (`dsh-plugin-builder-hud`) — are versioned
together and released as one tag.

| Version | Supported |
| --- | --- |
| 0.4.x (latest) | yes |
| anything older | no — upgrade |

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private reporting on this
repository: the *Report a vulnerability* button on the
[Security tab](https://github.com/tony1duan/builder-hud/security/advisories/new). It
opens a private advisory only the maintainer can read, and it is the one channel that
stays private end to end.

A useful report says which of the surfaces below you reached, what you sent it, and
what happened. A minimal SVG, or the `curl` line, is worth more than a description.

This is a one-person, unpaid project. Expect an acknowledgement within a few days and
an honest answer about whether and when it will be fixed. There is no bounty.

## What is worth attacking

The plugin runs inside DSH, in the user's own process, holding the user's own
credentials. Three surfaces are ours.

### 1. The uploaded device art

A device can be an SVG the user uploads, and the renderer draws it in the sidebar.
`normalizeUpload` in `lib/client.js` is the only thing between that file and the DOM:
it parses it, strips scripting and anything external, and re-serializes it. **An escape
from that sanitizer is the bug worth finding** — the sidebar is the app's own page, so
it would be stored cross-site scripting against the user's session.

`test/upload.mjs` drives it against hostile fixtures, and the fixtures are the shapes
already known to matter: `<script>`, event-handler attributes, `style`, remote
`<image>` and `<use>`, and `javascript:` and `data:` URLs. If you have a payload that
survives, that is the report.

### 2. The local HTTP routes

The host registers routes on DSH's own web server, all under `/dsh-souls-hud`:

| Route | What it does |
| --- | --- |
| `GET /dsh-souls-hud/state.json` | the current reading, **including the account balance** |
| `GET /dsh-souls-hud/assets/…`, `GET /dsh-souls-hud/support/…` | serves files out of the package |
| `GET /dsh-souls-hud/holidays.json` | the holiday calendar's status |
| `POST /dsh-souls-hud/holidays.json` | refreshes the calendar upstream — the only route that reaches the network |

These are loopback routes on a server DSH binds to `127.0.0.1`, and they are not
authenticated beyond that. Anything that can already make requests to loopback can read
the balance; that is a property of the design rather than a vulnerability, and it is why
every route is read-only apart from the calendar refresh. What *is* in scope: a path
that escapes the package directory, a response that reflects a request header into a
document, or a `POST` a web page can trigger cross-origin that has a side effect.

### 3. The upstream calendar fetch

The refresh pulls the Chinese public-holiday calendar over the network. An upstream
that is malicious or compromised, and that gets a payload through the parser, is in
scope.

## Out of scope

- **DSH itself, and DeepSeek's APIs and servers.** Report those to their owners. This
  is an independent third-party plugin, not affiliated with DeepSeek.
- Anything that needs code execution on the machine already, or the ability to edit the
  user's profile and plugin files.
- The balance being readable by a process that can already reach loopback — see above.
- Hardening with no path to an impact. Say what the impact is, and it becomes
  interesting.
