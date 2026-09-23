# Agent Note: GUI-managed SSH remote hosts and per-session execution worlds

Status: proposed

English | [中文](2026-09-21-gui-managed-ssh-remote-hosts.zh.md)

## Problem

The [POSIX SSH runtime](../../implemented/architecture/2026-09-11-posix-ssh-runtime.md) already ships a working remote execution world: [`dsh-ssh`](../../../../packages/ssh/ssh/README.md) owns one OpenSSH connection and a digest-verified helper, and [`fs-ssh`](../../../../packages/ssh/fs-ssh/README.md), [`subprocess-ssh`](../../../../packages/ssh/subprocess-ssh/README.md) and [`sandbox-ssh`](../../../../packages/ssh/sandbox-ssh/README.md) implement the existing filesystem, process and sandbox services against that helper. No profile or bundle composes them, no CLI flag selects them, and the Web client contains no SSH reference at all.

The capability the product wants is different from what the runtime assumes. A user wants to add several servers in the browser GUI, type host, port, user and key themselves, let the Harness install its helper on the remote machine, and then create sessions that develop on a chosen server. The runtime instead takes exactly one deployment-owned OpenSSH alias whose user, key and known-host entry must already exist in `~/.ssh/config`, and the connection service states that no model argument selects these values.

Three structural gaps block that capability:

- The execution services are process-wide singletons. `ctx.fs`, `ctx.subprocess`, `ctx.sandbox` and `ctx.ssh` are provided once per process, so a second host can only exist as a second process, and the helper coordinates (`host`, `node`, `helper`, `helperHash`, `workspace`) are fixed at plugin load.
- Sessions and workspaces have no host dimension. [`SessionHeader`](../../../../packages/core/session/src/types.ts) carries only `cwd`, [`workspaceRecord`](../../../../packages/workspace/workspace/src/spec.ts) carries only path, title and session ids, and the workspace path canon calls host `realpath` directly, so a remote path cannot become a workspace at all.
- Credentials and provisioning do not exist. The credentials service models only `api-key` and `grant` records, the SSH host field accepts an alias-shaped string only, the connection hardcodes `BatchMode=yes` with strict host-key checking against the deployment's own `known_hosts`, and the helper has prose installation instructions with no tooling, no digest command and no upload path.

Web consumers additionally assume the host filesystem in ways that would fail outright once the execution services are remote, including host `mkdir` for a new session cwd, a command root taken from `process.cwd()`, a host-side directory picker, a host-only spill backend, and glob/grep resolving a local ripgrep binary as the remote `argv[0]`.

## Proposal

Build a GUI-managed remote-host capability on top of the shipped SSH runtime: a host registry owning one execution realm per registered host, credentials captured in the GUI and compiled into a DSH-controlled SSH configuration, automatic helper provisioning, and a host dimension on workspaces and sessions.

### Settled scope

| Decision | Value |
| --- | --- |
| Host topology | Many hosts in one Harness process, one execution realm per host |
| Credentials | Entered in the GUI: host, port, user, private key or password |
| Credential lifetime | Entered once and stored; later connections reuse them without prompting |
| Helper installation | Provisioned by the Harness, digest-verified before use |
| Availability | Enabled by default, with no feature flag |
| Session binding | Workspace and session records carry a host identity |
| Model surface | No SSH-specific tools; the existing capability services stay the only model-visible surface |

### Host registry and per-session realms

`ctx.remoteHosts` becomes the Service Definition for remote execution worlds. It owns host records, creates and retires one Cordis isolate realm per host, and resolves the execution services a session or workspace addresses. Each realm mounts [`dsh-ssh`](../../../../packages/ssh/ssh/README.md) with that host's coordinates plus the three paired providers, so `ctx.fs`, `ctx.subprocess` and `ctx.sandbox` resolve per realm instead of per process. Isolation is required rather than optional: a second `provide` of the same service key throws, while an isolated realm keeps a distinct store key.

Addressing splits by consumer. Agent-scoped consumers already run under a per-agent ctx and reach their realm directly. Host RPC consumers, which run outside any agent, resolve an instance through the registry by session or workspace identity, following the read-only addressing precedent of `serviceFor(agent, name)`. The local machine remains a built-in realm, so a composition with no registered host behaves exactly as today. The capability itself is enabled by default: installing the registry exposes remote-host management in the GUI without a feature flag.

