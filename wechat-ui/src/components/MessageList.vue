<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import brandLogoUrl from '../assets/agent-wechat-logo.svg'
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
  highlightId?: string | null
}>()

const emit = defineEmits<{
  loadOlder: []
  'at-bottom': []
  reply: [message: LocalMessage]
  preview: [src: string]
}>()

const scroller = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)

/** 服务号/公众号（gh_）消息流：统一宽度卡片布局，无头像与输入框。 */
const cardLayout = computed(() => (props.thread?.peerId ?? '').trim().startsWith('gh_'))

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

/** 将指定消息滚动到视口中央；消息未渲染（不在已加载区间）时不动作。 */
function scrollToMessage(id: string): void {
  const el = scroller.value
  if (!el)
    return
  const target = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`)
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
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
  scrollToMessage,
  isAtBottom: () => stickToBottom.value,
})
</script>

<template>
  <div ref="scroller" class="message-scroll scrollbar-thin" @scroll.passive="onScroll">
    <div v-if="!thread" class="welcome-screen">
      <span class="welcome-logo"><img :src="brandLogoUrl" alt="" width="82" height="82"></span>
      <h2>Agent WeChat</h2>
      <p class="welcome-slogan">面向人与 AI 智能体的开源微信客户端</p>
      <span class="welcome-hint">从左侧会话列表选择一个聊天开始</span>
    </div>

    <div v-else class="message-inner" :class="{ 'official-feed': cardLayout }">
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
          :data-mid="message.id"
          :class="{ 'message-flash': highlightId === message.id }"
          @reply="emit('reply', message)"
          @preview="emit('preview', $event)"
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

/* 服务号/公众号卡片流：单层文章卡片，标题/来源/时间三级排版（参考图 2）。 */
.official-feed {
  width: 100%;
  max-width: 680px;
  align-self: center;
}

.official-feed :deep(.message-row) {
  justify-content: flex-start;
  padding: 6px 0;
}

.official-feed :deep(.message-avatar),
.official-feed :deep(.reply-action),
.official-feed :deep(.read-check) {
  display: none;
}

.official-feed :deep(.message-stack) {
  max-width: 100%;
  width: 100%;
  align-items: stretch;
}

.official-feed :deep(.bubble) {
  width: 100%;
  border-radius: 16px;
  background: var(--panel-soft);
  border: 1px solid var(--border);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
  color: var(--text);
  padding: 13px 16px 9px;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.official-feed :deep(.message-row:hover .bubble) {
  border-color: color-mix(in srgb, var(--accent) 26%, var(--border));
  background: var(--panel-hover);
}

.official-feed :deep(.bubble.own) {
  border-radius: 16px;
  background: var(--panel-soft);
  color: var(--text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
}

.official-feed :deep(.bubble-text) {
  font-size: 13.5px;
  line-height: 1.65;
  margin: 1px 0 3px;
}

/* 内层链接卡去盒化：透明融入外层卡片，成为文章主体排版。 */
.official-feed :deep(.link-card) {
  width: 100%;
  margin: 0 0 3px;
  padding: 0;
  border-radius: 0;
  background: transparent;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 14px;
  align-items: center;
}

.official-feed :deep(.link-card:hover) {
  background: transparent;
}

.official-feed :deep(.card-body) {
  gap: 5px;
}

.official-feed :deep(.card-title) {
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.55;
  color: var(--text);
  -webkit-line-clamp: 3;
}

.official-feed :deep(.card-meta) {
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  -webkit-line-clamp: 2;
}

.official-feed :deep(.card-source) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted-soft);
}

.official-feed :deep(.card-source)::before {
  content: '';
  flex: 0 0 auto;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.6;
}

/* 链接角标：幽灵圆钮，hover 唤起主题色。 */
.official-feed :deep(.card-icon) {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  transition: color 0.15s ease, border-color 0.15s ease;
}

.official-feed :deep(.message-row:hover .card-icon) {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
}

.official-feed :deep(.image-line) {
  width: 100%;
}

.official-feed :deep(.image-line.own) {
  align-items: stretch;
}

.official-feed :deep(.image-content) {
  width: 100%;
  max-width: 100%;
  max-height: 420px;
  object-fit: cover;
  border-radius: 12px;
}

.official-feed :deep(.voice-line),
.official-feed :deep(.voice-line .bubble) {
  width: 100%;
}

.official-feed :deep(.bubble-meta),
.official-feed :deep(.image-meta) {
  justify-content: flex-end;
  margin-top: 3px;
}

.official-feed :deep(.bubble-time) {
  color: var(--muted-soft);
  font-size: 10.5px;
}

/* 日期分隔：细描边胶囊，与卡片拉开层次。 */
.official-feed .day-divider {
  padding: 16px 0 10px;
}

.official-feed .day-divider span {
  padding: 4px 12px;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted-soft);
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

/* 未选择会话时的品牌欢迎页：替代原「选择一个聊天」占位，避免首屏呈现个人对话框观感。 */
.welcome-screen {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 260px;
  text-align: center;
}

.welcome-logo {
  display: block;
  width: 82px;
  height: 82px;
  margin-bottom: 12px;
  filter: drop-shadow(0 16px 22px rgba(37, 126, 183, 0.16));
}

.welcome-logo img {
  display: block;
  width: 100%;
  height: 100%;
}

.welcome-screen h2 {
  margin: 0;
  color: var(--text);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.2px;
}

.welcome-slogan {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
}

.welcome-hint {
  margin-top: 14px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-soft);
  color: var(--muted);
  font-size: 11.5px;
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

/* 搜索定位高亮：落在 MessageBubble 根元素上（父作用域样式对子组件根元素生效）。 */
.message-flash {
  animation: message-flash 2.4s ease-out;
}

@keyframes message-flash {
  0% { background: var(--accent-soft); }
  70% { background: var(--accent-soft); }
  100% { background: transparent; }
}
</style>
