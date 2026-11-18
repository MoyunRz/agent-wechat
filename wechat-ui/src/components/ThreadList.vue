<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatListTime, previewText, threadName, threadNoNotify } from '../format'
import type { AccountSummary, Thread, ThreadFilter } from '../types'
import Icon from './Icon.vue'
import ThreadAvatar from './ThreadAvatar.vue'

const props = defineProps<{
  account: AccountSummary
  threads: Thread[]
  activeId: string | null
  query: string
  loading: boolean
  filterMode: ThreadFilter
  /** 分类为 business 的联系人（美团/瑞幸等品牌服务通知），折叠进「服务通知」聚合。 */
  businessUsernames?: Set<string>
}>()

const emit = defineEmits<{
  select: [thread: Thread]
  'update:query': [value: string]
  'update:filterMode': [value: ThreadFilter]
  refresh: []
  newChat: []
  readAll: []
}>()

const searchInput = ref<HTMLInputElement | null>(null)

const FILTER_TABS: ReadonlyArray<{ mode: ThreadFilter, label: string }> = [
  { mode: 'all', label: '全部' },
  { mode: 'unread', label: '未读' },
  { mode: 'direct', label: '单聊' },
  { mode: 'groups', label: '群聊' },
  { mode: 'mini', label: '企业微信' },
  { mode: 'official', label: '服务通知' },
]

/** 按会话类型分桶：群聊 / 小程序（OpenIM 客服）/ 服务通知（gh_ 公众号与品牌客服）/ 其余为单聊。 */
function threadBucket(thread: Thread): 'direct' | 'groups' | 'mini' | 'official' {
  if (thread.kind === 'group')
    return 'groups'
  const peer = (thread.peerId || thread.id).trim()
  if (peer.endsWith('@openim'))
    return 'mini'
  if (peer.startsWith('gh_'))
    return 'official'
  // 品牌服务通知（美团/瑞幸等）：wxid 客服号在联系人目录里标记为 business，
  // 与官方客户端一致折叠进「服务通知」聚合入口。
  if (props.businessUsernames?.has(peer))
    return 'official'
  return 'direct'
}

/** 折叠聚合的分类：key 与分桶一致，图标与文案对应官方客户端的聚合入口。 */
const COLLAPSED_CATEGORIES = {
  mini: { label: '企业微信', icon: 'mini' },
  official: { label: '服务通知', icon: 'service' },
} as const

type CollapsibleKey = keyof typeof COLLAPSED_CATEGORIES

interface CategoryGroup {
  key: CollapsibleKey
  label: string
  icon: string
  threads: Thread[]
  unread: number
  latest: Thread
}

interface DisplayItem {
  key: string
  thread?: Thread
  nested?: boolean
  group?: CategoryGroup
}

const filtered = computed(() => {
  let items = props.threads
  if (props.filterMode === 'unread')
    items = items.filter(thread => (thread.unreadCount ?? 0) > 0)
  else if (props.filterMode !== 'all')
    items = items.filter(thread => threadBucket(thread) === props.filterMode)

  const keyword = props.query.trim().toLowerCase()
  if (!keyword)
    return items
  return items.filter((thread) => {
    const name = threadName(thread).toLowerCase()
    const preview = previewText(thread).toLowerCase()
    return name.includes(keyword) || preview.includes(keyword) || thread.id.toLowerCase().includes(keyword)
  })
})

/** 仅在全部/未读且无搜索词时折叠：搜索平铺，避免命中的会话藏在聚合行里。 */
const collapseEnabled = computed(() =>
  (props.filterMode === 'all' || props.filterMode === 'unread')
  && props.query.trim() === '')

function latestThread(threads: Thread[]): Thread {
  return threads.reduce((best, thread) => {
    const bestTime = Date.parse(best.lastMessage?.createdAt ?? '') || 0
    const time = Date.parse(thread.lastMessage?.createdAt ?? '') || 0
    return time > bestTime ? thread : best
  })
}

const activeBucket = computed<CollapsibleKey | null>(() => {
  const thread = props.threads.find(item => item.id === props.activeId)
  if (!thread)
    return null
  const bucket = threadBucket(thread)
  return bucket === 'mini' || bucket === 'official' ? bucket : null
})

/** 各分类手动展开状态；激活会话所在分类始终展开。 */
const expandedCategories = ref<Record<CollapsibleKey, boolean>>({ mini: false, official: false })