### Per-host addressing

The [host registry](../../../../packages/ssh/host-registry/README.md) is the single place a host identity becomes an execution world, and every consumer resolves through one call: `ctx.remoteHosts.get(id).world.fs`. [Workspace file reads](../../../../packages/api/workspace-files/README.md), the [in-app directory browser](../../../../packages/host/directory-picker-browse/README.md) and the [workspace-controller branch read](../../../../packages/api/workspace-controller/README.md) all reuse that call, so a remote workspace is read in the world that owns it and a host with no open world refuses with a diagnostic naming the host instead of falling back to the Harness host's filesystem.

A consumer that reads a service it does not inject uses `ctx.get`, never the property proxy: the proxy is topology-sensitive and resolves only what the reading fiber declares. Two reads of this class are settled by that rule — `ctx.remoteHosts` in the registry's own Loader-mounted `apply`, where the service is provided by the child fiber that apply just mounted, and `ctx.remote.hosts` in the Client workspace `apply`, which builds its selected-world probe without injecting the optional namespace.

### Credentials and host-key trust

Credentials reuse the existing `grant` record with an opaque payload rather than adding a record kind; the host-credentials plugin owns that payload's format, its storage, and its removal. From stored credentials the plugin writes a DSH-controlled OpenSSH configuration file and the connection keeps addressing a host alias, so the connection's injection surface does not change. Credentials are captured once, when the host is created or edited, and persist across restarts; every later connection reuses the stored material instead of prompting.

Host-key trust is first-use confirmation: the first successful handshake shows the fingerprint in the GUI and records it on the host record, and a later mismatch fails the connection instead of being accepted. The generated configuration pins the key file, the port and the user, and never enables interactive TTY authentication. Private keys and passwords never reach argv, the process environment, or the session log; a temporary identity file is created with owner-only permissions and removed once the connection is established.

### Automatic helper provisioning

Provisioning is a first-class operation, not a documented manual step. It probes the remote Node executable and fails with an actionable message when the version is unsupported rather than installing a runtime. It uploads the bundled helper into a version-and-digest-named directory outside the workspace and outside writable temporary roots, as the runtime's deployment rules require. It computes the digest locally, records it as the host's expected helper hash, and leaves the remote helper to compute its own digest and be compared against it before the connection becomes ready. Re-provisioning is idempotent because the directory name carries the digest. Progress and failure surface in the GUI, and no remote path is ever treated as a host path.

### Persistence and identity changes

Remote host records live in the storage domain, matching the workspace precedent that facts spanning sessions do not belong in a session log. The workspace record gains a host identity and its path canon resolves through that host's filesystem rather than host `realpath`. Session creation and the session header gain the host identity beside `cwd`, whose persistence is a log-header format change and therefore follows the session-format version mechanism. Records written before this change read as the local host, so existing sessions and workspaces keep opening.

### GUI surfaces

Settings gain a remote-host section: list, add, edit, remove, test connection, and fingerprint confirmation. Workspace creation asks for a host first and then a remote directory, and the directory picker lists that host's filesystem through its realm instead of the Harness host's directories. Session chrome labels the host, and a lost SSH connection reports that operations are unrecoverable and are not replayed, matching the runtime's no-reconnect contract.

The host row's `open` state is a sampled fact, not a pushed one. `hosts.list` reports whether this process currently holds an open execution world per host; the followed stream announces durable record writes only, and a world that stopped after the last baseline writes no record, so nothing pushes that change. The settings section samples at mount, each browse or creation entry samples the selected world before addressing it, and workspace adoption samples again after the chooser returns, because the Host records a remote Workspace without checking that its world still exists. Whether a dropped world should also become a pushed event stays open for the disconnect work in phase 7.

### Workspace-creation host selection

The workspace-creation host choice crosses packages: [ui-remote-hosts](../../../../packages/client/ui-remote-hosts/README.md) writes it, and the workspace browser, picker and labels read it. It is owned on the object layer as `ctx.remoteHostSelection`, the Client service this package registers, and each consuming registration binds the bare snapshot source into its reserved `hooks` compartment so a component reads the value through a framework hook. A declarative store cannot carry this fact: a store handle stays private to the registration that declared it, so crossing packages would need the module-level singleton the Client rules forbid.

The workspace package reads the service through `ctx.get` and re-binds whenever its registration changes, so a composition that drops the ui-remote-hosts row browses and creates Workspaces on the Harness host instead of suspending on a service no fiber provides.

