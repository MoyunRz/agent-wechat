<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { IconName } from './Icon.vue'
import type { StagedAttachment } from '../types'
import { EMOTICON_LIST } from '../emoticons'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{
  modelValue: string
  attachments?: StagedAttachment[]
  disabled?: boolean
  sending?: boolean
  placeholder?: string
}>(), {
  attachments: () => [],
  disabled: false,
  sending: false,
  placeholder: '输入消息',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  attachFiles: [files: File[]]
  removeAttachment: [id: string]
}>()

const textarea = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const composing = ref(false)
const showEmoticons = ref(false)

const canSend = computed(() => {
  return Boolean(props.modelValue.trim()) || props.attachments.length > 0
})

function toggleEmoticons(): void {
  if (props.disabled)
    return
  showEmoticons.value = !showEmoticons.value
}

function closeEmoticons(): void {
  showEmoticons.value = false
}

/** 在光标处插入 [表情名] 标记，并把光标移到插入内容之后。 */
async function insertEmoticon(name: string): Promise<void> {
  if (props.disabled)
    return
  const el = textarea.value
  const token = `[${name}]`
  const value = props.modelValue
  let insertAt = value.length
  if (el) {
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    emit('update:modelValue', value.slice(0, start) + token + value.slice(end))
    insertAt = start + token.length
  }
  else {
    emit('update:modelValue', value + token)
  }
  await nextTick()
  resize()
  focus()
  if (el) {
    el.selectionStart = insertAt
    el.selectionEnd = insertAt
  }
}

function iconFor(kind: StagedAttachment['kind']): IconName {
  switch (kind) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'voice':
      return 'mic'
    default:
      return 'paperclip'
  }
}

function openFilePicker(): void {
  if (props.disabled)
    return
  fileInput.value?.click()
}

function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length > 0)
    emit('attachFiles', files)
  input.value = ''
}

const MAX_TEXTAREA_HEIGHT = 132

function resize(): void {
  const el = textarea.value
  if (!el)
    return
  el.style.height = 'auto'
  const contentHeight = el.scrollHeight
  el.style.height = `${Math.min(contentHeight, MAX_TEXTAREA_HEIGHT)}px`
  el.style.overflowY = contentHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden'
}

function focus(): void {
  textarea.value?.focus()
}

function submit(): void {
  if (props.disabled || props.sending)
    return
  if (!canSend.value)
    return
  emit('send')
}

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
  resize()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && showEmoticons.value) {
    event.preventDefault()
    closeEmoticons()
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing.value)
    return
  event.preventDefault()
  submit()
}

watch(
  () => props.modelValue,
  async () => {
    await nextTick()
    resize()
  },
)

onMounted(resize)

defineExpose({ focus })
</script>

<template>
  <footer class="composer">
    <div class="composer-box" :class="{ disabled }">
      <input
        ref="fileInput"
        class="file-input"
        type="file"
        multiple
        accept="image/*,video/*,audio/*"
        @change="onFilesPicked"
      >

      <div v-if="attachments.length > 0" class="staged-list">
        <div v-for="item in attachments" :key="item.id" class="staged-item">
          <img
            v-if="item.kind === 'image' && item.previewUrl"
            :src="item.previewUrl"
            alt=""
            class="staged-preview"
          >
          <span v-else class="staged-icon">
            <Icon :name="iconFor(item.kind)" :size="15" />
          </span>
          <span class="staged-name">{{ item.name }}</span>
          <button
            class="staged-remove"
            type="button"
            title="移除附件"
            @click="emit('removeAttachment', item.id)"
          >
            <Icon name="close" :size="12" />
          </button>
        </div>
      </div>

      <div v-if="showEmoticons" class="emoticon-panel">
        <div class="emoticon-head">
          <span>黄豆表情</span>
          <button class="emoticon-close" type="button" title="收起" @click="closeEmoticons">
            <Icon name="close" :size="12" />
          </button>
        </div>
        <div class="emoticon-grid">
          <button
            v-for="item in EMOTICON_LIST"
            :key="item.name"
            class="emoticon-cell"
            type="button"
            :title="`[${item.name}]`"
            @click="insertEmoticon(item.name)"
          >
            {{ item.emoji }}
          </button>
        </div>
      </div>

      <textarea
        ref="textarea"
        :value="modelValue"
        rows="1"
        :placeholder="placeholder"
        :disabled="disabled"
        spellcheck="false"
        @input="onInput"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />

      <div class="composer-toolbar">
        <div class="composer-tools">
          <button
            class="tool-button"
            :class="{ active: showEmoticons }"
            type="button"
            title="黄豆表情"
            :disabled="disabled"
            @click="toggleEmoticons"
          >
            <Icon name="smile" :size="16" />
          </button>
          <button
            class="tool-button"
            type="button"
            title="发送图片、视频或语音"
            :disabled="disabled"
            @click="openFilePicker"
          >
            <Icon name="paperclip" :size="16" />
          </button>
          <button class="tool-button" type="button" disabled title="提及成员即将支持">
            <Icon name="at" :size="16" />
          </button>
        </div>

        <div class="composer-actions">
          <span class="composer-hint">Enter 发送 · Shift + Enter 换行</span>
          <button
            class="send-button"
            type="button"
            :disabled="disabled || sending || !canSend"
            :title="sending ? '发送中' : '发送 (Enter)'"
            @click="submit"
          >
            <span>发送</span>
            <Icon v-if="!sending" name="send" :size="14" />
            <Icon v-else name="refresh" :size="14" class="spin" />
          </button>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.composer {
  flex: 0 0 auto;
  padding: 10px 18px 14px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.composer-box {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 9px 12px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--panel-elevated);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.emoticon-panel {
  position: absolute;
  right: 8px;
  bottom: calc(100% + 8px);
  z-index: 30;
  width: min(328px, calc(100vw - 80px));
  padding: 8px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--panel-elevated);
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
}

