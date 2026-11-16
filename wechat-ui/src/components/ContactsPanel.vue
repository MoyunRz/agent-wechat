<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { wechatApi, WechatApiError } from '../api'
import { userFacingErrorMessage } from '../errors'
import { contactName } from '../format'
import type { AccountSummary, Contact, FriendRequestPreflight, Operation, PendingFriendRequest } from '../types'
import Icon from './Icon.vue'
import ThreadAvatar from './ThreadAvatar.vue'

const props = defineProps<{
  account: AccountSummary
}>()

const emit = defineEmits<{
  select: [contact: Contact]
  startId: [id: string]
}>()

const SYNC_POLL_INTERVAL = 1500
const SYNC_POLL_LIMIT = 80
const SEARCH_DEBOUNCE = 260
// 「新的朋友」由微信同步到本地 profile，面板打开时定时轻量刷新。
const FRIEND_REQUEST_POLL_INTERVAL = 20_000

const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const contacts = ref<Contact[]>([])
const loading = ref(false)
const error = ref('')
const syncing = ref(false)
const syncStatus = ref('')
const syncFailed = ref(false)
const friendRequests = ref<PendingFriendRequest[]>([])
// 干跑校验结果：每个申请人独立记录，避免一个失败影响整列表。
const preflightStates = ref<Record<string, { loading: boolean, result?: FriendRequestPreflight, error?: string }>>({})
let searchTimer: number | null = null
let friendRequestTimer: number | null = null
let requestToken = 0
let syncToken = 0

const normalizedQuery = computed(() => query.value.trim())

// 上游 contact.db 包含群成员、公众号、企业微信等非好友条目。
// localType 非空表示该联系人已被微信服务器的通讯录同步确认（真实好友、系统账号等）；
// 群成员等本地发现的联系人该字段为空。两者结合即可只展示真实好友。
const NON_PERSONAL_CATEGORIES = new Set(['system', 'business', 'openim', 'openimCustomerService', 'group'])

/**
 * 展示集合。严格模式只显示服务器确认的个人联系人；当 profile 里完全
 * 没有 localType 确认条目（daemon 的 ModContact 投影未写官方 local_type 位，
 * 联系人行全部由消息投影创建）时降级为显示所有个人类联系人，
 * 群聊与公众号/企业微信/系统账号仍然排除。
 */
const sortedContacts = computed(() => {
  const personal = contacts.value.filter((contact) => {
    const category = contact.classification?.category ?? 'unknown'
    if (NON_PERSONAL_CATEGORIES.has(category))
      return false
    return !(contact.username ?? '').endsWith('@chatroom')
  })
  const confirmed = personal.filter(contact => contact.localType != null)
  const visible = confirmed.length > 0 ? confirmed : personal
  return visible
    .sort((left, right) => contactName(left).localeCompare(contactName(right), 'zh-Hans-CN'))
})

function requestName(item: PendingFriendRequest): string {
  return item.nickname?.trim() || item.alias?.trim() || item.username || item.id
}

/**
 * 读取「新的朋友」列表。旧版 hub 没有该接口时静默保持空列表，
 * 不影响通讯录本身的展示。
 */
async function loadFriendRequests(): Promise<void> {
  try {
    const response = await wechatApi.listFriendRequests(props.account.id)
    friendRequests.value = response.items ?? []
  }
  catch {
    friendRequests.value = []
  }
}

function stateOf(item: PendingFriendRequest): { loading: boolean, result?: FriendRequestPreflight, error?: string } | undefined {
  return preflightStates.value[item.username]
}

const BLOCKING_LABELS: Record<string, string> = {
  not_pending: '申请已失效',
  encrypt_username_missing: '缺少加密用户名',
  ticket_missing: '缺少确认票据',
  scene_missing: '缺少来源信息',
  already_friends: '你们已经是好友了',
}