function categoryExpanded(key: CollapsibleKey): boolean {
  return expandedCategories.value[key] || activeBucket.value === key
}

function toggleCategory(key: CollapsibleKey): void {
  expandedCategories.value[key] = !categoryExpanded(key)
}

/** 折叠分类成员按 [备注||昵称||ID] 字母升序展示；聚合行的位置与预览仍取最新时间。 */
function memberKey(thread: Thread): string {
  return threadName(thread)
}

function byMemberName(left: Thread, right: Thread): number {
  return memberKey(left).localeCompare(memberKey(right), 'zh-Hans-CN')
}

/** 渲染序列：普通会话原样输出；启用折叠时分类成员收敛为聚合行，展开后在行下方缩进展示。 */
const displayItems = computed<DisplayItem[]>(() => {
  const items = filtered.value
  if (!collapseEnabled.value)
    return items.map(thread => ({ key: thread.id, thread }))
  const groups = new Map<CollapsibleKey, Thread[]>()
  const result: DisplayItem[] = []
  for (const thread of items) {
    const bucket = threadBucket(thread)
    if (bucket === 'mini' || bucket === 'official') {
      if (!groups.has(bucket)) {
        groups.set(bucket, [])
        // 聚合行落在该分类最新会话原有的排序位置上。
        result.push({ key: `cat:${bucket}` })
      }
      groups.get(bucket)!.push(thread)
    }
    else {
      result.push({ key: thread.id, thread })
    }
  }
  for (const [key, members] of groups) {
    const meta = COLLAPSED_CATEGORIES[key]
    const group: CategoryGroup = {
      key,
      label: meta.label,
      icon: meta.icon,
      threads: members,
      unread: members.reduce((sum, thread) => sum + (thread.unreadCount ?? 0), 0),
      latest: latestThread(members),
    }
    const entry = result.find(item => item.key === `cat:${key}`)
    if (entry)
      entry.group = group
    if (categoryExpanded(key)) {
      const sorted = [...members].sort(byMemberName)
      sorted.forEach((thread, index) => {
        result.splice(result.indexOf(entry!) + 1 + index, 0, { key: `${key}:${thread.id}`, thread, nested: true })
      })
    }
  }
  return result.filter(item => item.thread || item.group)
})

function focusSearch(): void {
  searchInput.value?.focus()
}

defineExpose({ focusSearch })
</script>

