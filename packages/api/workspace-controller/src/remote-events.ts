/** Workspace Controller events available to a Remote Event assembly. */
type WorkspaceControllerRemoteEvent = 'workspace/branch-changed'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends
    Record<WorkspaceControllerRemoteEvent, true> {}
}

export {}