### Package topology

| Package | Surface | Role |
| --- | --- | --- |
| `packages/ssh/host-registry` | `ctx.remoteHosts` | Host records, realm lifecycle, identity addressing |
| `packages/ssh/host-credentials` | contributes to the registry | Credential payloads, generated SSH configuration, host-key pinning |
| `packages/ssh/helper-installer` | registry operation | Remote probing, upload, digest recording, idempotent upgrade |
| `packages/client/ui-remote-hosts` | Client plugin | Settings and selection UI |
| `packages/bundle/ssh-hosts` | Profile patch layer | Composes the runtime and registry over `dsh-base` |

### Delivery phases

1. Settle this proposal and write the persistence and scoping decisions it depends on.
2. Ship the host registry, one realm, and automatic helper provisioning, usable from a CLI profile.
3. Ship credentials, GUI host management, and test connection with fingerprint confirmation.
4. Add the host identity to workspace and session persistence, plus remote directory picking.
5. Move agent-scoped consumers onto the realm, including search, spill, language servers and terminals.
6. Address host RPC consumers per host: preview, change summary, and open/reveal degradation.
7. Finish disconnect presentation, documentation, snapshots, and a live end-to-end check against a disposable host.

### Presentation contracts the recorded Web lane pins

Two GUI presentation facts the recorded Web lane depends on are load-bearing. The workspace group label stays the direct child of the row's text slot, with the branch label as a sibling: a wrapper element between the label and the `treeitem` that carries `aria-expanded` breaks the lane's two-hop locator for that row. The directory browser's dialog heading keeps its title as the accessible name, and the host label rides in a sibling span with `aria-hidden="true"` referenced by `aria-describedby`, so the heading announces which execution world the listing came from without changing the name a locator matches.

## Alternatives considered

**One Harness process per host.** Running a separate profile per server needs no new architecture and is available today, but it cannot satisfy the product requirement that one GUI manage several servers, and it splits sessions, settings and credentials per process. It remains the supported fallback rather than the target.

**A host parameter on every capability call.** Passing a host into every filesystem, process and sandbox operation would change the capability seams and every one of their consumers, and would put transport vocabulary into model-facing and host-RPC surfaces that currently speak only in execution coordinates. Isolation keeps the existing Service Definitions intact.

**A new credential record kind for SSH material.** A dedicated record kind would be more self-describing, but the `grant` record already carries an opaque payload with owner-scoped lifecycle, and adding a kind widens a persistence format used by unrelated consumers before any second consumer proves the need.

**Moving the Harness to the remote host.** Launching `dsh` on the server moves model credentials, session storage and plugin state with the execution world; the repository already detects that launch mode to suppress a local browser handoff. It solves a different problem, and it cannot host several servers in one GUI.

## Acceptance criteria

1. Adding a host in the GUI with typed host, port, user and key or password reaches a ready connection with the helper provisioned and digest-verified, without editing any SSH configuration by hand.
2. A workspace and a session created against a remote directory run their filesystem, bash, search, terminal and language-server operations on that server.
3. Two sessions bound to two different hosts in one Harness process use independent filesystem and process worlds, and neither sees the other's files.
4. A changed host key fails the connection with the fingerprint difference reported, and is never accepted automatically.
5. A lost connection reports unrecoverable operations and replays nothing.
6. A composition registering no remote host behaves exactly as the current local composition.
7. A default composition exposes remote-host management and can register a host with no feature flag and no configuration edit.

## Risks

- This changes capability-seam topology from one process-wide implementation to one per host, touching service isolation, leaked-service rejection, and every host RPC consumer that currently reads `ctx.fs` directly.
- Session-header and workspace persistence change under a version mechanism, so old and new records must both keep opening.
- Digest verification proves that the installed helper matches the local artifact; it does not authenticate a hostile remote operating system.
- Automatic provisioning requires a writable remote home and a supported Node executable; hosts without Node need an explicit path from the user.
- Storing private keys and passwords introduces a new sensitive-data surface in credentials, including redaction in logs, snapshots and exported configuration.
- Each host costs one SSH connection and one helper process, so leases, cleanup and failure isolation must release per host rather than per process.
- Enabling the capability by default widens the default surface: credential storage and outbound SSH connections become reachable from the GUI without an opt-in step.
