/** Service Definition types for the SSH helper installer; no runtime code lives here. */

/** Stable handle to one artifact the installer may place on a host. */
export interface RemoteHelperArtifact {
  /** Compressed tar of the helper entry and every file it loads on the remote. */
  readonly archive: Uint8Array
  /** Entry path inside the archive, relative to the archive root. */
  readonly entry: string
  /** Lowercase SHA-256 of that entry file; the SSH connection verifies the same digest. */
  readonly digest: string
}

/** Remote command outcome; the runner never throws for a non-zero exit. */
export interface RemoteCommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** One remote command invocation's per-call inputs. */
export interface RemoteCommandRunOptions {
  /** Bytes written to the command's standard input. */
  readonly stdin?: Uint8Array
  /** Absolute local OpenSSH client configuration file passed as `ssh -F`. */
  readonly sshConfigFile?: string
}

/** Runs one command on a host over an existing OpenSSH configuration. */
export interface RemoteCommandRunner {
  /**
   * @param host - OpenSSH host alias.
   * @param command - command executed by the remote login shell.
   * @param options - optional standard input and per-call OpenSSH client configuration file.
   * @returns exit code, standard output and standard error.
   */
  run(host: string, command: string, options?: RemoteCommandRunOptions): Promise<RemoteCommandResult>
}

/** One provisioning request for a single host. */
export interface HelperInstallRequest {
  /** OpenSSH host alias to install on. */
  readonly host: string
  /** Absolute remote directory receiving the digest-named install directory. */
  readonly root: string
  /** Absolute remote default workspace recorded in the returned coordinates. */
  readonly workspace: string
  /** Artifact to place on the host. */
  readonly artifact: RemoteHelperArtifact
  /**
   * Absolute local OpenSSH client configuration file passed as `ssh -F`, for a
   * host alias that exists only in a DSH-generated configuration.
   */
  readonly sshConfigFile?: string
}

/** Verified remote coordinates the SSH connection needs. */
export interface HelperInstallation {
  /** Absolute remote Node executable path. */
  readonly node: string
  /** Absolute remote helper entry path. */
  readonly helper: string
  /** Lowercase SHA-256 of the installed entry. */
  readonly helperHash: string
  /** Absolute remote default workspace. */
  readonly workspace: string
}

/** Installs the SSH helper on remote hosts. */
export interface SshHelperInstaller {
  /**
   * Provision one host, or confirm an identical install already exists.
   * @param request - host, remote root, workspace and artifact.
   * @returns verified coordinates for the SSH connection config.
   */
  install(request: HelperInstallRequest): Promise<HelperInstallation>
}