.emoticon-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px 6px;
  color: var(--muted);
  font-size: 11px;
}

.emoticon-close {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-soft);
}

.emoticon-close:hover {
  background: var(--panel-hover);
  color: var(--text);
}

.emoticon-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  max-height: 184px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.emoticon-cell {
  display: grid;
  place-items: center;
  height: 36px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  transition: background 0.12s ease, transform 0.12s ease;
}

.emoticon-cell:hover {
  background: var(--panel-hover);
  transform: scale(1.12);
}

.emoticon-grid::-webkit-scrollbar {
  width: 6px;
}

.emoticon-grid::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.28);
}

.emoticon-grid::-webkit-scrollbar-track {
  background: transparent;
}

.tool-button.active {
  background: var(--accent-soft);
  color: var(--text);
}

.composer-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.composer-box.disabled {
  opacity: 0.6;
}

.composer-box textarea {
  display: block;
  width: 100%;
  flex: 0 0 auto;
  min-height: 37px;
  max-height: 132px;
  margin: 0;
  padding: 8px 0;
  border: 0;
  outline: none;
  resize: none;
  overflow-y: hidden;
  background: transparent;
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.55;
  overflow-wrap: break-word;
  word-break: break-word;
}

.composer-box textarea::placeholder {
  color: var(--muted);
  opacity: 1;
}

.composer-box textarea:disabled {
  cursor: default;
  color: var(--muted);
}

.composer-box textarea::-webkit-scrollbar {
  width: 6px;
}

.composer-box textarea::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.28);
}

.composer-box textarea::-webkit-scrollbar-track {
  background: transparent;
}

.file-input {
  display: none;
}

.staged-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 6px;
}

.staged-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: min(240px, 100%);
  padding: 3px 5px 3px 3px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-soft);
}

.staged-preview {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 6px;
  object-fit: cover;
}

.staged-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 6px;
  background: var(--panel-hover);
  color: var(--muted);
}

.staged-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-soft);
  font-size: 11.5px;
}

.staged-remove {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted-soft);
}

.staged-remove:hover {
  background: var(--panel-hover);
  color: var(--text);
}

.composer-toolbar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  margin-top: 4px;
}

.composer-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.tool-button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted-soft);
  transition: background 0.16s ease, color 0.16s ease;
}

.tool-button:hover:not(:disabled) {
  background: var(--panel-hover);
  color: var(--text);
}

.tool-button:disabled {
  opacity: 0.45;
}

.composer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 1 auto;
  min-width: 0;
}

.composer-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted-soft);
  font-size: 10.5px;
}

.send-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 14px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 8px;
  background: var(--bubble-out);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  box-shadow: 0 2px 8px var(--accent-soft);
  transition: filter 0.16s ease, opacity 0.16s ease, box-shadow 0.16s ease;
}

.send-button:hover:not(:disabled) {
  filter: brightness(1.08);
}

.send-button:disabled {
  opacity: 0.4;
  box-shadow: none;
}

.tool-button:focus-visible,
.staged-remove:focus-visible,
.send-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
