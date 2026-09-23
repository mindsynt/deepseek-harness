---
description: "Build-time assembly of the POSIX SSH helper dependency closure into one deterministic archive."
kind: "package-reference"
---

# @deepseek-ai/dsh-helper-artifact

English | [中文](README.zh.md)

## Summary

`dsh-helper-artifact` turns a built helper entry file into the artifact that [`dsh-helper-installer`](../helper-installer/README.md) uploads. It resolves every statically imported module reachable from the entry, copies the owning packages into a flat `node_modules` staging tree, and packs that tree into a deterministic gzip tar beside a manifest. It is a plain ESM library: no Cordis service, no configuration fields, and `node:` builtins only.

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

Run `pnpm run build:ssh-helper-artifact` after `pnpm run build:lib:host`. It collects `packages/ssh/ssh/lib/helper.js` by default and writes `dist/ssh-helper/dsh-ssh-helper-<digest>.tar.gz` beside `manifest.json`, which records `entry`, `digest`, `archive`, and `files`. `--entry`, `--out`, and `--staging` override the entry file, the output directory, and the staging directory.

The script loads the staged entry under plain Node with the staging directory as its working directory and requires the helper's exit code 127 and its no-arguments stderr message. That probe proves the closure loads without the repository `node_modules`; a closure that misses a reachable module exits 1 with an unresolved-module error and keeps the staging directory for inspection.

Programmatic callers use `collectHelperClosure({ entryFile, stagingDir })`, `packHelperArtifact(closure)`, and `writeHelperArtifact({ entryFile, outputDir, stagingDir? })`. `readTarEntryNames(archive)` is a test and self-check reader. A relative or missing entry file, an occupied staging directory, an unresolvable non-optional import, a relative import that leaves its package, an unsafe archive path, or a size or file-count limit fails with an error naming the file and the required change.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Every copied file lands at `node_modules/<package name>/<package-relative path>`. Import specifiers are read literally from `from "…"`, side-effect `import "…"`, dynamic `import("…")`, and `require("…")`; computed or template specifiers are ignored. A `@deepseek-ai/*` package, or any package whose manifest declares `"type": "module"`, contributes only files reachable from the entry; every other package is copied whole minus `node_modules`, `.git`, `*.map`, `*.ts`, `test/`, and `tests/`. Because `createRequire().resolve` applies the `require` condition, a dual-mode package such as `zod` also contributes the target its own `exports` field declares for the `import` condition. An unresolvable specifier that its importer declares under `optionalDependencies` is skipped, which is how koffi's absent per-platform packages are handled.

Each manifest the closure touches is copied, so package `exports` resolution works on the far side. Archives are deterministic: entries sort by path bytes and carry mode `0644`, mtime 0, uid/gid 0, and empty owner names, so identical input produces a byte-identical archive.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — helper coordinates and remote execution ownership.
- [Helper installer](../helper-installer/README.md) — the service that uploads the archive this package produces.

-----

<a id="model-experience"></a>
## Model Experience

### Build invocation

#### What the model sees

Nothing. This is a build-time library; it registers no tool, prompt section, or Session event, and the `dist/ssh-helper/dsh-ssh-helper-<digest>.tar.gz` it writes is consumed before any Session exists.

#### Token effect

This package adds no request-prefix text, tool schema, or result content.

#### KV Cache effect

This package contributes no request-prefix content, so it cannot change a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The closure follows statically analyzable imports only. A package whose runtime loads data files or computes module paths needs its whole directory copied, which the reachable-only rule does not fall back to for `"type": "module"` packages.
- The flat `node_modules` staging tree keeps one copy per package name, so two versions of the same dependency cannot coexist in one closure.
- The native `koffi` module is not included for Windows remotes; the helper supports POSIX remotes only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. This package owns no live state relation: its observable obligations are the copied closure, the archive layout, and the entry digest, and the package's behavior tests cover all three.

</details>