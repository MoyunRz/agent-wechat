// Mount/unmount helper for the popovers and dialogs that the Vue component
// wrapped in <Transition>. The node stays mounted for the leave animation and
// renders a data-phase attribute that the stylesheet uses for the transition.

import { useEffect, useRef, useState } from 'react'

/** `enter` is the first painted frame, `idle` the resting state, `leave` the fade-out. */
export type PresencePhase = 'enter' | 'idle' | 'leave'

export type Presence = {
  mounted: boolean
  phase: PresencePhase
}

/**
 * Keeps a node mounted while it fades out.
 *
 * The enter phase is painted for two animation frames before the switch to
 * `idle`, matching Vue's nextFrame() helper: the first frame paints the hidden
 * state and the second starts the CSS transition. Mounting happens in an
 * effect, so no frame is painted in the final state before the enter phase is
 * applied.
 */
export function usePresence(open: boolean, durationMs: number): Presence {
  const [mounted, setMounted] = useState(open)
  const [phase, setPhase] = useState<PresencePhase>(open ? 'enter' : 'idle')
  const wasOpen = useRef(open)

  useEffect(() => {
    if (open) {
      wasOpen.current = true
      setMounted(true)
      setPhase('enter')
      // Two frames, like Vue's nextFrame(): the first paints the hidden state,
      // the second starts the transition to the idle state.
      let secondFrame = 0
      const firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          setPhase('idle')
        })
      })
      return () => {
        window.cancelAnimationFrame(firstFrame)
        window.cancelAnimationFrame(secondFrame)
      }
    }
    if (!wasOpen.current) {
      setMounted(false)
      setPhase('idle')
      return
    }
    // Close: play the leave transition, then unmount.
    wasOpen.current = false
    setPhase('leave')
    const timer = window.setTimeout(() => {
      setMounted(false)
      setPhase('idle')
    }, durationMs)
    return () => {
      window.clearTimeout(timer)
    }
  }, [open, durationMs])

  return { mounted, phase }
}

/** `data-phase` value for a presence phase; the resting phase renders no attribute. */
export function phaseAttribute(phase: PresencePhase): PresencePhase | undefined {
  return phase === 'idle' ? undefined : phase
}
