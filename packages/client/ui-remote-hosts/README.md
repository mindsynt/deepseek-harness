---
description: "Remote host management settings section for the dsh web client: the followed host list, add, remove, connection check, and refresh."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-remote-hosts

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-remote-hosts` adds a **Remote hosts** section in dsh web Settings. The section lists every host the deployment registered — label, id, address, workspace, and whether this process holds an open execution world for that host — and offers **Add host**, **Remove**, **Test connection**, and **Refresh**. Adding a host stores its login material, installs the remote helper, and opens its execution world as one Host transaction; the entered private key is never rendered or returned. It also carries the workspace-creation host: **Select** makes new Workspaces address that host's world, and **Use this machine** returns creation to the Harness host.

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

Open Settings and select **Remote hosts**. The section lists the registered hosts in id order and follows the Host's `hosts/follow` stream, so a host registered or removed elsewhere appears without a manual reload.

### Adding a host

The add dialog collects the registry id, a label, the SSH address, its port, the login user, an optional armored private key, the remote root directory and workspace, and the local helper-artifact manifest path. Submitting calls `hosts/add` — store the login material, read the manifest, install the helper, open the execution world — with the submit button disabled while that runs. A refusal keeps the dialog open with the Host's own diagnostic and the entered draft; a private key left blank omits the field, which leaves authentication to the environment's SSH agent and default keys.

### Removing a host

**Remove** opens a confirmation naming the host. Confirming calls `hosts/delete`, which closes the execution world and removes the persisted record and the stored login material. A refusal leaves the dialog open with its diagnostic and re-enables the button.

### Checking a connection

**Test connection** calls `hosts/testConnection` and reports the endpoint it reached plus every host-key line the DSH-controlled `known_hosts` records for it. One check runs at a time, so an older answer can never overwrite a newer one.

### Keeping the list fresh

The list follows the Host stream through the Gateway's reconnecting supervisor: each generation opens with a complete baseline and continues with ordered `upsert` and `remove` increments. A carrier loss reopens the generation without any action here; a generation the Host closes is terminal, so the last list stays visible with the reported diagnostic until **Refresh** reopens the stream and reads a fresh baseline. Opening the section re-samples every host's live execution-world state through `hosts/list`, because the stream announces durable record changes only: a world that stopped after the last baseline must not keep reading as open.

### Choosing the workspace host

**Select** on a host row makes that host the execution world new Workspaces address: the row shows the selected state, the line above the list names the chosen world, and **Use this machine** clears the choice back to the Harness host. A selection whose host leaves the registry — removed here or by another client — retires with it, because a later create would otherwise address a world nobody owns. A selected host that is still registered but no longer holds its execution world is called out beside the selection, and its row says what that costs: a world never reconnects, so the operations addressed to it are unrecoverable until the host is removed and added again. The browsing dialog names the selected world while it lists paths, and the picked path reaches `workspaces/create` together with that host.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one registration rule, one followed source, and two dialogs.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | The plugin body: dictionary registration, the host-list source, the inject face, and the `settings.section` registration. |
| [`src/client/hosts-source.ts`](src/client/hosts-source.ts) | The followed list projection, the on-demand world-state sample, and the settled add, remove, and connection-check calls. |
| [`src/client/selection.ts`](src/client/selection.ts) | `ctx.remoteHostSelection`: the workspace-creation host every consuming surface reads. |
| [`src/client/RemoteHostsSection.tsx`](src/client/RemoteHostsSection.tsx) | The section: list states, the toolbar, and the two dialogs. |
| [`src/client/HostRow.tsx`](src/client/HostRow.tsx) | One host row with its endpoint facts and the last check result. |
| [`src/client/AddHostDialog.tsx`](src/client/AddHostDialog.tsx) | The add form and its port check. |
| [`src/client/RemoveHostDialog.tsx`](src/client/RemoveHostDialog.tsx) | The removal confirmation. |
| [`src/client/locales.ts`](src/client/locales.ts) | The Chinese and English copy dictionaries. |

### Registration and live data

The section registers into `settings.section` through `ctx.slots.inject`, so it appears whenever ui-settings' declaration is on the ledger, regardless of apply order. The followed list is the section's one registrant-private reactive fact: it is a bare snapshot source published in the inject face's reserved `hooks` compartment and read in render code through the bound `useList` selector. Form drafts, in-flight flags, and per-row check results are component-local state, and the add, remove, connection-check, and selection calls are injected callbacks. The selection is not registrant-private — ui-workspace creates and browses through it — so the plugin owns it as the `ctx.remoteHostSelection` service (a bare snapshot source plus `select`) and the section binds that same source in its `hooks` compartment. The section never reads a context.

### Stream and call outcomes

`RemoteHostsSource` opens one supervised generation through `ctx.remote.$stream` and folds every frame into the published list. Carrier failures are the supervisor's to retry, while a generation that ends normally is terminal and is reported as a diagnostic beside the last list. Every Remote call is settled into an outcome — `{ ok: true }` or `{ ok: false, message }` — so a Host refusal or a carrier failure reaches the section as data rather than a rejected promise, and the copy is localized while the Host diagnostic stays verbatim.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings base, the host namespace this section drives, and the shared atoms it composes.

- [ui-settings](../ui-settings/README.md) — the settings domain base declaring `settings.section` and the settings scope.
- [ui-settings-general](../ui-settings-general/README.md) — the settings shell that renders every section.
- [ui-primitives](../ui-primitives/README.md) — the `Button`, `Input`, and `Modal` atoms this section composes.
- [hosts-controller](../../api/hosts-controller/README.md) — the `ctx.remote.hosts` namespace and its add transaction.
- [connection](../connection/README.md) — the carrier generations that pace the stream supervisor.
- [Slots reference](../../../docs/subsystems/slots.md) — registration, the props shares, and the hooks compartment.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this section can show and change; they are current package constraints.

- **A row has no port** — `hosts/list` and `hosts/follow` report the stored OpenSSH alias rather than the entered login, so a row shows the address alone and the port appears only in a connection check's result.
- **The open flag is sampled, not pushed** — the Host announces durable record changes only, so a world that stopped after its last baseline reaches the list when the section opens, when a generation re-baselines, or on **Refresh**.
- **A disconnected world is reported, not repaired** — the section states that the world's operations are unrecoverable and offers no reconnect action, matching the runtime's no-reconnect contract; a host must be removed and added again to hold a new world.
- **A closed generation stops the increments** — a generation the Host ends is terminal; the section keeps the last list and needs **Refresh** to reopen the stream, and its diagnostic text stays verbatim beside a localized label.
- **No host identity reaches a session** — the selected host reaches Workspace creation and its directory browsing, but a Session header still carries only `cwd`; binding a Session to a host is not part of this section.
- **Adding needs a prebuilt artifact manifest** — the form takes a local manifest path, and nothing here builds, uploads, or validates one.
- **No live sign of a dropped carrier** — a carrier loss is retried inside the Gateway supervisor, so the section shows nothing while it reconnects; only a generation the stream supervisor gives up on becomes visible.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The section's mutable facts are the list it projects from the Host stream and the workspace-creation selection it owns for ui-workspace; every Remote call is settled as data, and the registry, the credential store, and the add transaction are the owning packages' contracts.