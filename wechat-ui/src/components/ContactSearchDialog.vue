<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { wechatApi, WechatApiError } from '../api'
import { userFacingErrorMessage } from '../errors'
import { contactName } from '../format'
import type { Contact, Operation } from '../types'
import Icon from './Icon.vue'
import ThreadAvatar from './ThreadAvatar.vue'

const props = defineProps<{
  open: boolean
  accountId: string
}>()

const emit = defineEmits<{
  close: []
  select: [contact: Contact]
  startId: [id: string]
}>()

const query = ref('')
const contacts = ref<Contact[]>([])
const loading = ref(false)
const error = ref('')
const syncing = ref(false)
const syncStatus = ref('')
const syncFailed = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
let searchTimer: number | null = null
let requestToken = 0
let syncToken = 0

const SYNC_POLL_INTERVAL = 1500
const SYNC_POLL_LIMIT = 80

const normalizedQuery = computed(() => query.value.trim())

function isTerminalState(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function describeError(value: unknown): string {
  if (value instanceof WechatApiError) {
    if (value.status === 409)
      return '请先登录微信并完成同步，也可以直接输入微信号开始聊天。'
    return userFacingErrorMessage(value, '搜索联系人失败，请稍后重试。')
  }
  return userFacingErrorMessage(value, '搜索联系人失败，请稍后重试。')
}

function describeSyncError(value: unknown): string {
  if (value instanceof WechatApiError) {
    if (value.status === 401 || value.status === 403 || value.status === 409
      || value.code === 'auth_required' || value.code === 'profile_keys_missing')
      return '请先登录微信并完成同步。'
    return userFacingErrorMessage(value, '同步通讯录失败，请稍后重试。')
  }
  return userFacingErrorMessage(value, '同步通讯录失败，请稍后重试。')
}

function describeOperationFailure(operation: Operation): string {
  if (operation.state === 'cancelled')
    return '通讯录同步已取消，请重新点击同步。'
  const code = typeof operation.result?.code === 'string' ? operation.result.code : ''
  if (code === 'auth_required' || code === 'profile_keys_missing' || code === 'not_connected')
    return '请先登录微信并完成同步。'
  return '通讯录同步失败，请稍后重试。'
}

async function loadContacts(): Promise<void> {
  const token = ++requestToken
  loading.value = true
  error.value = ''
  try {
    const response = await wechatApi.listContacts(props.accountId, normalizedQuery.value, 30)
    if (token !== requestToken)
      return
    contacts.value = response.items ?? []
  }
  catch (value) {
    if (token !== requestToken)
      return
    contacts.value = []
    error.value = describeError(value)
  }
  finally {
    if (token === requestToken)
      loading.value = false
  }
}

async function syncContacts(): Promise<void> {
  if (syncing.value || loading.value)
    return
  const token = ++syncToken
  syncing.value = true
  syncFailed.value = false
  syncStatus.value = '正在同步通讯录…'
  try {
    let operation = await wechatApi.syncContacts(props.accountId)
    for (let attempt = 0; attempt < SYNC_POLL_LIMIT && !isTerminalState(operation.state); attempt++) {
      await sleep(SYNC_POLL_INTERVAL)
      if (token !== syncToken)
        return
      operation = await wechatApi.getOperation(props.accountId, operation.id)
    }
    if (token !== syncToken)
      return
    if (!isTerminalState(operation.state)) {
      syncFailed.value = true
      syncStatus.value = '通讯录同步超时，请稍后重试。'
      return
    }
    if (operation.state === 'succeeded') {
      syncStatus.value = '通讯录已同步'
      await loadContacts()
      return
    }
    syncFailed.value = true
    syncStatus.value = describeOperationFailure(operation)
  }
  catch (value) {
    if (token !== syncToken)
      return
    syncFailed.value = true
    syncStatus.value = describeSyncError(value)
  }
  finally {
    if (token === syncToken)
      syncing.value = false
  }
}

function scheduleSearch(delay = 300): void {
  if (searchTimer !== null)
    window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    void loadContacts()
  }, delay)
}