<template>
  <aside class="thread-sidebar">
    <header class="sidebar-header">
      <div class="sidebar-title-row">
        <div class="sidebar-title">
          <h2>聊天</h2>
          <span class="thread-count">{{ threads.length }}</span>
        </div>
        <div class="header-actions">
          <button
            class="icon-button"
            type="button"
            title="全部已读"
            @click="emit('readAll')"
          >
            <Icon name="checks" :size="16" />
          </button>
          <button
            class="icon-button"
            type="button"
            title="新建聊天"
            @click="emit('newChat')"
          >
            <Icon name="plus" :size="16" />
          </button>
          <button
            class="icon-button"
            type="button"
            title="刷新会话列表"
            :disabled="loading"
            @click="emit('refresh')"
          >
            <Icon name="refresh" :size="16" :class="{ spin: loading }" />
          </button>
        </div>
      </div>
    </header>

    <div class="search-wrap">
      <Icon name="search" :size="15" class="search-icon" />
      <input
        ref="searchInput"
        :value="query"
        type="text"
        placeholder="搜索聊天"
        spellcheck="false"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      >
      <button
        v-if="query"
        class="clear-button"
        type="button"
        title="清除搜索"
        @click="emit('update:query', '')"
      >
        <Icon name="close" :size="13" />
      </button>
    </div>

    <div class="filter-tabs">
      <button
        v-for="tab in FILTER_TABS"
        :key="tab.mode"
        type="button"
        class="filter-tab"
        :class="{ active: filterMode === tab.mode }"
        @click="emit('update:filterMode', tab.mode)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="thread-scroll scrollbar-thin">
      <div v-if="loading && threads.length === 0" class="thread-skeletons">
        <div v-for="index in 6" :key="index" class="thread-skeleton">
          <span class="skeleton-avatar" />
          <span class="skeleton-lines">
            <span class="skeleton-line w-60" />
            <span class="skeleton-line w-90" />
          </span>
        </div>
      </div>

      <template v-else-if="filtered.length > 0">
        <template v-for="item in displayItems" :key="item.key">
          <button
            v-if="item.group"
            type="button"
            class="thread-item category-row"
            @click="toggleCategory(item.group.key)"
          >
            <span class="category-avatar" :class="`category-${item.group.icon}`">
              <!-- 企业微信：与 ThreadAvatar 的企微兜底头像一致，双气泡白标 + 蓝色渐变。 -->
              <svg v-if="item.group.icon === 'mini'" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4.1 6A2.15 2.15 0 0 1 6.25 3.85h7.9A2.15 2.15 0 0 1 16.3 6v5.4a2.15 2.15 0 0 1-2.15 2.15H9.6l-3.9 3.1v-3.1h.55A2.15 2.15 0 0 1 4.1 11.4Z"
                  fill="#fff"
                />
                <path
                  d="M14.9 10.3h3a2.15 2.15 0 0 1 2.15 2.15v3.2a2.15 2.15 0 0 1-2.15 2.15h-.35v2.3l-2.85-2.3h-2a2.15 2.15 0 0 1-2-1.4"
                  fill="none"
                  stroke="#fff"
                  stroke-width="1.6"
                  stroke-linecap="round"
                />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M18.9 3.85a1.15 1.15 0 0 1 1.73 1v14.3a1.15 1.15 0 0 1-1.73 1L9.3 14.95H5.55A1.95 1.95 0 0 1 3.6 13v-2a1.95 1.95 0 0 1 1.95-1.95H9.3z"
                  fill="#fff"
                />
                <path d="M7.5 16.15h2.9v1.75a1.9 1.9 0 0 1-3.8 0v-1.75z" fill="#fff" />
              </svg>
            </span>

            <span class="thread-main">
              <span class="thread-row">
                <span class="thread-name">{{ item.group.label }}</span>
                <span class="thread-time">{{ formatListTime(item.group.latest.lastMessage?.createdAt) }}</span>
              </span>
              <span class="thread-row thread-preview-row">
                <span class="thread-preview">{{ threadName(item.group.latest) }}：{{ previewText(item.group.latest) }}</span>
                <span class="thread-badges">
                  <span
                    v-if="item.group.unread > 0"
                    class="unread-badge unread-muted"
                  >
                    {{ item.group.unread > 99 ? '99+' : item.group.unread }}
                  </span>
                  <Icon
                    name="chevron-down"
                    :size="14"
                    class="category-chevron"
                    :class="{ open: categoryExpanded(item.group.key) }"
                  />
                </span>
              </span>
            </span>
          </button>

          <button
            v-else
            type="button"
            class="thread-item"
            :class="{ active: item.thread!.id === activeId, nested: item.nested }"
            @click="emit('select', item.thread!)"
          >
            <ThreadAvatar
              :account-id="account.id"
              :name="threadName(item.thread!)"
              :username="item.thread!.peerId"
              :kind="item.thread!.kind"
              :members="item.thread!.avatarMembers"
              :size="46"
            />

            <span class="thread-main">
              <span class="thread-row">
                <span class="thread-name">{{ threadName(item.thread!) }}</span>
                <span class="thread-time">{{ formatListTime(item.thread!.lastMessage?.createdAt) }}</span>
              </span>
              <span class="thread-row thread-preview-row">
                <span class="thread-preview">{{ previewText(item.thread!) }}</span>
                <span class="thread-badges">
                  <Icon v-if="item.thread!.pinned" name="pin" :size="13" class="muted-icon" />
                  <Icon v-if="item.thread!.muted" name="mute" :size="13" class="muted-icon" />
                  <span
                    v-if="(item.thread!.unreadCount ?? 0) > 0"
                    class="unread-badge"
                    :class="{ 'unread-muted': threadNoNotify(item.thread) }"
                  >
                    {{ (item.thread!.unreadCount ?? 0) > 99 ? '99+' : item.thread!.unreadCount }}
                  </span>
                </span>
              </span>
            </span>
          </button>
        </template>
      </template>

      <div v-else class="thread-empty">
        <span class="empty-icon">
          <Icon :name="filterMode === 'groups' ? 'users' : 'message'" :size="22" />
        </span>
        <p v-if="query">没有匹配的聊天</p>
        <p v-else-if="filterMode === 'unread'">没有未读消息</p>
        <p v-else-if="filterMode === 'groups'">还没有群聊</p>
        <p v-else-if="filterMode === 'direct'">还没有单聊</p>
        <p v-else-if="filterMode === 'mini'">还没有企业微信会话</p>
        <p v-else-if="filterMode === 'official'">还没有服务号消息</p>
        <template v-else>
          <p>还没有聊天</p>
          <span>新账号不会同步手机历史，收到新消息后会出现在这里。</span>
        </template>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.thread-sidebar {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 284px;
  min-width: 248px;
  height: 100%;
  border-right: 1px solid var(--border);
  background: var(--sidebar-sheen), var(--panel);
}

