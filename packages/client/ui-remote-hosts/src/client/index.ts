/**
 * Remote hosts settings plugin, browser half. It contributes one settings
 * section over the generated `hosts` Remote namespace: the followed host list,
 * the add, remove, and connection-check actions, and this package's own copy.
 * It also owns `ctx.remoteHostSelection`, the workspace-creation host
 * ui-workspace reads when it lists a directory and creates a Workspace. The
 * plugin registers no model-visible input and writes no session event. Export
 * discipline: packages/client/AGENTS.md.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the generated `hosts` namespace
// vocabulary into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteHostsSource } from './hosts-source.ts'
import { RemoteHostsSection } from './RemoteHostsSection.tsx'
import type { RemoteHostsSectionInjected } from './RemoteHostsSection.tsx'
import { RemoteHostSelectionService } from './selection.ts'
import { en, zh, type RemoteHostsLocaleKey } from './locales.ts'

export type { RemoteHostsSectionInjected, RemoteHostsSectionProps } from './RemoteHostsSection.tsx'
export type { AddHostDialogProps } from './AddHostDialog.tsx'
export type { HostRowProps } from './HostRow.tsx'
export type { RemoveHostDialogProps } from './RemoveHostDialog.tsx'
export type { RemoteHostsLocaleKey } from './locales.ts'
export type { RemoteHostSelection, RemoteHostSelectionState } from './selection.ts'
export type {
  RemoteHostActionOutcome, RemoteHostRow, RemoteHostTestOutcome, RemoteHostsListState,
} from './hosts-source.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Remote hosts section copy. */
    'settings.remoteHosts': RemoteHostsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.remoteHosts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on that slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.hosts']

/**
 * Register the Remote hosts section once the `settings.section` declaration is
 * on the ledger, and follow the host list for as long as this plugin is mounted.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-remote-hosts: copy dictionaries')

  const source = new RemoteHostsSource(ctx.remote)
  ctx.effect(() => () => { source.dispose() }, 'ui-remote-hosts: host list stream')

  // The selection crosses packages (ui-workspace creates and browses through
  // it), so it registers as a service rather than as this entry's store.
  const selection = new RemoteHostSelectionService(ctx)

  // Copy freshness is framework-owned: the component reads the standard `t`
  // seat, and the nav label is a thunk the owner resolves per render.
  const t = ctx.locale.bind(NS)
  const injected = (): RemoteHostsSectionInjected => ({
    hooks: { list: source.store, selectedHost: selection.source },
    refresh: () => { source.refresh() },
    sampleWorlds: () => { void source.sampleWorlds() },
    selectHost: (value) => { selection.select(value) },
    addHost: request => source.addHost(request),
    removeHost: id => source.removeHost(id),
    testConnection: id => source.testConnection(id),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-hosts',
    order: 22,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, RemoteHostsSection))
}
