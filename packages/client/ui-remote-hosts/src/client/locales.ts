/** Copy dictionaries for the Remote hosts settings section. */

/** Locale keys this section renders. */
export type RemoteHostsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'refresh'
  | 'addHost' | 'addTitle' | 'addDescription' | 'submit' | 'submitting'
  | 'fieldLabel' | 'fieldHost' | 'fieldPort' | 'fieldUser' | 'fieldPrivateKey'
  | 'privateKeyHint' | 'requiredMissing' | 'portInvalid'
  | 'cancel' | 'close'
  | 'empty' | 'loading' | 'listEnded' | 'listUnrecognizedFrame' | 'listCarrierFailed'
  | 'workspaceHost' | 'localLabel' | 'useLocal' | 'select' | 'selected' | 'selectAria'
  | 'hostField' | 'worldField' | 'worldOpen' | 'worldClosed' | 'worldClosedHint'
  | 'selectedWorldClosed'
  | 'testConnection' | 'testing' | 'testSucceeded' | 'testFailed' | 'fingerprints' | 'fingerprintsEmpty'
  | 'remove' | 'removeTitle' | 'removeDescription' | 'removing'

/** Chinese copy — the key-set source this pair mirrors. */
export const zh: Record<RemoteHostsLocaleKey, string> = {
  nav: '远程主机',
  title: '远程主机',
  intro: '管理本机可通过 SSH 访问的远程主机。添加时会保存登录材料并打开隔离的执行世界。',
  refresh: '刷新',
  addHost: '添加主机',
  addTitle: '添加远程主机',
  addDescription: '填写 SSH 登录信息。私钥只写入凭证存储，不会显示或回传。',
  submit: '添加',
  submitting: '正在添加…',
  fieldLabel: '名称',
  fieldHost: '主机地址',
  fieldPort: '端口',
  fieldUser: '登录用户',
  fieldPrivateKey: '私钥',
  privateKeyHint: '留空则使用环境中的 SSH agent 与默认密钥。',
  requiredMissing: '请填写名称、主机地址、端口与登录用户。',
  portInvalid: '端口必须是 1 到 65535 之间的整数。',
  cancel: '取消',
  close: '关闭',
  empty: '当前没有已注册的远程主机。',
  loading: '正在读取主机列表…',
  listEnded: '主机列表已断开，显示的是最后一次收到的内容。',
  listUnrecognizedFrame: '主机列表返回了本客户端无法识别的帧，显示的是最后一次收到的内容。',
  listCarrierFailed: '主机列表连接已断开，显示的是最后一次收到的内容。',
  workspaceHost: '新建工作区的主机',
  localLabel: '本机',
  useLocal: '改用本机',
  select: '选择',
  selected: '已选中',
  selectAria: '将“{name}”设为新建工作区的主机',
  hostField: '地址',
  worldField: '执行世界',
  worldOpen: '执行世界已打开',
  worldClosed: '执行世界已断开',
  worldClosedHint: '该主机的执行世界已断开，依赖它的操作不可恢复。需要移除后重新添加该主机，才能重新打开执行世界。',
  selectedWorldClosed: '新建工作区所选主机的执行世界已断开，相关操作不可恢复。请移除后重新添加该主机，或改用本机。',
  testConnection: '测试连接',
  testing: '正在测试…',
  testSucceeded: '连接成功：{endpoint}',
  testFailed: '连接失败。',
  fingerprints: '已记录的 host key',
  fingerprintsEmpty: '未记录 host key。',
  remove: '移除',
  removeTitle: '移除 {label}？',
  removeDescription: '移除主机会关闭它的执行世界，并删除持久记录和已存登录材料。',
  removing: '正在移除…',
}

/** English copy, one entry per Chinese key. */
export const en: Record<RemoteHostsLocaleKey, string> = {
  nav: 'Remote hosts',
  title: 'Remote hosts',
  intro: 'Manage remote hosts this machine reaches over SSH. Adding one stores its login material and opens an isolated execution world.',
  refresh: 'Refresh',
  addHost: 'Add host',
  addTitle: 'Add a remote host',
  addDescription: 'Enter the SSH login. The private key is written to the credential store only; it is never shown or returned.',
  submit: 'Add',
  submitting: 'Adding…',
  fieldLabel: 'Name',
  fieldHost: 'Address',
  fieldPort: 'Port',
  fieldUser: 'Login user',
  fieldPrivateKey: 'Private key',
  privateKeyHint: 'Leave blank to use the environment SSH agent and default keys.',
  requiredMissing: 'Enter the name, the address, the port and the login user.',
  portInvalid: 'The port must be an integer between 1 and 65535.',
  cancel: 'Cancel',
  close: 'Close',
  empty: 'No remote host is registered.',
  loading: 'Reading the host list…',
  listEnded: 'The host list stream ended; this is the last list received.',
  listUnrecognizedFrame: 'The host list stream sent a frame this client does not recognize; this is the last list received.',
  listCarrierFailed: 'The host list connection was lost; this is the last list received.',
  workspaceHost: 'Host for new workspaces',
  localLabel: 'This machine',
  useLocal: 'Use this machine',
  select: 'Select',
  selected: 'Selected',
  selectAria: 'Use “{name}” for new workspaces',
  hostField: 'Address',
  worldField: 'Execution world',
  worldOpen: 'Execution world open',
  worldClosed: 'Execution world disconnected',
  worldClosedHint: 'This host’s execution world is disconnected, so operations that depended on it are unrecoverable. Remove and re-add the host to open a new execution world.',
  selectedWorldClosed: 'The execution world of the host selected for new workspaces is disconnected, so operations against it are unrecoverable. Remove and re-add that host, or use this machine.',
  testConnection: 'Test connection',
  testing: 'Testing…',
  testSucceeded: 'Connection succeeded: {endpoint}',
  testFailed: 'Connection failed.',
  fingerprints: 'Recorded host keys',
  fingerprintsEmpty: 'No host key is recorded.',
  remove: 'Remove',
  removeTitle: 'Remove {label}?',
  removeDescription: 'Removing a host closes its execution world and deletes its persisted record and stored login material.',
  removing: 'Removing…',
}