function preflightLabel(result: FriendRequestPreflight): string {
  if (result.ready)
    return `参数就绪 · scene ${result.scene ?? '-'}`
  if (!result.found)
    return '申请已失效'
  const reasons = result.blocking.map(reason => BLOCKING_LABELS[reason] ?? reason)
  return reasons.length > 0 ? `暂不可通过：${reasons.join('、')}` : '参数不完整'
}

/** 校验结果的展示文案；没有结果时返回空串，模板据此隐藏。 */
function resultLabel(item: PendingFriendRequest): string {
  const state = stateOf(item)
  if (state?.result)
    return preflightLabel(state.result)
  return state?.error ?? ''
}

function resultClass(item: PendingFriendRequest): string {
  const state = stateOf(item)
  return state?.result?.ready ? 'ready' : 'blocked'
}

/**
 * 干跑校验：只读取本地参数并检查完整性，不向微信服务器发送任何请求。
 * 结果仅用于判断是否具备「通过」条件，本版本不提供真正的通过操作。
 */
async function checkRequest(item: PendingFriendRequest): Promise<void> {
  if (preflightStates.value[item.username]?.loading)
    return
  preflightStates.value = {
    ...preflightStates.value,
    [item.username]: { loading: true },
  }
  try {
    const result = await wechatApi.preflightFriendRequest(props.account.id, item.username)
    preflightStates.value = {
      ...preflightStates.value,
      [item.username]: { loading: false, result },
    }
  }
  catch (value) {
    preflightStates.value = {
      ...preflightStates.value,
      [item.username]: {
        loading: false,
        error: userFacingErrorMessage(value, '检查失败，请稍后重试。'),
      },
    }
  }
}

function isTerminalState(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function describeError(value: unknown): string {
  if (value instanceof WechatApiError) {
    if (value.status === 409)
      return '请先登录微信并完成同步。'
    return userFacingErrorMessage(value, '读取通讯录失败，请稍后重试。')
  }
  return userFacingErrorMessage(value, '读取通讯录失败，请稍后重试。')
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
    // daemon 单页上限 200：游标翻页拉全量，搜索词由服务端过滤。
    const items: Contact[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const response = await wechatApi.listContacts(props.account.id, normalizedQuery.value, 200, cursor)
      items.push(...(response.items ?? []))
      cursor = response.nextCursor ?? null
      if (!cursor)
        break
    }
    if (token !== requestToken)
      return
    contacts.value = items
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

function scheduleSearch(): void {
  if (searchTimer !== null)
    window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    void loadContacts()
  }, SEARCH_DEBOUNCE)
}

function onQueryInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value
  scheduleSearch()
}

function clearQuery(): void {
  query.value = ''
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer)
    searchTimer = null
  }
  void loadContacts()
}

