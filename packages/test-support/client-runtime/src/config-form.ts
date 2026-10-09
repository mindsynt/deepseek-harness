/** Test doubles for settings transport. */
import { vi } from 'vitest'
import type {
  ConfigForm, ConfigFormSnapshot, SettingsDescribeFace, SettingsMirrorSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'

/** Handle over one stubbed scope: the scope, its write spy, and publication controls. */
export interface StubConfigForm<T> {
  /** The scope face handed to the service under test. */
  scope: ConfigForm<T>
  /** Spy behind `scope.set`; resolves immediately. */
  set: ReturnType<typeof vi.fn>
  /** Spy behind `scope.mutate`; resolves immediately. */
  mutate: ReturnType<typeof vi.fn<ConfigForm<T>['mutate']>>
  /** Spy behind `scope.unset`; resolves immediately. */
  unset: ReturnType<typeof vi.fn>
  /** @returns how many listeners are currently subscribed (disposal assertions). */
  listenerCount(): number
  /**
   * Replace part of the snapshot and notify subscribers, as a Host
   * acceptance would.
   * @param next - snapshot fields to replace.
   */
  publish(next: Partial<ConfigFormSnapshot<T>>): void
}

/**
 * Build an in-memory settings scope for service specs: starts in the loading
 * state, records writes, and lets the test publish Host acceptances.
 * @returns the stub handle.
 */
export function stubConfigForm<T>(): StubConfigForm<T> {
  let snapshot: ConfigFormSnapshot<T> = {
    status: 'loading', value: undefined, base: undefined, user: undefined,
    revision: undefined, writable: false,
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(() => Promise.resolve(true))
  const mutate = vi.fn<ConfigForm<T>['mutate']>(() => Promise.resolve(true))
  const unset = vi.fn(() => Promise.resolve(true))
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      mutate,
      set,
      unset,
    },
    set,
    mutate,
    unset,
    listenerCount: () => listeners.size,
    publish: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Handle over one stubbed settings describe mirror. */
export interface StubSettingsDescribe {
  /** The describe face handed to a config-form consumer. */
  face: SettingsDescribeFace
  /** Spy behind `face.ensure`; resolves immediately. */
  ensure: ReturnType<typeof vi.fn>
  /** Spy behind `face.acceptView`. */
  acceptView: ReturnType<typeof vi.fn>
  /** @returns how many listeners are currently subscribed (disposal assertions). */
  listenerCount(): number
  /**
   * Replace part of the mirror snapshot and notify subscribers, as a Host
   * answer would.
   * @param next - snapshot fields to replace.
   */
  publish(next: Partial<SettingsMirrorSnapshot>): void
}

/**
 * Build an idle settings describe mirror: no Host answer is held, so a consumer
 * reading `view` stays unloaded until a spec publishes one.
 * @returns the stub handle.
 */
export function stubSettingsDescribe(): StubSettingsDescribe {
  let snapshot: SettingsMirrorSnapshot = { status: 'idle', view: undefined, error: null }
  const listeners = new Set<() => void>()
  const ensure = vi.fn(async () => undefined)
  const acceptView = vi.fn()
  return {
    face: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      ensure,
      acceptView,
    },
    ensure,
    acceptView,
    listenerCount: () => listeners.size,
    publish: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}
