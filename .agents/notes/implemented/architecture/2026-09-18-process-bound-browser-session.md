# Agent Note: Process-bound browser sessions

Status: implemented

English | [中文](2026-09-18-process-bound-browser-session.zh.md)

## Problem

The [browser launch-token authentication](2026-08-24-browser-token-authentication.md) decision kept the cookie signing secret durable so a browser could reconnect after an ordinary `dsh` restart. That made the launch token a process credential while the cookie it exchanged became a long-lived one: a cookie kept working for up to `cookieMaxAgeDays` (30 by default) across any number of restarts, so stopping the Host did not end the browser sessions the previous process had authorized. An operator who stopped the server had no restart-scoped revocation; the documented mechanism deleted the credential record, which also ended every other browser session and required editing a credentials file.

## Decision

`BrowserAuth` derives each process's signing key from the durable record and the process's own launch token: `HMAC-SHA256(rootSecret, launchToken)`. `isAuthenticated` verifies cookies with that key, so a cookie authenticates only the process that issued it. A restart mints a new launch token, so every cookie from a previous process fails verification and receives the minimal 401 — the response unauthenticated requests already get, whose text already tells the caller to reopen the URL printed by `dsh web`.

Nothing else about the session changes. The cookie keeps its authority binding, its absolute `cookieMaxAgeDays` lifetime, and its attributes; a Connection reload inside one process keeps the launch token and therefore keeps the browser signed in; and the durable `client-connection/browser-session` record stays the revocation root, because deleting it still invalidates every cookie issued afterwards.

## Alternatives considered

**Keep the durable secret as the signing key.** Rejected: it is the behavior this note replaces. It gives a stolen cookie the whole configured lifetime and makes "restart the Host" an operation that does not end browser authority.

**Only shorten `cookieMaxAgeDays`.** Rejected: it bounds a stolen cookie's window but leaves the restart expectation unmet, since the operator still cannot end prior sessions by restarting.

**Rotate the durable secret on every restart.** Rejected: it would rewrite `$DSH_HOME/.credentials.yaml` on every start, race concurrent starts, and spend the record's role as an explicit revocation root. Deriving a process key from the existing secret and launch token reaches the same validity rule without touching durable state.

**Add a logout or session-revocation verb.** Rejected: no current consumer asks for revoking one session, and the process binding closes the restart gap this note is about. Deleting the credential record and restarting remains the global revocation mechanism.

## Consequences

- Every browser session ends when the Host process stops, including a same-home restart on the same authority. Reopening the printed URL is the way back in, which is what the 401 body already instructs.
- A stolen cookie is bounded by the process lifetime as well as by its absolute lifetime, so the durable secret no longer implies a bearer lifetime of its own.
- A Connection reload (HMR, generation replacement) stays inside one process and does not sign the browser out.
- The durable record signs nothing directly anymore; its remaining role is the revocation root, and its absence or replacement still invalidates every later cookie.