async function syncContacts(): Promise<void> {
  if (syncing.value || loading.value)
    return
  const token = ++syncToken
  syncing.value = true
  syncFailed.value = false
  syncStatus.value = '正在同步通讯录…'
  try {
    let operation = await wechatApi.syncContacts(props.account.id)
    for (let attempt = 0; attempt < SYNC_POLL_LIMIT && !isTerminalState(operation.state); attempt++) {
      await sleep(SYNC_POLL_INTERVAL)
      if (token !== syncToken)
        return
      operation = await wechatApi.getOperation(props.account.id, operation.id)
    }
    if (token !== syncToken)
      return
    if (!isTerminalState(operation.state)) {
      syncFailed.value = true
      syncStatus.value = '通讯录同步耗时较长，请稍后重新同步。'
      return
    }
    if (operation.state !== 'succeeded') {
      syncFailed.value = true
      syncStatus.value = describeOperationFailure(operation)
      return
    }
    await loadContacts()
    void loadFriendRequests()
    syncStatus.value = '通讯录同步完成'
    window.setTimeout(() => {
      if (syncStatus.value === '通讯录同步完成')
        syncStatus.value = ''
    }, 2500)
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

function startWithQuery(): void {
  const id = normalizedQuery.value
  if (id)
    emit('startId', id)
}

function focusSearch(): void {
  searchInput.value?.focus()
}

defineExpose({ focusSearch })

onMounted(() => {
  void loadContacts()
  void loadFriendRequests()
  friendRequestTimer = window.setInterval(() => {
    void loadFriendRequests()
  }, FRIEND_REQUEST_POLL_INTERVAL)
})

onBeforeUnmount(() => {
  if (searchTimer !== null)
    window.clearTimeout(searchTimer)
  if (friendRequestTimer !== null)
    window.clearInterval(friendRequestTimer)
  syncToken += 1
  requestToken += 1
})
</script>

<template>
  <aside class="contacts-panel">
    <header class="contacts-header">
      <div class="contacts-title-row">
        <div class="contacts-title">
          <h2>通讯录</h2>
          <span class="contact-count">{{ sortedContacts.length }}</span>
        </div>
        <div class="header-actions">
          <button
            class="icon-button"
            type="button"
            title="同步通讯录"
            :disabled="syncing || loading"
            @click="syncContacts"
          >
            <Icon name="refresh" :size="16" :class="{ spin: syncing }" />
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
        placeholder="搜索联系人"
        spellcheck="false"
        @input="onQueryInput"
        @keydown.enter="startWithQuery"
      >
      <button v-if="query" class="clear-button" type="button" title="清空搜索" @click="clearQuery">
        <Icon name="close" :size="12" />
      </button>
    </div>

    <div v-if="syncStatus" class="contacts-status" :class="{ error: syncFailed }">
      {{ syncStatus }}
    </div>
    <div v-if="error" class="contacts-status error">
      {{ error }}
      <button type="button" @click="loadContacts">重试</button>
    </div>

    <div class="contacts-scroll scrollbar-thin">
      <section v-if="friendRequests.length > 0" class="friend-requests">
        <h3 class="friend-requests-title">
          新的朋友
          <span class="friend-requests-count">{{ friendRequests.length }}</span>
        </h3>
        <div v-for="item in friendRequests" :key="item.id" class="request-row">
          <ThreadAvatar
            :account-id="account.id"
            :name="requestName(item)"
            :username="item.username"
            :image-url="item.avatar ?? null"
            :size="40"
          />
          <span class="request-main">
            <span class="request-name">{{ requestName(item) }}</span>
            <span class="request-sub">{{ item.greeting || '请求添加你为朋友' }}</span>
            <span v-if="resultLabel(item)" class="request-result" :class="resultClass(item)">
              {{ resultLabel(item) }}
            </span>
          </span>
          <button
            type="button"
            class="request-check"
            :disabled="stateOf(item)?.loading"
            @click="checkRequest(item)"
          >
            {{ stateOf(item)?.loading ? '检查中' : '检查' }}
          </button>
        </div>
      </section>

      <div v-if="loading && sortedContacts.length === 0" class="contacts-skeletons">
        <span v-for="index in 6" :key="index" class="contact-skeleton" />
      </div>

      <template v-else-if="sortedContacts.length > 0">
        <button
          v-for="contact in sortedContacts"
          :key="contact.id"
          type="button"
          class="contact-row"
          @click="emit('select', contact)"
        >
          <ThreadAvatar
            :account-id="account.id"
            :name="contactName(contact)"
            :username="contact.username || contact.id"
            :size="40"
          />
          <span class="contact-main">
            <span class="contact-name">{{ contactName(contact) }}</span>
            <span class="contact-sub">
              {{ contact.username || contact.id }}
              <template v-if="contact.alias && contact.alias !== contact.username"> · {{ contact.alias }}</template>
            </span>
          </span>
          <span class="contact-action">聊天</span>
        </button>
      </template>

      <div v-else class="contacts-empty">
        <span class="empty-icon"><Icon name="contacts" :size="24" /></span>
        <p v-if="normalizedQuery">没有找到匹配的联系人</p>
        <p v-else>通讯录还没有联系人</p>
        <span v-if="normalizedQuery">按 Enter 或点击下方按钮，用该微信号开始聊天。</span>
        <span v-else>同步通讯录后，就能在这里按昵称、备注或微信号查找联系人。</span>
        <button
          v-if="!normalizedQuery"
          type="button"
          class="sync-button"
          :disabled="syncing"
          @click="syncContacts"
        >
          <Icon name="refresh" :size="14" :class="{ spin: syncing }" />
          {{ syncing ? '同步中' : '同步通讯录' }}
        </button>
      </div>
    </div>

    <footer v-if="normalizedQuery" class="contacts-footer">
      <button type="button" class="start-id-button" @click="startWithQuery">
        <Icon name="message" :size="14" />
        用「{{ normalizedQuery }}」开始聊天
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.contacts-panel {
  display: flex;
  flex-direction: column;
  width: 284px;
  min-width: 248px;
  height: 100%;
  border-right: 1px solid var(--border);
  background: var(--sidebar-sheen), var(--panel);
}

.contacts-header {
  padding: 16px 14px 10px;
}

.contacts-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.contacts-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.contacts-title h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.contact-count {
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
  flex: 0 0 auto;
  color: var(--muted-soft);
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

.contacts-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 12px 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-soft);
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
}

.contacts-status.error {
  border-color: rgba(248, 113, 113, 0.22);
  background: rgba(248, 113, 113, 0.06);
  color: var(--danger-text);
}

.contacts-status button {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 11px;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.contacts-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 6px 12px;
}

.contact-row {
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

.contact-row:hover {
  background: var(--panel-hover);
}

.contact-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  gap: 2px;
}

.contact-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
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
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 10.5px;
  opacity: 0;
  transition: opacity 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.contact-row:hover .contact-action {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--text);
  opacity: 1;
}

