<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{
  src: string | null
  own?: boolean
  stateLabel?: string
  durationHint?: number | null
}>(), {
  own: false,
  stateLabel: '',
  durationHint: null,
})

const audio = ref<HTMLAudioElement | null>(null)
const duration = ref(0)
const currentTime = ref(0)
const playing = ref(false)
const failed = ref(false)

const playable = computed(() => Boolean(props.src) && !failed.value)

const barHeights = computed(() => {
  const source = props.src ?? ''
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
  // 低频正弦形成高低起伏的段落，再叠加少量噪声，接近参考图的波形密度。
  const phase = (seed % 628) / 100
  return Array.from({ length: 28 }, (_, index) => {
    const envelope = Math.abs(Math.sin((index / 27) * Math.PI * 4.2 + phase))
    const amplitude = Math.min(1, envelope * 0.78 + random() * 0.22)
    return Math.max(3, Math.round(3 + amplitude * 18))
  })
})

const progress = computed(() => {
  if (!Number.isFinite(duration.value) || duration.value <= 0)
    return 0
  return Math.min(1, Math.max(0, currentTime.value / duration.value))
})

const playedBars = computed(() => Math.round(progress.value * barHeights.value.length))

const seconds = computed(() => {
  if (Number.isFinite(duration.value) && duration.value > 0)
    return Math.max(1, Math.round(duration.value))
  const hint = props.durationHint
  if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0)
    return Math.max(1, Math.round(hint))
  return null
})

const label = computed(() => {
  if (!props.src)
    return props.stateLabel || '语音'
  if (seconds.value !== null)
    return `${seconds.value}"`
  if (props.stateLabel)
    return props.stateLabel
  return failed.value ? '无法播放' : '语音'
})

function readDuration() {
  const value = audio.value?.duration
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    duration.value = value
}

function onTimeUpdate() {
  currentTime.value = audio.value?.currentTime ?? 0
}

function toggle() {
  const element = audio.value
  if (!element || !playable.value)
    return
  if (element.paused) {
    void element.play().catch(() => {
      playing.value = false
    })
  }
  else {
    element.pause()
  }
}

function onPlay() {
  playing.value = true
}

function onPause() {
  playing.value = false
}

function onEnded() {
  playing.value = false
  currentTime.value = 0
  if (audio.value)
    audio.value.currentTime = 0
}

function onError() {
  failed.value = true
  playing.value = false
}

watch(() => props.src, () => {
  duration.value = 0
  currentTime.value = 0
  playing.value = false
  failed.value = false
})

onBeforeUnmount(() => {
  audio.value?.pause()
})
</script>

<template>
  <div class="voice-player" :class="{ own, playing, unavailable: !playable }">
    <button
      type="button"
      class="voice-trigger"
      :disabled="!playable"
      :aria-label="playable ? `播放语音 ${label}` : label"
      @click="toggle"
    >
      <Icon :name="playing ? 'pause' : 'voice-play'" :size="18" class="voice-icon" />
    </button>

    <span class="voice-wave" aria-hidden="true">
      <span
        v-for="(height, index) in barHeights"
        :key="index"
        class="voice-bar"
        :class="{ played: index < playedBars }"
        :style="{ height: `${height}px` }"
      />
      <span
        v-if="playable"
        class="voice-playhead"
        :style="{ left: `clamp(1px, ${(progress * 100).toFixed(2)}%, calc(100% - 1px))` }"
      />
    </span>

    <span class="voice-duration">{{ label }}</span>

    <audio
      ref="audio"
      class="voice-audio"
      :src="src ?? undefined"
      preload="metadata"
      @loadedmetadata="readDuration"
      @durationchange="readDuration"
      @timeupdate="onTimeUpdate"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
      @error="onError"
    />
  </div>
</template>

<style scoped>
.voice-player {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  min-width: 150px;
  color: inherit;
}

.voice-trigger {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.voice-trigger:disabled {
  opacity: 0.62;
  cursor: default;
}

.voice-trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.voice-icon {
  flex: 0 0 auto;
}

.voice-wave {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
  min-width: 112px;
  height: 26px;
  padding: 0 1px;
}

.voice-bar {
  flex: 0 0 auto;
  width: 2px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.34;
  transition: opacity 0.12s linear;
}

.voice-bar.played {
  opacity: 0.92;
}

.voice-player.unavailable .voice-bar {
  opacity: 0.22;
}

.voice-playhead {
  position: absolute;
  top: 50%;
  width: 2px;
  height: 26px;
  border-radius: 999px;
  background: #4ade80;
  box-shadow: 0 0 6px rgba(74, 222, 128, 0.55);
  transform: translate(-50%, -50%);
  transition: left 0.08s linear;
  pointer-events: none;
}

.voice-duration {
  flex: 0 0 auto;
  margin-left: 2px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  opacity: 0.92;
}

.voice-audio {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
</style>
