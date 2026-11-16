<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { dayKey, dayLabel } from '../format'
import type { AccountSummary, LocalMessage, MessageMediaMap, Thread } from '../types'
import Icon from './Icon.vue'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{
  messages: LocalMessage[]
  thread: Thread | null
  account: AccountSummary
  mediaByMessage: MessageMediaMap
  loading: boolean
  olderLoading: boolean
  hasMore: boolean
}>()

const emit = defineEmits<{
  loadOlder: []
  'at-bottom': []
}>()

const scroller = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)

function onScroll(): void {
  const el = scroller.value
  if (!el)
    return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  if (stickToBottom.value)
    emit('at-bottom')
  if (el.scrollTop < 70 && props.hasMore && !props.olderLoading && !props.loading)
    emit('loadOlder')
}

function scrollToBottom(force = false): void {
  const el = scroller.value
  if (!el)
    return
  if (!force && !stickToBottom.value)
    return
  el.scrollTop = el.scrollHeight
}

function maybeShowDay(index: number): boolean {
  const message = props.messages[index]
  if (!message)
    return false
  if (index === 0)
    return true
  const previous = props.messages[index - 1]
  return dayKey(previous?.createdAt) !== dayKey(message.createdAt)
}

const GROUP_WINDOW_MS = 5 * 60 * 1000

function sameGroup(previous: LocalMessage | undefined, current: LocalMessage | undefined): boolean {
  if (!previous || !current)
    return false
  if (previous.type === 10000 || current.type === 10000)
    return false
  if (previous.direction === null || current.direction === null)
    return false
  if (previous.direction !== current.direction)
    return false
  if ((previous.senderId ?? '') !== (current.senderId ?? ''))
    return false
  if (dayKey(previous.createdAt) !== dayKey(current.createdAt))
    return false
  const previousTime = previous.createdAt ? new Date(previous.createdAt).getTime() : Number.NaN
  const currentTime = current.createdAt ? new Date(current.createdAt).getTime() : Number.NaN
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime))
    return false
  const gap = currentTime - previousTime
  return gap >= 0 && gap <= GROUP_WINDOW_MS
}

function groupPosition(index: number): 'single' | 'first' | 'middle' | 'last' {
  const current = props.messages[index]
  const joinedPrevious = sameGroup(props.messages[index - 1], current)
  const joinedNext = sameGroup(current, props.messages[index + 1])
  if (!joinedPrevious && !joinedNext)
    return 'single'
  if (!joinedPrevious)
    return 'first'
  if (!joinedNext)
    return 'last'
  return 'middle'
}

watch(
  () => props.thread?.id,
  async () => {
    stickToBottom.value = true
    await nextTick()
    scrollToBottom(true)
  },
)

watch(
  () => props.messages,
  async (next, previous) => {
    const el = scroller.value
    if (!el)
      return

    const previousHeight = el.scrollHeight
    const previousTop = el.scrollTop
    const previousList = previous ?? []
    const nextList = next ?? []
    const prepended = previousList.length > 0
      && nextList.length > previousList.length
      && nextList[0]?.id !== previousList[0]?.id
      && nextList[nextList.length - 1]?.id === previousList[previousList.length - 1]?.id

    await nextTick()

    if (prepended && !stickToBottom.value) {
      el.scrollTop = previousTop + (el.scrollHeight - previousHeight)
      return
    }

    if (stickToBottom.value || previousList.length === 0)
      el.scrollTop = el.scrollHeight
  },
  { flush: 'pre' },
)

defineExpose({
  scrollToBottom,
  isAtBottom: () => stickToBottom.value,
})
</script>

<template>
  <div ref="scroller" class="message-scroll scrollbar-thin" @scroll.passive="onScroll">
    <div v-if="!thread" class="message-empty">
      <span class="empty-icon"><Icon name="message" :size="28" /></span>
      <p>选择一个聊天</p>
      <span>从左侧会话列表开始</span>
    </div>

    <div v-else class="message-inner">
      <button
        v-if="hasMore"
        class="load-older"
        type="button"
        :disabled="olderLoading"
        @click="emit('loadOlder')"
      >
        <Icon name="refresh" :size="13" :class="{ spin: olderLoading }" />
        {{ olderLoading ? '加载中' : '加载更早消息' }}
      </button>

      <div v-if="loading && messages.length === 0" class="message-skeletons">
        <span v-for="index in 5" :key="index" class="message-skeleton" :class="{ own: index % 2 === 0 }" />
      </div>

      <div v-else-if="messages.length === 0" class="message-empty">
        <span class="empty-icon"><Icon name="message" :size="26" /></span>
        <p>还没有消息</p>
        <span>发送一条消息开始聊天</span>
      </div>

      <template v-for="(message, index) in messages" :key="message.id">
        <div v-if="maybeShowDay(index)" class="day-divider">
          <span>{{ dayLabel(message.createdAt) }}</span>
        </div>
        <MessageBubble
          :message="message"
          :thread="thread"
          :account="account"
          :media="mediaByMessage[message.id]"
          :group-position="groupPosition(index)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.message-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.message-inner {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-height: 100%;
  padding: 20px 24px 12px;
}

.load-older {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  font-size: 11.5px;
}

.load-older:hover:not(:disabled) {
  background: var(--panel-hover);
  color: var(--text);
}

.day-divider {
  display: flex;
  justify-content: center;
  padding: 14px 0 8px;
}

.day-divider span {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.08);
  color: var(--muted-soft);
  font-size: 10.5px;
  font-weight: 500;
}

.message-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 260px;
  color: var(--muted);
  text-align: center;
}

.message-empty p {
  margin: 0;
  color: var(--text-soft);
  font-size: 14px;
  font-weight: 600;
}

.message-empty span {
  font-size: 11.5px;
}

.empty-icon {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  margin-bottom: 6px;
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel-soft);
  color: var(--muted);
}

.message-skeletons {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 0;
}

.message-skeleton {
  width: 42%;
  height: 40px;
  border-radius: 16px 16px 16px 5px;
  background: var(--panel-soft);
  animation: pulse 1.4s ease-in-out infinite;
}

.message-skeleton.own {
  align-self: flex-end;
  border-radius: 16px 16px 5px 16px;
  background: var(--accent-soft);
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.95; }
}
</style>