.friend-requests {
  margin: 2px 2px 10px;
  padding: 6px 0 4px;
  border-bottom: 1px solid var(--border);
}

.friend-requests-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0 6px 6px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.friend-requests-count {
  color: var(--danger);
  font-variant-numeric: tabular-nums;
}

.request-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 8px;
  border-radius: 12px;
}

.request-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  gap: 2px;
}

.request-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
}

.request-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
}

.request-result {
  font-size: 10.5px;
  line-height: 1.4;
}

.request-result.ready {
  color: var(--accent-strong, var(--accent));
}

.request-result.blocked {
  color: var(--muted-soft);
}

.request-check {
  flex: 0 0 auto;
  align-self: center;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.request-check:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--text);
}

.request-check:disabled {
  opacity: 0.55;
}

.contacts-skeletons {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 2px;
}

.contact-skeleton {
  height: 54px;
  border-radius: 12px;
  background: var(--panel-soft);
  animation: pulse 1.4s ease-in-out infinite;
}

.contacts-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 260px;
  padding: 24px;
  color: var(--muted);
  text-align: center;
}

.contacts-empty p {
  margin: 0;
  color: var(--text-soft);
  font-size: 14px;
  font-weight: 600;
}

.contacts-empty span {
  font-size: 11.5px;
  line-height: 1.55;
}

.empty-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: 4px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel-soft);
  color: var(--muted);
}

.sync-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 6px 13px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-soft);
  color: var(--text-soft);
  font-size: 11.5px;
  transition: background 0.16s ease;
}

.sync-button:hover:not(:disabled) {
  background: var(--panel-hover);
}

.contacts-footer {
  flex: 0 0 auto;
  padding: 9px 12px 12px;
  border-top: 1px solid var(--border);
}

.start-id-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-radius: 10px;
  background: var(--accent-faint);
  color: var(--text-soft);
  font-size: 11.5px;
  transition: background 0.16s ease;
}

.start-id-button:hover {
  background: var(--accent-soft);
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.95; }
}
</style>
