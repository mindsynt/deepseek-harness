/**
 * Discrete reasoning-effort slider for the composer picker's effort pane.
 *
 * One stop per level the Host declares, left (faster) to right (smarter).
 * Pointer drags follow the pointer continuously and settle on the nearest
 * stop when released; arrow keys move stop by stop. The owning menu commits
 * through the same selection path a row used, so nothing is written while the
 * user is still exploring.
 */

import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import type { ModelReasoningEffort } from '@deepseek-ai/dsh-api-remotes/client'
import css from './EffortSlider.module.css'

/** Props of {@link EffortSlider}. */
export interface EffortSliderProps {
  /** Declared levels, in escalation order; the first is the faster end. */
  levels: readonly ModelReasoningEffort[]
  /** Nearest stop the slider shows, clamped by the owner. */
  index: number
  /** Continuous stop position (0..levels.length-1) the handle follows. */
  position: number
  /** Whether a selection is in flight. */
  disabled: boolean
  /** Accessible name, shared with the menu's effort cell. */
  ariaLabel: string
  /** Caption under the faster (left) end. */
  fasterLabel: string
  /** Caption under the smarter (right) end. */
  smarterLabel: string
  /** Move the preview without committing; a float while dragging. */
  onPreview: (position: number) => void
  /** Commit the nearest stop; `source` separates a pointer release from a key. */
  onCommit: (index: number, source: 'pointer' | 'key') => void
  /** Leave the pane with the current value uncommitted. */
  onExit: () => void
}

/** Continuous stop position for a pointer x, clamped to the rail. */
function positionAt(rail: HTMLElement | null, clientX: number, last: number): number {
  const rect = rail?.getBoundingClientRect()
  if (rect === undefined || rect.width === 0 || last < 1) return 0
  const ratio = (clientX - rect.left) / rect.width
  return Math.min(last, Math.max(0, ratio * last))
}

/** The fraction of the rail one position covers. */
function offsetOf(position: number, last: number): string {
  return `${last < 1 ? 0 : Math.round((position / last) * 1000) / 10}%`
}

/**
 * Render the effort slider.
 * @param props - levels, shown position, copy, and the owner's verbs.
 * @returns the track, its stops, and the two end captions.
 */
export function EffortSlider({
  levels, index, position, disabled, ariaLabel, fasterLabel, smarterLabel, onPreview, onCommit, onExit,
}: EffortSliderProps): ReactNode {
  // Stops are laid out on the rail, which is inset by the handle radius so
  // the handle's center can reach either end without the card clipping it.
  const railRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  // A held pointer follows the pointer directly; the settle transition is for
  // keyboard steps and committed changes only.
  const [followPointer, setFollowPointer] = useState(false)
  const last = levels.length - 1
  const current = levels[index]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const move = (next: number): void => {
      event.preventDefault()
      event.stopPropagation()
      onPreview(Math.min(last, Math.max(0, next)))
    }
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        move(index - 1)
        return
      case 'ArrowRight':
      case 'ArrowDown':
        move(index + 1)
        return
      case 'Home':
        move(0)
        return
      case 'End':
        move(last)
        return
      case 'Enter': {
        event.preventDefault()
        event.stopPropagation()
        onCommit(index, 'key')
        return
      }
      case 'Tab': {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) onExit()
        else onCommit(index, 'key')
        return
      }
      case 'Escape': {
        event.preventDefault()
        event.stopPropagation()
        onExit()
      }
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled) return
    dragging.current = true
    setFollowPointer(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    onPreview(positionAt(railRef.current, event.clientX, last))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled || !dragging.current) return
    onPreview(positionAt(railRef.current, event.clientX, last))
  }
  const releaseCapture = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled || !dragging.current) return
    dragging.current = false
    setFollowPointer(false)
    releaseCapture(event)
    onCommit(Math.round(positionAt(railRef.current, event.clientX, last)), 'pointer')
  }
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    setFollowPointer(false)
    releaseCapture(event)
  }

  return (
    <div className={css['effortSlider']}>
      <div className={css['effortCaptions']}>
        <span>{fasterLabel}</span>
        <span>{smarterLabel}</span>
      </div>
      <div
        className={clsx(
          css['effortTrack'],
          followPointer && css['effortTrackFollowingPointer'],
          disabled && css['effortTrackDisabled'],
        )}
        role="slider"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, last)}
        aria-valuenow={index}
        aria-valuetext={current?.name ?? ''}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div ref={railRef} className={css['effortRail']}>
          <span className={css['effortFill']} style={{ width: offsetOf(position, last) }} />
          {/* The shown stop is marked by the handle; drawing its dot too would
              stack two circles on one point. */}
          {levels.map((level, at) => at === index ? null : (
            <span
              key={level.id}
              className={clsx(css['effortDot'], at < index && css['effortDotReached'])}
              style={{ left: offsetOf(at, last) }}
            />
          ))}
          <span className={css['effortHandle']} style={{ left: offsetOf(position, last) }} />
        </div>
      </div>
    </div>
  )
}