function focusSearchInput(): void {
  searchInput.value?.focus({ preventScroll: true })
}

function onSearchInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value
  scheduleSearch()
}

function choose(contact: Contact): void {
  emit('select', contact)
}

function useTypedId(): void {
  if (normalizedQuery.value)
    emit('startId', normalizedQuery.value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (contacts.value.length > 0)
      choose(contacts.value[0])
    else
      useTypedId()
  }
}

watch(
  () => props.open,
  async (open) => {
    syncToken += 1
    syncing.value = false
    if (!open) {
      if (searchTimer !== null) {
        window.clearTimeout(searchTimer)
        searchTimer = null
      }
      requestToken += 1
      return
    }
    query.value = ''
    contacts.value = []
    error.value = ''
    syncStatus.value = ''
    syncFailed.value = false
    await nextTick()
    focusSearchInput()
    // 点击“+”的默认聚焦会在同一帧末尾覆盖程序化焦点，下一帧再补一次。
    window.requestAnimationFrame(() => {
      if (props.open)
        focusSearchInput()
    })
    void loadContacts()
  },
)

onBeforeUnmount(() => {
  if (searchTimer !== null)
    window.clearTimeout(searchTimer)
  requestToken += 1
  syncToken += 1
})
</script>

<template>
  <Teleport to="body">
    <Transition name="contact" @after-enter="focusSearchInput">
      <div v-if="open" class="contact-backdrop" @click="emit('close')">
        <section class="contact-dialog" @click.stop @keydown="onKeydown">
          <header class="contact-head">
            <div>
              <strong>新建聊天</strong>
              <span>搜索通讯录，或输入微信号直接开始</span>
            </div>
            <button type="button" class="contact-close" title="关闭" @click="emit('close')">
              <Icon name="close" :size="15" />
            </button>
          </header>

          <div class="contact-search">
            <Icon name="search" :size="15" class="contact-search-icon" />
            <input
              ref="searchInput"
              :value="query"
              type="text"
              placeholder="搜索联系人或输入微信号"
              spellcheck="false"
              autofocus
              @input="onSearchInput"
              @keydown="onKeydown"
            >
            <span v-if="loading" class="contact-spinner">
              <Icon name="refresh" :size="14" class="spin" />
            </span>
          </div>

          <p v-if="error" class="contact-error">{{ error }}</p>

          <p class="contact-source-note">搜索结果来自已同步的通讯录，覆盖微信号、昵称、备注和备注名。</p>

          <div class="contact-results scrollbar-thin">
            <button
              v-for="contact in contacts"
              :key="contact.id"
              type="button"
              class="contact-item"
              @click="choose(contact)"
            >
              <ThreadAvatar
                :account-id="accountId"
                :name="contactName(contact)"
                :username="contact.username || contact.id"
                :size="38"
              />
              <span class="contact-meta">
                <span class="contact-name">{{ contactName(contact) }}</span>
                <span class="contact-sub">
                  {{ contact.username || contact.id }}
                  <template v-if="contact.alias && contact.alias !== contact.username"> · {{ contact.alias }}</template>
                </span>
              </span>
              <span class="contact-action">聊天</span>
            </button>

            <div v-if="!loading && contacts.length === 0" class="contact-empty">
              <span class="contact-empty-icon"><Icon name="users" :size="22" /></span>
              <p v-if="normalizedQuery">没有找到匹配的联系人</p>
              <p v-else>通讯录还没有可搜索的联系人</p>
              <span v-if="normalizedQuery">可以直接用“{{ normalizedQuery }}”作为微信号开始聊天。</span>
              <span v-else>输入微信号或联系人 ID 也可以开始聊天。</span>
            </div>
          </div>

          <footer class="contact-foot">
            <div class="contact-foot-sync">
              <button
                type="button"
                class="contact-sync"
                :disabled="syncing || loading"
                @click="syncContacts"
              >
                <Icon name="refresh" :size="13" :class="{ spin: syncing }" />
                <span>同步通讯录</span>
              </button>
              <span
                v-if="syncStatus"
                class="contact-sync-state"
                :class="{ 'is-error': syncFailed, 'is-success': !syncFailed && !syncing }"
              >{{ syncStatus }}</span>
            </div>
            <button
              v-if="normalizedQuery"
              type="button"
              class="contact-start-id"
              @click="useTypedId"
            >
              使用“{{ normalizedQuery }}”开始聊天
            </button>
            <span v-else class="contact-hint">Enter 选择第一个结果 · Esc 关闭</span>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.contact-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(3, 6, 12, 0.62);
  backdrop-filter: blur(4px);
}

