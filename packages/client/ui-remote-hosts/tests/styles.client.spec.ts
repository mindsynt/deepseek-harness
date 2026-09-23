/**
 * Remote hosts stylesheet contract, asserted against the CSS text on disk.
 *
 * The section paints in both themes, and a `--dsw-*` name the theme does not
 * declare fails silently: the browser takes the `var()` fallback, so the sheet
 * still renders and only one theme looks wrong. Checking the names against the
 * sheets that declare them turns that into a test failure.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The stylesheets this package ships, by module name. */
const SHEETS = ['AddHostDialog', 'HostRow', 'RemoteHostsSection', 'RemoveHostDialog']
const sheets = SHEETS.map(name =>
  readFileSync(fileURLToPath(new URL(`../src/client/${name}.module.css`, import.meta.url)), 'utf8'))

// Every theme sheet, not just the platform tokens: scrollbar and gradient
// variables live in siblings, and a gate reading one file would call their
// names undeclared.
const theme = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

describe('remote hosts stylesheets', () => {
  it('names only theme variables the token sheets define', () => {
    const named = sheets.flatMap(css => [...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(match => match[1]!))
    const undeclared = [...new Set(named)].filter(name => !theme.includes(`  ${name}:`))
    expect(named.length).toBeGreaterThan(0)
    expect(undeclared).toEqual([])
  })

  it('closes every block, so no rule is swallowed by the one above it', () => {
    for (const css of sheets) {
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
      expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
    }
  })

  it('carries no literal color', () => {
    for (const css of sheets) {
      expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    }
  })
})
