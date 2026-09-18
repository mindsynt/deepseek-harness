# Agent Note: Workspace branch labels

Status: implemented

English | [中文](2026-09-18-workspace-branch-labels.zh.md)

## Problem

The Workspace browser shows a Workspace's title and nothing about its checkout, so a developer running several checkouts of one project cannot tell which branch a row belongs to without leaving the GUI.

The checked-out branch is real state of the Workspace directory but not Workspace state: `git checkout` mutates no record the registry owns, and the durable `WorkspaceView` projection is rebuilt from `domain/changed` events. A branch stored in that record would be wrong from the first switch.

## Decision

`workspace/branches` is a separate unary Remote verb on the Host Workspace Controller. It reads each registered Workspace's `.git/HEAD` ([branches.ts](../../../../packages/api/workspace-controller/src/branches.ts)): `ref: refs/heads/<name>` yields the branch, a 40-hex HEAD yields its first eight characters, a `gitdir:` pointer file resolves the worktree or submodule metadata directory, and anything else — not a checkout, unreadable metadata, a symbolic ref outside `refs/heads` — yields no entry rather than an error.

The Client Workspace model keeps the labels in `WorkspaceSnapshot.branches`, a map separate from the Host projection. It re-reads them whenever the registered (id, path) set changes, and `IWorkspaces.refreshBranches()` lets a branch-showing surface re-read explicitly when it loads. The Workspace browser merges the map into the rows the tree groups by, and the project row renders the label after the title through its own dictionary entry (full-width parentheses in Chinese, half-width in English).

No subprocess runs: `.git/HEAD` is the checked-out ref's on-disk truth, while a `git` invocation would need the Subprocess capability, an executable and limits Config, and a fallback for compositions without them.

Reading is fail-soft by design. A branch is a label, so a filesystem fault, a dropped directory, or an unparsable HEAD must not surface as a Workspace error or remove the row.

## Alternatives considered

**Store the branch on the durable Workspace record.** Rejected: no DSH event fires on `git checkout`, so the stored value drifts until some other mutation rewrites the record, and both projection functions that build the Remote value are synchronous and driven by `domain/changed`.

**Run `git rev-parse --abbrev-ref HEAD` through the Subprocess capability.** Rejected: it makes this verb depend on a capability and Config the Workspace registry does not otherwise need, for a fact one file read already answers. Revisit when the label must report what `.git/HEAD` cannot, such as an in-progress rebase or upstream divergence.

**Compute the label in the browser.** Rejected: the browser reaches neither the filesystem nor a process.

**Poll or watch the checkout.** Rejected: no consumer needs sub-second freshness. The label is re-read when the Workspace set changes or a branch-showing surface loads.

## Consequences

- A branch is never durable: the session log, recorded snapshots, and the profile projection carry no branch value, and a checkout between two reads shows the newer label.
- The label can be stale between reads. After a `git checkout` the row updates on the next Workspace-set change or surface load, not immediately.
- `WorkspaceSnapshot` gained a required `branches` field and `IWorkspaces` a `refreshBranches()` method, so every test double and snapshot fixture implementing either carries the new member.