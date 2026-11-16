<script setup lang="ts">
import { computed } from 'vue'

export type IconName =
  | 'search'
  | 'refresh'
  | 'send'
  | 'plus'
  | 'close'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'pin'
  | 'mute'
  | 'users'
  | 'user'
  | 'contacts'
  | 'qr'
  | 'alert'
  | 'wifi'
  | 'wifi-off'
  | 'link'
  | 'message'
  | 'clock'
  | 'logout'
  | 'paperclip'
  | 'at'
  | 'settings'
  | 'panel'
  | 'image'
  | 'video'
  | 'mic'
  | 'speaker'
  | 'voice-play'
  | 'pause'
  | 'smile'

const props = withDefaults(defineProps<{
  name: IconName
  size?: number
  strokeWidth?: number
}>(), {
  size: 18,
  strokeWidth: 1.8,
})

const paths: Record<IconName, string[]> = {
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'M20 20l-4-4'],
  refresh: ['M20 11a8 8 0 1 0-2.3 6.6', 'M20 4v7h-7'],
  send: ['M21 3 10.5 13.5', 'M21 3l-6.2 18-4.3-7.5L3 9.2 21 3Z'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  check: ['M20 6 9 17l-5-5'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-right': ['m9 6 6 6-6 6'],
  pin: ['M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z', 'M12 14v7'],
  mute: ['M4 9v6h4l5 4V5L8 9H4Z', 'm18 9-4 6', 'm14 9 4 6'],
  users: ['M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M2.5 20a5.5 5.5 0 0 1 11 0', 'M16 10.5a3 3 0 1 0 0-6', 'M16.5 14.2a5.2 5.2 0 0 1 5 5.8'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4.5 21a7.5 7.5 0 0 1 15 0'],
  contacts: ['M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M3 21a7 7 0 0 1 14 0', 'M17 8.5h4', 'M17 12.5h4'],
  qr: ['M4 4h6v6H4Z', 'M14 4h6v6h-6Z', 'M4 14h6v6H4Z', 'M14 14h2v2h-2Z', 'M18 14h2v6h-6v-2', 'M14 18h2'],
  alert: ['M12 3 2.7 20h18.6L12 3Z', 'M12 9v5', 'M12 17h.01'],
  wifi: ['M2.5 8.5a15 15 0 0 1 19 0', 'M6 12a10 10 0 0 1 12 0', 'M9.5 15.5a5 5 0 0 1 5 0', 'M12 19h.01'],
  'wifi-off': ['M2 4l20 16', 'M8.5 9.3A15 15 0 0 1 21.5 8.5', 'M9.5 15.5a5 5 0 0 1 5 0', 'M12 19h.01'],
  link: ['M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2', 'M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2'],
  message: ['M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5Z'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7v5l3 2'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  paperclip: ['M21.4 11.6l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-2.8-2.8l7.8-7.8'],
  at: ['M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z', 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
  panel: ['M3 5h18v14H3Z', 'M15 5v14'],
  image: ['M3 5h18v14H3Z', 'M3 16l5-5 4 4 2-2 7 7', 'M16 9h.01'],
  video: ['M3 6h14v12H3Z', 'm17 10 4-2v8l-4-2', 'M10 9.5v5l4-2.5-4-2.5Z'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
  speaker: ['M11 5 6 9H3v6h3l5 4V5Z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18 6a9 9 0 0 1 0 12'],
  'voice-play': ['M6 6.5v11l8-5.5-8-5.5Z', 'M16 9a5 5 0 0 1 0 6', 'M19 6.5a9 9 0 0 1 0 11'],
  pause: ['M9 6v12', 'M15 6v12'],
  smile: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M9 10h.01', 'M15 10h.01', 'M8.5 14.5a4.5 4.5 0 0 0 7 0'],
}

const current = computed(() => paths[props.name] ?? [])
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :stroke-width="strokeWidth"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(item, index) in current" :key="index" :d="item" />
  </svg>
</template>