.contact-dialog {
  display: flex;
  flex-direction: column;
  width: min(440px, 100%);
  max-height: min(640px, 82vh);
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  background: var(--popover-bg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.contact-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 18px 12px;
}

.contact-head > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.contact-head strong {
  font-size: 15px;
}

.contact-head span {
  color: var(--muted);
  font-size: 11.5px;
}

.contact-close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
}

.contact-close:hover {
  background: var(--panel-hover);
  color: var(--text);
}

.contact-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 18px 10px;
  padding: 0 10px;
  height: 38px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--panel-elevated);
}

.contact-search:focus-within {
  border-color: var(--accent);
}

.contact-search-icon {
  flex: 0 0 auto;
  color: var(--muted-soft);
}

.contact-search input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 13px;
}

.contact-search input::placeholder {
  color: var(--muted-soft);
}

.contact-spinner {
  display: inline-flex;
  color: var(--muted);
}

.contact-error {
  margin: 0 18px 8px;
  padding: 7px 10px;
  border: 1px solid rgba(251, 191, 36, 0.22);
  border-radius: 9px;
  background: rgba(251, 191, 36, 0.06);
  color: var(--warning-text);
  font-size: 11.5px;
  line-height: 1.5;
}

.contact-results {
  flex: 1;
  min-height: 160px;
  overflow-y: auto;
  padding: 2px 10px 8px;
}

.contact-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  text-align: left;
  transition: background 0.15s ease;
}

.contact-item:hover {
  background: var(--panel-hover);
}

.contact-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  gap: 2px;
}

.contact-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.contact-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
}

.contact-action {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-soft);
  font-size: 11px;
}

.contact-item:hover .contact-action {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--text);
  background: var(--accent-soft);
}

.contact-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 34px 20px;
  color: var(--muted);
  text-align: center;
}

.contact-empty p {
  margin: 0;
  color: var(--text-soft);
  font-size: 12.5px;
  font-weight: 600;
}

.contact-empty span {
  font-size: 11px;
  line-height: 1.6;
}

.contact-empty-icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin-bottom: 4px;
  border: 1px solid var(--border);
  border-radius: 15px;
  background: var(--panel-soft);
  color: var(--muted);
}

.contact-source-note {
  margin: 0 18px 8px;
  color: var(--muted-soft);
  font-size: 10.5px;
  line-height: 1.5;
}

.contact-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  color: var(--muted-soft);
  font-size: 10.5px;
}

.contact-foot-sync {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.contact-sync {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-soft);
  font-size: 11px;
  white-space: nowrap;
}

.contact-sync:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: var(--panel-hover);
  color: var(--text);
}

.contact-sync:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.contact-sync-state {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.contact-sync-state.is-success {
  color: var(--success-text);
}

.contact-sync-state.is-error {
  color: var(--danger-text);
}

.contact-hint {
  flex: 0 0 auto;
  white-space: nowrap;
}

.contact-start-id {
  padding: 6px 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-radius: 8px;
  background: var(--accent-faint);
  color: var(--text-soft);
  font-size: 11px;
}

.contact-enter-active,
.contact-leave-active {
  transition: opacity 0.18s ease;
}

.contact-enter-from,
.contact-leave-to {
  opacity: 0;
}
</style>
