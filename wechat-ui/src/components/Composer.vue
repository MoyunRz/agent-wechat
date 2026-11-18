<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { IconName } from './Icon.vue'
import type { MentionOption, StagedAttachment } from '../types'
import { EMOTICON_LIST } from '../emoticons'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{
  modelValue: string
  attachments?: StagedAttachment[]
  disabled?: boolean
  sending?: boolean
  placeholder?: string
  /** 当前引用回复的消息；null 时隐藏引用条。 */
  replyTo?: { sender: string, preview: string } | null
  /** 当前会话支持 @ 提及（群聊）。 */
  mentionAvailable?: boolean
  /** @ 选择器条目（含「所有人」）；加载完成前为空。 */
  mentionOptions?: MentionOption[]
  /** 群成员列表是否仍在加载。 */
  mentionLoading?: boolean
}>(), {
  attachments: () => [],
  disabled: false,
  sending: false,
  placeholder: '输入消息',
  replyTo: null,
  mentionAvailable: false,
  mentionOptions: () => [],
  mentionLoading: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  attachFiles: [files: File[]]
  removeAttachment: [id: string]
  cancelReply: []
  /** @ 选择器展开时通知父层按需加载群成员。 */
  mentionOpen: []
}>()

const textarea = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const composing = ref(false)
const showEmoticons = ref(false)
const mentionOpen = ref(false)
const mentionQuery = ref('')
const mentionTriggerStart = ref(-1)
const mentionActive = ref(0)
let mentionBlurTimer: number | null = null

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

// ---- @ 提及选择器 -------------------------------------------------------

function closeMention(): void {
  mentionOpen.value = false
  mentionQuery.value = ''
  mentionTriggerStart.value = -1
}

function cancelMentionBlur(): void {
  if (mentionBlurTimer !== null) {
    window.clearTimeout(mentionBlurTimer)
    mentionBlurTimer = null
  }
}

/** 失焦后延迟关闭，给「点击选择」留出窗口（条目用 mousedown.prevent 保持焦点）。 */
function closeMentionSoon(): void {
  cancelMentionBlur()
  mentionBlurTimer = window.setTimeout(() => {
    mentionBlurTimer = null
    closeMention()
  }, 150)
}

/**
 * 检测光标前的 `@关键词` 触发片段：紧跟行首或空白之后、不含提及分隔符 U+2005。
 * value/caret 缺省时从输入框读取。
 */
function detectMention(value?: string, caret?: number): void {
  cancelMentionBlur()
  if (!props.mentionAvailable || props.disabled) {
    closeMention()
    return
  }
  const el = textarea.value
  const text = value ?? props.modelValue
  const at = caret ?? el?.selectionStart ?? text.length
  const match = /(?:^|\s)@([^\u2005]*)$/u.exec(text.slice(0, at))
  if (!match) {
    closeMention()
    return
  }
  const wasClosed = !mentionOpen.value
  mentionOpen.value = true
  mentionQuery.value = match[1]
  mentionTriggerStart.value = at - match[1].length - 1
  mentionActive.value = 0
  if (wasClosed)
    emit('mentionOpen')
}

const MENTION_ITEMS_LIMIT = 50

const mentionItems = computed<MentionOption[]>(() => {
  const query = mentionQuery.value.trim().toLowerCase()
  const all = props.mentionOptions.filter(option => option.all)
  const rest = props.mentionOptions.filter(option => !option.all)
  const matched = query
    ? rest.filter(option => option.label.toLowerCase().includes(query) || option.id.toLowerCase().includes(query))
    : rest
  const allMatched = query
    ? all.filter(option => option.label.toLowerCase().includes(query))
    : all
  return [...allMatched, ...matched].slice(0, MENTION_ITEMS_LIMIT)
})

async function selectMention(option: MentionOption): Promise<void> {
  cancelMentionBlur()
  const el = textarea.value
  const value = props.modelValue
  const caret = el?.selectionStart ?? value.length
  const start = mentionTriggerStart.value
  if (start < 0 || start > caret) {
    closeMention()
    return
  }
  // 提及片段以 U+2005（四分空格）结尾；发送时按该分隔符扫描提及区间。
  const token = `@${option.label}\u{2005}`
  emit('update:modelValue', value.slice(0, start) + token + value.slice(caret))
  const insertAt = start + token.length
  closeMention()
  await nextTick()
  resize()
  focus()
  if (el) {
    el.selectionStart = insertAt
    el.selectionEnd = insertAt
  }
}

/** 工具栏 @ 按钮：在光标处插入 @ 并展开选择器。 */
async function triggerMentionPicker(): Promise<void> {
  if (props.disabled || !props.mentionAvailable)
    return
  cancelMentionBlur()
  const el = textarea.value
  const value = props.modelValue
  const caret = el?.selectionStart ?? value.length
  const previous = value[caret - 1] ?? ''
  const prefix = caret > 0 && !/\s/u.test(previous) ? ' ' : ''
  emit('update:modelValue', value.slice(0, caret) + prefix + '@' + value.slice(caret))
  const triggerAt = caret + prefix.length
  await nextTick()
  if (el) {
    el.selectionStart = triggerAt + 1
    el.selectionEnd = triggerAt + 1
  }
  mentionOpen.value = true
  mentionQuery.value = ''
  mentionTriggerStart.value = triggerAt
  mentionActive.value = 0
  emit('mentionOpen')
  focus()
  resize()
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

/** 粘贴图片/文件：剪贴板里的文件项自动进入附件暂存；纯文本走默认粘贴。 */
function onPaste(event: ClipboardEvent): void {
  if (props.disabled)
    return
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length === 0)
    return
  event.preventDefault()
  emit('attachFiles', files)
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
  const target = event.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
  resize()
  detectMention(target.value, target.selectionStart ?? undefined)
}

