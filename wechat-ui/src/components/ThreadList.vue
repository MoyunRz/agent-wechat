<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatListTime, previewText, threadName } from '../format'
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
}>()

const emit = defineEmits<{
  select: [thread: Thread]
  'update:query': [value: string]
  'update:filterMode': [value: ThreadFilter]
  refresh: []
  newChat: []
}>()

const searchInput = ref<HTMLInputElement | null>(null)

const filtered = computed(() => {
  let items = props.threads
  if (props.filterMode === 'groups')
    items = items.filter(thread => thread.kind === 'group')
  else if (props.filterMode === 'unread')
    items = items.filter(thread => (thread.unreadCount ?? 0) > 0)

  const keyword = props.query.trim().toLowerCase()
  if (!keyword)
    return items
  return items.filter((thread) => {
    const name = threadName(thread).toLowerCase()
    const preview = previewText(thread).toLowerCase()
    return name.includes(keyword) || preview.includes(keyword) || thread.id.toLowerCase().includes(keyword)
  })
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
        type="button"
        class="filter-tab"
        :class="{ active: filterMode === 'all' }"
        @click="emit('update:filterMode', 'all')"
      >
        全部
      </button>
      <button
        type="button"
        class="filter-tab"
        :class="{ active: filterMode === 'unread' }"
        @click="emit('update:filterMode', 'unread')"
      >
        未读
      </button>
      <button
        type="button"
        class="filter-tab"
        :class="{ active: filterMode === 'groups' }"
        @click="emit('update:filterMode', 'groups')"
      >
        群聊
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
        <button
          v-for="thread in filtered"
          :key="thread.id"
          type="button"
          class="thread-item"
          :class="{ active: thread.id === activeId }"
          @click="emit('select', thread)"
        >
          <ThreadAvatar
            :account-id="account.id"
            :name="threadName(thread)"
            :username="thread.peerId"
            :kind="thread.kind"
            :members="thread.avatarMembers"
            :size="46"
          />

          <span class="thread-main">
            <span class="thread-row">
              <span class="thread-name">{{ threadName(thread) }}</span>
              <span class="thread-time">{{ formatListTime(thread.lastMessage?.createdAt) }}</span>
            </span>
            <span class="thread-row thread-preview-row">
              <span class="thread-preview">{{ previewText(thread) }}</span>
              <span class="thread-badges">
                <Icon v-if="thread.pinned" name="pin" :size="13" class="muted-icon" />
                <Icon v-if="thread.muted" name="mute" :size="13" class="muted-icon" />
                <span v-if="(thread.unreadCount ?? 0) > 0" class="unread-badge">
                  {{ (thread.unreadCount ?? 0) > 99 ? '99+' : thread.unreadCount }}
                </span>
              </span>
            </span>
          </span>
        </button>
      </template>

      <div v-else class="thread-empty">
        <span class="empty-icon">
          <Icon :name="filterMode === 'groups' ? 'users' : 'message'" :size="22" />
        </span>
        <p v-if="query">没有匹配的聊天</p>
        <p v-else-if="filterMode === 'unread'">没有未读消息</p>
        <p v-else-if="filterMode === 'groups'">还没有群聊</p>
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
  gap: 6px;
  padding: 0 12px 10px;
}

.filter-tab {
  padding: 4px 11px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 500;
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
