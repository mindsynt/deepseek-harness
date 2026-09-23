---
description: "Remote SSH helper installation over the local OpenSSH client, before any helper RPC can run."
kind: "package-reference"
---

# @deepseek-ai/dsh-helper-installer

English | [中文](README.zh.md)

## Summary

`dsh-helper-installer` provides `ctx.sshHelperInstaller`. It places a caller-supplied helper archive on a remote host through the local OpenSSH client, verifies the installed entry digest there, and returns the Node executable, helper path, digest and workspace that [`dsh-ssh`](../ssh/README.md) requires. It runs before the helper exists, so it never uses helper RPC.

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

Mount the plugin beside the connection it provisions and call `install()` once per host with the OpenSSH host alias, an absolute remote root, the default workspace and the artifact. The returned coordinates are the connection config fields `node`, `helper`, `helperHash` and `workspace`. A later call for the same digest confirms the installed copy and uploads nothing.

Two config fields exist. `installTimeoutMs` bounds one remote command (default 30,000 ms), and `sshConfigFile` adds `ssh -F <file>` for hosts that the default OpenSSH client configuration does not describe. A request may carry its own `sshConfigFile` instead — the generated client configuration of a login-provisioned identity — which overrides the plugin value for that install.

The remote Node executable must satisfy `^22.19 || >=24`, exported as `SSH_HELPER_NODE_ENGINE`. A missing, relative or too-old Node fails before anything is uploaded, with an error naming the host and what to change there.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One install runs five single-line remote commands over `ssh` with `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ForwardAgent=no` and `ClearAllForwardings=yes`: `command -v node`, `node --version`, the digest-named entry test paired with `sha256sum`, `mkdir -p` with `tar -xzf -` reading the archive from standard input, and a final `sha256sum`. Every interpolated remote path is POSIX single-quoted.

The installer drives each command through `RemoteCommandRunner.run(host, command, options)`. `options.stdin` carries the archive bytes for the upload, and a per-call `options.sshConfigFile` overrides the plugin config; whichever value applies becomes the leading `ssh` argument `-F <file>`.

The installed entry digest must equal the artifact digest. A mismatch, or a failed upload, reports the remote install as unconfirmed rather than claiming success.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — execution coordinates and transport ownership.
- [SSH connection](../ssh/README.md) — the connection the returned coordinates configure.

-----

<a id="model-experience"></a>
## Model Experience

### Installer calls

#### What the model sees

Nothing. `ctx.sshHelperInstaller.install()` is called by deployment code before a connection or Session exists; it registers no tool, prompt section, or Session event.

#### Token effect

None. The installer adds no request-prefix text, tool schema, or result content.

#### KV Cache effect

None. The installer contributes no request-prefix content, so it cannot change a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The archived closure is collected from statically analyzable imports, so a package whose runtime files are reached only through computed dynamic imports needs the whole-directory fallback its manifest selects.
- The helper cannot ship as one bundled file. A rolldown build resolves workspace imports to `src`, which carries decorator syntax, and the real dependency closure is large, so the archive carries the helper's loaded files as they are installed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. The installer owns no live state relation; its observable obligations are the digest comparison and the returned coordinates, and both are covered by the package's behavior tests.

</details>
