// Web e2e scenario: a hand-declared model's `reasoningEfforts` reaches the
// composer's effort pane — the levels a settings profile declares are exactly
// what the picker offers, and picking one records it with the Agent default.
// Zero model calls: declaring, describing, and switching are settings/llm
// traffic only, so there is no fixture and a stray stream would fail loud.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Starts the shipped default on this scenario's declared reasoning model. */
const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/declared-reasoning', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/declared-reasoning/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: declared reasoning efforts reach the composer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // The whole reasoning offer is the profile: key = selectable level, value
    // = the wire spelling dispatch would send (`max: ultra` renames; the
    // valueless `off` means "supported, send nothing"). The route sets no
    // deployment default, so the pane leads with the provider-default entry.
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{
            id: 'acme-think',
            name: 'Acme Think',
            reasoningEfforts: { off: null, high: 'high', max: 'ultra' },
          }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers exactly the declared levels and records the picked one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: /推理等级/ }).click()

    // Declared levels, nothing else: the slider offers Off/High/Max — minimal,
    // low, medium, and xhigh were not declared and must not be offered. The
    // route configures no `reasoning`, so the provider-default row is present
    // and checked; the slider itself parks on the first declared level.
    const slider = page.getByRole('slider', { name: '推理等级' })
    const providerDefault = page.getByRole('menuitemradio', { name: 'Default' })
    await expect.poll(() => providerDefault.getAttribute('aria-checked'), { timeout: 10_000 })
      .toBe('true')
    await expect.poll(() => slider.getAttribute('aria-valuetext'), { timeout: 10_000 }).toBe('Off')
    await expect.poll(() => page.getByRole('menuitemradio').count(), { timeout: 10_000 }).toBe(1)
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    // Keyboard: the clicked cell unmounts with its pane, so the drilled pane's
    // slider takes the focus it left behind. ←/→ preview the stops from there
    // and Tab settles the previewed one exactly as Enter would.
    await expect.poll(
      () => slider.evaluate(element => element === document.activeElement),
      { timeout: 10_000 },
    ).toBe(true)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => slider.getAttribute('aria-valuetext'), { timeout: 10_000 }).toBe('High')

    // Settling with Tab is the same gesture that saves the default selection, so
    // the effort lands in the Agent default Settings section beside provider/model.
    await page.keyboard.press('Tab')
    await expect.poll(() => page.getByRole('menu').count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: high')
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择模型，当前 Acme Think，推理等级 High')

    // Reopening the drilled pane parks the slider on the level in use, and
    // Shift+Tab walks back out like Escape: to the drilled cell, then closed.
    await trigger.click()
    await page.getByRole('menuitem', { name: /推理等级/ }).click()
    const reopened = page.getByRole('slider', { name: '推理等级' })
    await expect.poll(() => reopened.getAttribute('aria-valuetext'), { timeout: 10_000 }).toBe('High')
    await expect.poll(
      () => reopened.evaluate(element => element === document.activeElement),
      { timeout: 10_000 },
    ).toBe(true)
    await page.keyboard.press('Shift+Tab')
    await expect.poll(
      () => page.getByRole('menuitem', { name: /推理等级/ })
        .evaluate(element => element === document.activeElement),
      { timeout: 10_000 },
    ).toBe(true)
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => page.getByRole('menu').count(), { timeout: 10_000 }).toBe(0)

    // Pointer: a release on another stop commits through the same path, while
    // a release on the stop already in use leaves the card open so a stray
    // click cannot dismiss it.
    await trigger.click()
    await page.getByRole('menuitem', { name: /推理等级/ }).click()
    const track = page.getByRole('slider', { name: '推理等级' })
    const box = await track.boundingBox()
    if (box === null) throw new Error('effort slider is not visible')
    const right = box.x + box.width - 1
    const middle = box.y + box.height / 2
    await page.mouse.click(right, middle)
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择模型，当前 Acme Think，推理等级 Max')
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: max')

    await trigger.click()
    await page.getByRole('menuitem', { name: /推理等级/ }).click()
    const reopenedTrack = page.getByRole('slider', { name: '推理等级' })
    const reopenedBox = await reopenedTrack.boundingBox()
    if (reopenedBox === null) throw new Error('effort slider is not visible')
    await page.mouse.click(reopenedBox.x + reopenedBox.width - 1, reopenedBox.y + reopenedBox.height / 2)
    await expect.poll(() => page.getByRole('menu').count(), { timeout: 10_000 }).toBe(1)
    // Clicking a non-focusable part of the pane (the caption) keeps the card
    // open: the focus handoff to the body must not read as a departure.
    await page.getByText('更快', { exact: true }).click()
    await expect.poll(() => page.getByRole('menu').count(), { timeout: 10_000 }).toBe(1)
    // Escape backs out of the drilled pane first, then closes the card.
    await page.keyboard.press('Escape')
    await expect.poll(
      () => page.getByRole('menuitem', { name: /推理等级/ })
        .evaluate(element => element === document.activeElement),
      { timeout: 10_000 },
    ).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('menu').count(), { timeout: 10_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