.sidebar-header {
  padding: 16px 14px 10px;
}

.sidebar-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.sidebar-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.sidebar-title h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.thread-count {
  color: var(--muted-soft);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.icon-button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  transition: background 0.16s ease, color 0.16s ease;
}

.icon-button:hover:not(:disabled) {
  background: var(--panel-hover);
  color: var(--text);
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  margin: 0 12px 8px;
  padding: 0 10px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-elevated);
  transition: border-color 0.16s ease, background 0.16s ease;
}

.search-wrap:focus-within {
  border-color: var(--accent);
}

.search-icon {
  color: var(--muted-soft);
  flex: 0 0 auto;
}

.search-wrap input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 8px;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 13px;
}

.search-wrap input::placeholder {
  color: var(--muted-soft);
}

.clear-button {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: var(--panel-hover);
  color: var(--muted);
}

.filter-tabs {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 0 10px 10px;
  overflow-x: auto;
  scrollbar-width: none;
}

.filter-tabs::-webkit-scrollbar {
  display: none;
}

.filter-tab {
  flex: 0 0 auto;
  padding: 4px 5px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}

.filter-tab:hover {
  color: var(--text-soft);
  background: var(--panel-hover);
}

.filter-tab.active {
  color: var(--text);
  background: var(--panel-hover);
  box-shadow: inset 0 0 0 1px var(--border);
}

.thread-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 6px 12px;
}

.thread-item {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 9px 8px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  text-align: left;
  transition: background 0.15s ease;
}

.thread-item:hover {
  background: var(--panel-hover);
}

.thread-item.active {
  background: linear-gradient(135deg, var(--accent-soft), var(--accent-faint));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
}

/* 小程序/服务号聚合入口：固定品牌图标 + 汇总未读，点击展开二级列表。 */
.category-avatar {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  color: #fff;
}

.category-avatar svg {
  width: 58%;
  height: 58%;
  display: block;
}

.category-mini {
  background: linear-gradient(135deg, #4795ff, #1a6ce0);
  box-shadow: 0 6px 16px rgba(71, 149, 255, 0.24);
}

.category-service {
  background: linear-gradient(135deg, #ffb14e, #f5760a);
  box-shadow: 0 6px 16px rgba(245, 118, 10, 0.24);
}

.category-chevron {
  color: var(--muted-soft);
  transition: transform 0.18s ease;
}

.category-chevron.open {
  transform: rotate(180deg);
}

.thread-item.nested {
  padding-left: 22px;
  background: color-mix(in srgb, var(--panel-soft) 55%, transparent);
}

.thread-item.nested:hover {
  background: var(--panel-hover);
}

.thread-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.thread-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.thread-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
}

.thread-time {
  flex: 0 0 auto;
  color: var(--muted-soft);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.thread-preview-row {
  align-items: center;
}

.thread-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 12px;
}

.thread-badges {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
}

.muted-icon {
  color: var(--muted-soft);
}

.unread-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--danger);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* 免打扰会话的未读：对齐官方客户端用灰色提示，弱化打扰感。 */
.unread-badge.unread-muted {
  background: var(--muted-soft);
  color: var(--rail-bg, #1a212c);
}

.thread-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 46px 22px;
  color: var(--muted);
  text-align: center;
}

.thread-empty p {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
  font-weight: 600;
}

.thread-empty span {
  font-size: 11.5px;
  line-height: 1.6;
}

.empty-icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin-bottom: 4px;
  border-radius: 15px;
  border: 1px solid var(--border);
  background: var(--panel-soft);
  color: var(--muted);
}

.thread-skeletons {
  padding: 4px;
}

.thread-skeleton {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 4px;
}

.skeleton-avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--panel-soft);
  animation: pulse 1.4s ease-in-out infinite;
}

.skeleton-lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.skeleton-line {
  height: 9px;
  border-radius: 999px;
  background: var(--panel-soft);
  animation: pulse 1.4s ease-in-out infinite;
}

.w-60 { width: 60%; }
.w-90 { width: 90%; }

@keyframes pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
</style>
