---
description: "The native SSH provider family: one OpenSSH connection plus the SFTP filesystem and SSH-exec subprocess providers it serves."
kind: "package-group"
---

# ssh/ — POSIX remote execution providers

English | [中文](README.zh.md)

## Summary

This family runs files and processes on one POSIX SSH host while the Harness stays local. A native OpenSSH connection over ssh2 owns the SFTP file operations and the SSH exec channels, so the remote host needs only an OpenSSH server — no helper daemon and no Node runtime there. Use it in headless or custom profiles whose consumers honor provider-owned paths.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Responsibility | Service |
|---|---|---|
| `ssh-native` | Native OpenSSH connection: SFTP file operations, SSH-exec process channels and PTY sessions | `ctx.sshNative` |
| `fs-sftp` | Remote filesystem provider over the SFTP subsystem | `ctx.fs` |
| `subprocess-ssh-exec` | Remote subprocess provider over SSH exec channels | `ctx.subprocess` |
| [`host-registry`](host-registry/README.md) | One isolated execution realm per registered SSH host | `ctx.remoteHosts` |
| [`host-credentials`](host-credentials/README.md) | Stored SSH login material for registered remote hosts | `ctx.sshHostCredentials` |

<a id="related-documentation"></a>
## Related documentation

- [SSH subsystem](../../docs/subsystems/ssh.md) — shared execution coordinates and transport ownership.
- [POSIX SSH decision](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) — alternatives, consequences and verification requirements.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Remote capability implementations retain the shared asynchronous terminal and cancellation interfaces. Local path access must never be inferred from a remote path string.

</details>
