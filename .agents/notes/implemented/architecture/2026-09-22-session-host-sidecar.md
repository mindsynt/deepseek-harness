# Agent Note: Session-to-host identity as a storage-domain sidecar

Status: implemented

English | [中文](2026-09-22-session-host-sidecar.zh.md)

## Problem

A Session's log records its working directory but not the execution world that interprets it. The [GUI-managed SSH remote hosts proposal](../../proposed/architecture/2026-09-21-gui-managed-ssh-remote-hosts.md) needs that fact for resume, for degrading open/reveal on a remote path, and for a per-host home; its own plan expected a host field beside `cwd` in the session header.

Two constraints rule that out. A released v3 reader rejects a header carrying an unknown key, because the JSONL header keys are a strict whitelist, so adding a field in place makes every new log unreadable to shipped builds. Bumping the format to version 4 is a structural change with a fixed price: a migration package, an archived v3 predecessor, a persistence-change record, successor snapshots, and both the TypeScript and Python SDK projections. Meanwhile the fact already exists beside the log for the ordinary path: the GUI creates a Session through a `workspaceId`, and the Workspace record carries the host that owns its path.

## Decision

Session-to-host identity lives in a durable sidecar, not in the Session log. `packages/api/session-controller/src/session-hosts.ts` declares the `session_host` domain, version 1, with one `session_hosts` table keyed by `SessionId` and one record shape, `{ hostId }`. The store opens that domain once through `ctx.storageDomain`, closes it with the owning fiber, reads records as synchronous table lookups, and writes them durably. An unavailable storage domain, a failed open, a failed write, and a second record naming a different host all throw; the sidecar never drops a Session's host silently. `SessionHeader`, `SESSION_FORMAT_VERSION`, and the log format are untouched.

The record is written inside the operation that creates the Session. A Session created from a `workspaceId` records that Workspace's `hostId`; one created from a bare `cwd` records the built-in local host, which is the behaviour such a Session has today. Recording happens after the Agent exists and before the create call returns, so a failure is reported to the creator rather than leaving an answer that a later read would invent.

One resolution order serves resume, adopt, and every later host-addressed consumer: the durable record, then the Workspace whose `sessionIds` account for the Session, then the built-in local host. A Session written before this sidecar has no record, so it resolves exactly as it did before; resuming or adopting one backfills the record with the host that resolution produced. `ApiSessionAgentController.resolvedHostOf` is the single read surface for that resolution. Host identity is immutable once recorded: a conflicting second host fails long before it could reinterpret a Session's cwd in another world.

## Returning to a log-carried host

The sidecar answers only for a reader that can reach the same storage medium. A format-carried host becomes necessary the moment a consumer must see the host from the Session log alone — a cold listing, export, or tool that reads JSONL without opening the storage domain, a reader outside this Harness process such as the Python runtime, or a requirement that host identity survive copying the session file by itself. At that point the sidecar cannot answer and only a header field with its format-version consequences can, so that requirement must be treated as a format change rather than another sidecar.

## Alternatives considered

**Add `hostId` to the existing v3 header.** This is the smallest change in the source and the cheapest to read. It also makes every shipped v3 reader reject a new log, because the header keys are a strict whitelist; a Session written today would be unresumable by the build that wrote yesterday's.

**Bump the format to version 4 and carry the host in the header.** This keeps one durable source of truth and needs no second store. It buys a migration package, an archived v3 predecessor, a persistence-change record, successor snapshots, and both SDK projections for a fact that the GUI's ordinary creation path can already answer from the Workspace record, and no current consumer reads the host from the log alone.

**Derive the host only from the Workspace at read time.** No new durable store is needed, and the Workspace record is already authoritative for workspace-scoped Sessions. It cannot answer for a bare-`cwd` Session, gives nothing once the Workspace is deleted, and turns every read into a scan of the Workspace registry.

## Consequences

Released readers, including both SDK projections, keep opening today's logs, and host identity is added without a migration or a snapshot successor. The cost is a second durable store that must be written with creation: a Session whose record write is missed degrades to the Workspace-then-local fallback rather than being misread, and the domain name, version, and record shape become durable formats that a later change must version.

A process that has the sessions but not the sidecar medium cannot see a Session's host. Within this Harness the storage domain is the same medium that owns the Workspace records, so the two sidecars agree; the boundary is what the "returning to a log-carried host" section names.

## Verification

`packages/api/session-controller/tests/session-hosts.host.spec.ts` covers recording and reading a host, refusing a conflicting one, the record-then-Workspace-then-local fallback order, a loud write failure, normalization of an empty stored host on reopen, a record read by a new store over the same medium, loud failures for a missing storage domain and a missing Workspace registry, and disposal of an unopened and a failed-open domain. `tests/agent.host.spec.ts` covers creation recording the named remote host and the local host for a bare cwd, a legacy Session resolving through its Workspace on resume and backfilling that record, and the remote create path keeping its provisioning policy. Every changed source file holds per-file 100% coverage.

## Related

The [filesystem directory-creation decision](2026-09-22-filesystem-directory-creation-primitive.md) owns the session-cwd provisioning policy this sidecar's host then addresses. The [GUI-managed SSH remote hosts proposal](../../proposed/architecture/2026-09-21-gui-managed-ssh-remote-hosts.md) remains active for the host registry and GUI surfaces; this note supersedes only its expectation that the Session header carries the host identity.