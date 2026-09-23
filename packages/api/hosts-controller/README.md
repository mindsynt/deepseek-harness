---
description: "Host Remote owner that lists, adds, removes and connection-checks GUI-managed SSH hosts, and streams host-record changes to the browser."
kind: "package-reference"
---
# Hosts Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-hosts-controller` exposes the generated `ctx.remote.hosts` namespace, so a browser page can list the servers a deployment registered, add one from an entered host, port, user and key, remove one, and check that a stored login still reaches its endpoint. Adding a host stores that login, installs the helper from a local artifact manifest and opens the host's execution world as one transaction; a failure removes every partial trace and reports what happened. Listing is read-only, and no method here returns a stored secret.

## Table of Contents
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package beside the remote-host registry and the host-credentials store: it injects both, so its row activates only after those rows are mounted, and it owns no state of its own.

### What the Remote namespace serves

| Endpoint | What it does |
|---|---|
| `hosts/list` | Returns every persisted host record in id order, each with whether this process currently holds an open execution world for it. |
| `hosts/add` | Stores entered login material, installs the helper from the named local artifact manifest, and opens the host. |
| `hosts/delete` | Removes one host's execution world, persisted record and stored login; repeating it for an id that is already gone resolves. The wire method is `delete` because the Gateway Client reserves `remove` on its namespace service. |
| `hosts/testConnection` | Trusts the host keys the endpoint publishes now and returns the lines the DSH-controlled `known_hosts` records for it. |
| `hosts/follow` | Streams one complete baseline, then ordered `upsert` and `remove` increments, for a reconnect-safe host list. |

Expected refusals carry stable codes: `hosts/unknown-host` when no stored login exists, `hosts/already-exists` when a record or an open world already uses the id, `hosts/add-failed` when adding failed, and `hosts/no-login-identity` when an open world was opened from a configured artifact rather than stored login material.

### Add is one transaction

`hosts/add` refuses an id that a record or an open execution world already uses, so a failed add can never remove an existing host. It then stores the login, reads the artifact manifest and its archive, provisions the helper and opens the realm. When any step fails, it removes the stored login, the record and any realm the registry opened, and the thrown `hosts/add-failed` names both the cause and the cleanup outcome; a cleanup that also fails is reported instead of being hidden.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is a Remote owner over two already-shipped services: `ctx.remoteHosts` owns host records, one isolated execution realm per host, and helper provisioning, while `ctx.sshHostCredentials` owns the login material and the controlled OpenSSH identity generated from it. This package composes them and adds no SSH behavior; `hosts/add` is the only method that writes, and it delegates every write to those two services.

A connection check materializes a throwaway identity for a host that has no open world, trusts the endpoint's published keys through it, reads the resulting `known_hosts` lines back, and removes the identity again. A host whose world is already open is checked through the identity that world already addresses, because the open handle owns those files and closing it is the one removal.

The follow stream installs its `domain/changed` listener before it reads the baseline, so a record committed between the two is not lost. Only the storage domain's own committed change carries an increment; the open flag is read from the live registry at each baseline and upsert.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `HostsController` service: the five Remote operations, the add transaction and the borrowed-identity rule. |
| [`src/feed.ts`](src/feed.ts) | Host-record projection and the reconnect-safe baseline-plus-increments stream. |
| [`src/types.ts`](src/types.ts) | Browser-safe request, result and stream vocabulary, plus the declared Remote failure codes. |
| [`tests/hosts-controller.spec.ts`](tests/hosts-controller.spec.ts) | The Remote surface over the real registry and credentials store, with a stub installer and composition. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration
- [SSH subsystem](../../../docs/subsystems/ssh.md) — the connection, helper and provider composition behind each host.
- [Host registry](../../ssh/host-registry/README.md) — realm lifecycle, record persistence and provisioning semantics.
- [Host credentials](../../ssh/host-credentials/README.md) — the stored logins and generated identities this package composes.
- [SSH hosts bundle](../../bundle/ssh-hosts/README.md) — the profile layer that inserts this package's row.
- [Capability seams](../../../docs/capability-seams.md) — where `ctx.hostsController` sits among the other services.

-----

<a id="model-experience"></a>
## Model Experience

None, as host management is browser and Host control state and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; listing, adding or removing a host does not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- Only durable record changes are streamed; an execution world that opens or closes reaches a browser list at the next record change or on reconnect.
- Adding a host requires a local artifact manifest built beforehand, and no Remote operation builds or uploads one.
- A stored login cannot be edited in place: changing it means removing the host and adding it again.
- No client assembly mounts this contribution yet, so no browser page renders the namespace today.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The registry owns record persistence and realm lifecycle, and the credentials store owns the generated identity; every stream generation is a full projection.
