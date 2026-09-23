---
description: "One stored SSH login per remote host, and the DSH-controlled OpenSSH configuration, identity and known_hosts it materializes."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-credentials

English | [中文](README.zh.md)

## Summary

`dsh-host-credentials` provides `ctx.sshHostCredentials`. It stores one remote host's entered login material — host, port, user and an optional armored private key — in the credential seam, and materializes a DSH-controlled OpenSSH configuration, private key file and `known_hosts` under the state directory (`<DSH home>/ssh-hosts` by default). Every later session reuses the stored material instead of prompting, and every command addresses a generated alias rather than the deployment's own `~/.ssh/config`.

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

Mount the plugin directly; `stateDir` defaults to `<DSH home>/ssh-hosts`, and an explicit value must be a non-empty absolute local directory. Call `store(id, login)` once per host to keep its login material across sessions, or call `materialize(login)` directly for a one-off connection. `load(id)` returns the stored material while none is stored as `undefined`.

| Field | Default | Meaning |
|---|---|---|
| `stateDir` | `<DSH home>/ssh-hosts` | Absolute local directory holding one generated directory per host; `$DSH_HOME` overrides the harness home, which is otherwise `~/.dsh` |
| `scanTimeoutMs` | `10000` | Deadline for one `ssh-keyscan` invocation, from 1 through 2,147,483,647 ms |

`materialize(login)` returns the identity a connection addresses: the `alias`, the absolute `configPath`, the generated `directory`, the `knownHostsPath`, and a `dispose()` that removes the whole directory. The alias is deterministic, so the same login always yields the same directory; materializing again replaces that directory and discards files written into it.

`pinHostKey(identity, line)` appends the host key line a human confirmed, and `forget(id)` removes both the stored record and the files materialized for that id.

`trustFirstUse(identity, endpoint)` completes trust on first use. It scans the real host and port through `ssh-keyscan`, fails loudly on malformed scan output, and records every published key the identity's `known_hosts` does not already carry; a repeat call for one endpoint adds nothing and leaves existing lines untouched. A scan that fails, exceeds `scanTimeoutMs`, or publishes no key refuses instead of connecting.

The consuming connection runs with `StrictHostKeyChecking=yes`, so no key is accepted while it connects: `trustFirstUse` is the only place a first key becomes trusted.

The generated configuration sets `IdentitiesOnly yes`, `BatchMode yes`, `ForwardAgent no` and `ClearAllForwardings yes`. With a private key it points `IdentityFile` at the materialized file; without one, the environment's agent and default keys authenticate. Host keys are checked against the DSH-owned `known_hosts` under `GlobalKnownHostsFile /dev/null`; the file's own `StrictHostKeyChecking accept-new` is overridden by the consuming connection's `-o StrictHostKeyChecking=yes`, so the connection itself records nothing and a mismatch fails it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The stored material is one `grant` credential record at `credentialKey('ssh-host-credentials', id)` whose payload is `{ version: 1, login: { host, port, user, privateKey? } }`; this package owns that payload format and never writes key text into a log or a diagnostic. The alias is `dsh-` plus the first 16 lowercase hex digits of `sha256(host + "\0" + port + "\0" + user)`.

Each materialization replaces `<stateDir>/<alias>`, creating a 0700 directory and writing `config`, an optional `identity` and an empty `known_hosts`, each at 0600 with an explicit chmod after the write. Validation rejects a malformed host, port, user, id or private key before any file or record changes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — shared execution coordinates and transport ownership.
- [Host registry](../host-registry/README.md) — the per-host execution realm a connection runs in.
- [SSH connection](../ssh/README.md) — how the returned alias and configuration reach a host.

-----

<a id="model-experience"></a>
## Model Experience

### Stored SSH logins

#### What the model sees

Nothing. `ctx.sshHostCredentials` is called by host-management code outside every model request; it registers no tool, prompt section, or Session event, and neither the login material nor the generated files enter model context.

#### Token effect

None. The package adds no request-prefix text, tool schema, or result content, and the private key it stores is never rendered into a request.

#### KV Cache effect

None. The package contributes no request-prefix content, so it cannot invalidate a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- GUI host management and the GUI presentation or confirmation of a scanned host key are not implemented; a scan result is recorded on disk, and a caller that confirms a key by other means supplies that line to `pinHostKey`.
- `GlobalKnownHostsFile /dev/null` means the deployment's own `known_hosts` files never participate in verification.
- Password authentication is not implemented; only a stored private key or the environment's agent and default keys authenticate.
- No real remote end-to-end test exists; the package is covered by local filesystem and credential-record tests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. The package owns one observable relation — the stored record and the files materialized from it — and its behavior tests cover both; there is no independent observation that could diverge from it.

</details>
