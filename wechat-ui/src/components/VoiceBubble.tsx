// Voice message bubble: deterministic waveform plus a hidden audio element.
// The waveform seeding and layout match the Vue component exactly.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n/useT'
import Icon from './Icon'
import '../styles/components/voice-bubble.css'

type VoiceBubbleProps = {
  src: string | null
  own?: boolean
  stateLabel?: string
  durationHint?: number | null
}

/** Builds the bar heights from the source string, identical to the Vue version. */
function heightsFor(source: string): number[] {
  let seed = 2166136261
  for (let index = 0; index < source.length; index++) {
    seed ^= source.charCodeAt(index)
    seed = Math.imul(seed, 16777619) >>> 0
  }
  let state = seed || 1
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  // A low-frequency sine forms the rising and falling sections; a little noise
  // on top gives the density of the reference waveform.
  const phase = (seed % 628) / 100
  return Array.from({ length: 28 }, (_, index) => {
    const envelope = Math.abs(Math.sin((index / 27) * Math.PI * 4.2 + phase))
    const amplitude = Math.min(1, envelope * 0.78 + random() * 0.22)
    return Math.max(3, Math.round(3 + amplitude * 18))
  })
}

export default function VoiceBubble({
  src,
  own = false,
  stateLabel = '',
  durationHint = null,
}: VoiceBubbleProps) {
  const t = useT()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)

  const barHeights = useMemo(() => heightsFor(src ?? ''), [src])
  const playable = Boolean(src) && !failed

  const progress = Number.isFinite(duration) && duration > 0
    ? Math.min(1, Math.max(0, currentTime / duration))
    : 0
  const playedBars = Math.round(progress * barHeights.length)
  const seconds = Number.isFinite(duration) && duration > 0
    ? Math.max(1, Math.round(duration))
    : typeof durationHint === 'number' && Number.isFinite(durationHint) && durationHint > 0
      ? Math.max(1, Math.round(durationHint))
      : null
  const label = !src
    ? stateLabel || t('语音')
    : seconds !== null
      ? `${seconds}"`
      : stateLabel
        ? stateLabel
        : failed
          ? t('无法播放')
          : t('语音')

  function readDuration(): void {
    const value = audioRef.current?.duration
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      setDuration(value)
  }

  function onTimeUpdate(): void {
    setCurrentTime(audioRef.current?.currentTime ?? 0)
  }

  function toggle(): void {
    const element = audioRef.current
    if (!element || !playable)
      return
    if (element.paused) {
      void element.play().catch(() => {
        setPlaying(false)
      })
    }
    else {
      element.pause()
    }
  }

  function onPlay(): void {
    setPlaying(true)
  }

  function onPause(): void {
    setPlaying(false)
  }

  function onEnded(): void {
    setPlaying(false)
    setCurrentTime(0)
    if (audioRef.current)
      audioRef.current.currentTime = 0
  }

  function onError(): void {
    setFailed(true)
    setPlaying(false)
  }

  // Vue's watcher reset the playback state before the new source was rendered.
  useLayoutEffect(() => {
    setDuration(0)
    setCurrentTime(0)
    setPlaying(false)
    setFailed(false)
  }, [src])

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
    }
  }, [])

  const playerClass = [
    'voice-player',
    own ? 'own' : '',
    playing ? 'playing' : '',
    !playable ? 'unavailable' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={playerClass}>
      <button
        type="button"
        className="voice-trigger"
        disabled={!playable}
        aria-label={playable ? t('播放语音 {label}', { label }) : label}
        onClick={toggle}
      >
        <Icon name={playing ? 'pause' : 'voice-play'} size={18} className="voice-icon" />
      </button>

      <span className="voice-wave" aria-hidden="true">
        {barHeights.map((height, index) => (
          <span
            key={index}
            className={index < playedBars ? 'voice-bar played' : 'voice-bar'}
            style={{ height: `${height}px` }}
          />
        ))}
        {playable && (
          <span
            className="voice-playhead"
            style={{ left: `clamp(1px, ${(progress * 100).toFixed(2)}%, calc(100% - 1px))` }}
          />
        )}
      </span>

      {/* Unplayable voice keeps only the waveform; a playable one shows its duration. */}
      {playable && <span className="voice-duration">{label}</span>}

      <audio
        ref={audioRef}
        className="voice-audio"
        src={src ?? undefined}
        preload="metadata"
        onLoadedMetadata={readDuration}
        onDurationChange={readDuration}
        onTimeUpdate={onTimeUpdate}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onError={onError}
      />
    </div>
  )
}