function onKeydown(event: KeyboardEvent): void {
  if (mentionOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMention()
      return
    }
    if (event.key === 'ArrowDown' && mentionItems.value.length > 0) {
      event.preventDefault()
      mentionActive.value = (mentionActive.value + 1) % mentionItems.value.length
      return
    }
    if (event.key === 'ArrowUp' && mentionItems.value.length > 0) {
      event.preventDefault()
      mentionActive.value = (mentionActive.value - 1 + mentionItems.value.length) % mentionItems.value.length
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing.value) {
      const item = mentionItems.value[mentionActive.value]
      if (item) {
        event.preventDefault()
        void selectMention(item)
        return
      }
      // 没有可选条目时收起面板并放行发送。
      closeMention()
    }
  }
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
  async (value) => {
    await nextTick()
    resize()
    // 草稿被清空（如发送完成）时收起 @ 选择器。
    if (!value)
      closeMention()
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

      <div v-if="replyTo" class="reply-bar">
        <Icon name="reply" :size="13" class="reply-bar-icon" />
        <span class="reply-bar-text">
          <strong>{{ replyTo.sender }}</strong>{{ replyTo.preview }}
        </span>
        <button
          class="reply-bar-close"
          type="button"
          title="取消引用"
          @click="emit('cancelReply')"
        >
          <Icon name="close" :size="12" />
        </button>
      </div>

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

      <div v-if="mentionOpen" class="mention-panel">
        <div v-if="mentionLoading && mentionOptions.length === 0" class="mention-empty">
          <Icon name="refresh" :size="12" class="spin" />
          成员加载中…
        </div>
        <div v-else-if="mentionItems.length === 0" class="mention-empty">
          没有匹配的成员
        </div>
        <div v-else class="mention-list scrollbar-thin">
          <button
            v-for="(item, index) in mentionItems"
            :key="item.id"
            class="mention-item"
            :class="{ active: index === mentionActive }"
            type="button"
            :title="item.id"
            @mousedown.prevent
            @click="selectMention(item)"
          >
            <span class="mention-at">@</span>
            <span class="mention-label">{{ item.label }}</span>
            <span v-if="item.all" class="mention-tag">全体成员</span>
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
        @paste="onPaste"
        @click="detectMention()"
        @blur="closeMentionSoon"
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
          <button
            class="tool-button"
            type="button"
            :title="mentionAvailable ? '提及群成员' : '群聊中可提及成员'"
            :disabled="disabled || !mentionAvailable"
            @click="triggerMentionPicker"
          >
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
  padding: 10px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: var(--panel-elevated);
  box-shadow: 0 1px 3px rgba(2, 6, 23, 0.14);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.emoticon-panel {
  position: absolute;
  right: 8px;
  bottom: calc(100% + 10px);
  z-index: 30;
  width: min(328px, calc(100vw - 80px));
  padding: 8px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
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

/* @ 提及选择器：悬浮在输入框上方。 */
.mention-panel {
  position: absolute;
  left: 8px;
  bottom: calc(100% + 10px);
  z-index: 30;
  width: min(264px, calc(100vw - 120px));
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: var(--panel-elevated);
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
}

.mention-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  color: var(--muted);
  font-size: 11.5px;
}

.mention-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 216px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.mention-item:hover,
.mention-item.active {
  background: var(--panel-hover);
}

.mention-at {
  flex: 0 0 auto;
  color: var(--accent);
  font-weight: 600;
}

.mention-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.mention-tag {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 10px;
}

.tool-button.active {
  background: var(--accent-soft);
  color: var(--text);
}

.composer-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.composer-box.disabled {
  opacity: 0.6;
}

.composer-box textarea {
  display: block;
  width: 100%;
  flex: 0 0 auto;
  min-height: 24px;
  max-height: 132px;
  margin: 0;
  padding: 6px 0;
  border: 0;
  outline: none;
  resize: none;
  overflow-y: hidden;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: break-word;
  word-break: break-word;
}

.composer-box textarea::placeholder {
  color: var(--muted-soft);
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

.reply-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 7px;
  padding: 5px 8px;
  border-radius: 8px;
  background: var(--panel-soft);
  font-size: 11.5px;
}

.reply-bar-icon {
  flex: 0 0 auto;
  color: var(--accent);
}

.reply-bar-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
}

.reply-bar-text strong {
  margin-right: 5px;
  font-weight: 600;
  color: var(--text-soft);
}

.reply-bar-close {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.reply-bar-close:hover {
  color: var(--text-soft);
  background: var(--panel-hover);
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
  margin-top: 7px;
}

.composer-tools {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
}

.tool-button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
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
  height: 32px;
  padding: 0 16px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 999px;
  background: var(--bubble-out);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1;
  box-shadow: 0 3px 10px var(--accent-soft);
  transition: filter 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease, color 0.16s ease;
}

.send-button:hover:not(:disabled) {
  filter: brightness(1.08);
  transform: translateY(-1px);
  box-shadow: 0 5px 14px var(--accent-soft);
}

.send-button:active:not(:disabled) {
  transform: translateY(0);
}

.send-button:disabled {
  background: var(--panel-hover);
  color: var(--muted-soft);
  box-shadow: none;
}

.tool-button:focus-visible,
.staged-remove:focus-visible,
.send-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
