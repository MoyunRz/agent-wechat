<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { wechatApi, WechatApiError } from '../api'
import { userFacingErrorMessage } from '../errors'
import { contactName } from '../format'
import type { AccountSummary, Contact, FriendRequestPreflight, Operation, PendingFriendRequest } from '../types'
import Icon from './Icon.vue'
import ThreadAvatar from './ThreadAvatar.vue'

const props = defineProps<{
  account: AccountSummary
  /** 登录后台预载的全量通讯录；进入面板时直接秒开，无需再等网络。 */
  preloadedContacts?: Contact[]
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
const personalContacts = computed(() => {
  const personal = contacts.value.filter((contact) => {
    const category = contact.classification?.category ?? 'unknown'
    if (NON_PERSONAL_CATEGORIES.has(category))
      return false
    return !(contact.username ?? '').endsWith('@chatroom')
  })
  const confirmed = personal.filter(contact => contact.localType != null)
  return confirmed.length > 0 ? confirmed : personal
})

/**
 * 目录分类（对齐官方客户端语义）：business 分类按 businessKind 拆分——
 * 订阅号展示为「公众号」，服务号单独一组；@openim 企业客服归「企业微信联系人」，
 * 不再单设「小程序客服」分组。无 businessKind 的 gh_ 兜底进公众号组。
 */
const officialContacts = computed(() => {
  return contacts.value.filter((contact) => {
    if ((contact.username ?? '').startsWith('gh_'))
      return (contact.classification?.businessKind ?? 'official_account') === 'official_account'
    return false
  })
})

const serviceContacts = computed(() => {
  return contacts.value.filter((contact) => {
    const classification = contact.classification
    if (classification?.category !== 'business')
      return false
    if ((contact.username ?? '').startsWith('gh_'))
      return classification.businessKind == null
        || classification.businessKind === 'service_account'
    // wxid 企业客服号（美团等）在目录里同样是 service_account。
    return classification.businessKind === 'service_account'
  })
})

/**
 * 企业微信联系人：只显示被微信服务器通讯录同步确认的条目。
 * @openim 客服号大多是被群聊/小程序触达后微信自动写入本地目录的单向条目
 * （localType 为空），从未加过好友，不应出现在通讯录；全组无确认条目时整组隐藏。
 */
const wecomContacts = computed(() => {
  const all = contacts.value.filter(contact =>
    ['openim', 'openimCustomerService'].includes(contact.classification?.category ?? '')
    || (contact.username ?? '').endsWith('@openim'))
  return all.filter(contact => contact.localType != null)
})

const systemContacts = computed(() => contacts.value.filter(contact =>
  contact.classification?.category === 'system'))

/**
 * 联系人显示名：企业微信客服（@openim）资料常缺失——昵称为空或直接回填原始 ID，
 * 此时兜底为「企业微信客服」而不是暴露一串数字。
 */
function openimContactName(contact: Contact): string {
  const peer = contact.username || contact.id || ''
  if (!peer.endsWith('@openim'))
    return contactName(contact)
  const name = contact.remark?.trim()
    || contact.nickname?.trim()
    || contact.displayName?.trim()
    || ''
  if (!name || name === peer)
    return '企业微信客服'
  return name
}

/** 同名条目计数：企业客服常见同一应用多个客服席位共用昵称（真实不同账号）。 */
const openimNameCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const contact of contacts.value) {
    const name = openimContactName(contact)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
})

/** 同昵称的小程序客服多条并列时加 ID 尾部 4 位区分（如「吃喝玩乐福利君 ·51152」）。 */
function contactDisplayName(contact: Contact): string {
  const name = openimContactName(contact)
  const peer = contact.username || contact.id || ''
  if (peer.endsWith('@openim') && (openimNameCounts.value.get(name) ?? 0) > 1) {
    const digits = peer.replace(/\D/g, '')
    if (digits.length >= 4)
      return `${name} ·${digits.slice(-4)}`
  }
  return name
}

/** 排序键与显示名一致：备注 || 昵称 || ID（openim 缺资料时用兜底名），中文按拼音升序。 */
function byName(left: Contact, right: Contact): number {
  return openimContactName(left).localeCompare(openimContactName(right), 'zh-Hans-CN')
}

interface ContactGroup {
  key: string
  label: string
  items: Contact[]
}

const contactGroups = computed<ContactGroup[]>(() => {
  const groups: ContactGroup[] = []
  const push = (key: string, label: string, items: Contact[]) => {
    if (items.length > 0)
      groups.push({ key, label, items: [...items].sort(byName) })
  }
  push('personal', '联系人', personalContacts.value)
  push('official', '公众号', officialContacts.value)
  push('service', '服务号', serviceContacts.value)
  push('wecom', '企业微信联系人', wecomContacts.value)
  push('system', '系统账号', systemContacts.value)
  return groups
})

/** 搜索时服务端已跨分类过滤：平铺全部匹配项。 */
const searchResults = computed(() => [...contacts.value].sort(byName))

/** 折叠展开状态：联系人默认展开，其余分类收起（对齐 Linux 客户端）。 */
const expandedGroups = ref<Record<string, boolean>>({
  personal: true,
  official: false,
  service: false,
  wecom: false,
  system: false,
})

function isGroupExpanded(key: string): boolean {
  return expandedGroups.value[key] ?? false
}

function toggleGroup(key: string): void {
  expandedGroups.value[key] = !isGroupExpanded(key)
}

interface DisplayRow {
  key: string
  contact?: Contact
  nested?: boolean
  group?: { key: string, label: string, count: number }
}

const displayRows = computed<DisplayRow[]>(() => {
  if (normalizedQuery.value)
    return searchResults.value.map(contact => ({ key: contact.id, contact }))
  const rows: DisplayRow[] = []
  for (const group of contactGroups.value) {
    rows.push({ key: `group:${group.key}`, group: { key: group.key, label: group.label, count: group.items.length } })
    if (isGroupExpanded(group.key)) {
      for (const contact of group.items)
        rows.push({ key: contact.id, contact, nested: true })
    }
  }
  return rows
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
  already_handled: '申请已处理',
  encrypt_username_missing: '缺少加密用户名',
  ticket_missing: '缺少确认票据',
  missing_scene: '缺少来源信息，请在手机上处理',
  already_friends: '你们已经是好友了',
  gate_closed: '通过开关未开启',
}

/** 好友申请来源（verifyuser scene）映射；未知值回退为 scene 编号。 */
const SCENE_LABELS: Record<number, string> = {
  3: '通过微信号搜索',
  12: '通过 QQ 号添加',
  14: '通过群聊添加',
  15: '通过手机号搜索',
  25: '通过好友名片添加',
  30: '通过二维码添加',
  33: '通过通讯录添加',
}

function sceneLabel(item: PendingFriendRequest): string {
  const scene = item.scene
  if (scene == null)
    return '来源未知'
  return SCENE_LABELS[scene] ?? `来源 scene ${scene}`
}

function formatRequestTime(value: string | null | undefined): string {
  if (!value)
    return '未知'
  const time = new Date(value)
  if (Number.isNaN(time.getTime()))
    return value
  return time.toLocaleString('zh-CN', { hour12: false })
}

function preflightLabel(result: FriendRequestPreflight): string {
  if (result.ready)
    return '申请可处理'
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
 * 结果仅用于判断是否具备「通过」条件。
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

/** 通过申请进行中：按申请人记录，避免并发点击。 */
const accepting = ref<Record<string, boolean>>({})

/** 详情弹层当前展示的申请；null 表示关闭。 */
const detailRequest = ref<PendingFriendRequest | null>(null)

function openDetail(item: PendingFriendRequest): void {
  detailRequest.value = item
  if (!stateOf(item))
    void checkRequest(item)
}

function closeDetail(): void {
  detailRequest.value = null
}

function acceptDisabled(item: PendingFriendRequest): boolean {
  if (accepting.value[item.username])
    return true
  const result = stateOf(item)?.result
  // 校验过且确认不可通过时禁用；未校验时保持可用，由服务端兜底校验。
  return result != null && !result.ready && result.found
}

/** 同意/拒绝好友申请：材料由 hub 从落库消息读取，成功后刷新列表与通讯录。 */
async function actOnRequest(item: PendingFriendRequest, action: 'accept' | 'decline'): Promise<void> {
  if (accepting.value[item.username])
    return
  accepting.value = { ...accepting.value, [item.username]: true }
  const failing = action === 'accept' ? '通过好友申请失败，请稍后重试。' : '拒绝好友申请失败，请稍后重试。'
  try {
    let operation = action === 'accept'
      ? await wechatApi.acceptFriendRequest(props.account.id, item.username)
      : await wechatApi.declineFriendRequest(props.account.id, item.username)
    for (let attempt = 0; attempt < SYNC_POLL_LIMIT && !isTerminalState(operation.state); attempt++) {
      await sleep(SYNC_POLL_INTERVAL)
      operation = await wechatApi.getOperation(props.account.id, operation.id)
    }
    if (!isTerminalState(operation.state))
      throw new WechatApiError('操作耗时较长，请稍后重试。', 0)
    if (operation.state !== 'succeeded')
      throw new WechatApiError('操作未成功，请稍后重试。', 0)
    preflightStates.value = { ...preflightStates.value, [item.username]: { loading: false } }
    detailRequest.value = null
    await Promise.all([loadContacts(), loadFriendRequests()])
  }
  catch (value) {
    preflightStates.value = {
      ...preflightStates.value,
      [item.username]: {
        loading: false,
        error: userFacingErrorMessage(value, failing),
      },
    }
  }
  finally {
    accepting.value = { ...accepting.value, [item.username]: false }
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

async function loadContacts(force = false): Promise<void> {
  // 无搜索词时优先用登录后预载的全量目录：面板秒开，不重复拉网络。
  // 搜索、手动同步（force）仍走服务端以拿到过滤/最新结果。
  if (!normalizedQuery.value && !force && props.preloadedContacts?.length) {
    contacts.value = [...props.preloadedContacts]
    loading.value = false
    error.value = ''
    return
  }
  const token = ++requestToken
  loading.value = true
  error.value = ''
  try {
    // daemon 单页上限 200：游标翻页拉全量，搜索词由服务端过滤。
    // 每页到达即渲染：通讯录有数千条时首屏 ~1s 出内容，其余页面渐进填充。
    let cursor: string | null = null
    const loaded: Contact[] = []
    for (let page = 0; page < 10; page++) {
      const response = await wechatApi.listContacts(props.account.id, normalizedQuery.value, 200, cursor)
      cursor = response.nextCursor ?? null
      if (token !== requestToken)
        return
      loaded.push(...(response.items ?? []))
      // 赋新数组触发响应式更新；骨架屏条件为「加载中且无数据」，首页到达即消失。
      contacts.value = [...loaded]
      if (page === 0)
        loading.value = false
      if (!cursor)
        break
    }
  }
  catch (value) {
    if (token !== requestToken)
      return
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
    await loadContacts(true)
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

// 后台预载目录刷新（如单条资料权威刷新）时，无搜索的默认列表跟随更新。
watch(() => props.preloadedContacts, (value) => {
  if (!normalizedQuery.value && value?.length)
    contacts.value = [...value]
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
          <span class="contact-count">{{ personalContacts.length }}</span>
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
      <button type="button" @click="loadContacts()">重试</button>
    </div>

    <div class="contacts-scroll scrollbar-thin">
      <section v-if="friendRequests.length > 0" class="friend-requests">
        <h3 class="friend-requests-title">
          新的朋友
          <span class="friend-requests-count">{{ friendRequests.length }}</span>
        </h3>
        <div v-for="item in friendRequests" :key="item.id" class="request-row">
          <button
            type="button"
            class="request-open"
            title="查看申请详情"
            @click="openDetail(item)"
          >
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
            </span>
          </button>
          <span class="request-actions">
            <button
              type="button"
              class="request-accept"
              @click="openDetail(item)"
            >
              查看
            </button>
          </span>
        </div>
      </section>

      <div v-if="loading && contacts.length === 0" class="contacts-skeletons">
        <span v-for="index in 6" :key="index" class="contact-skeleton" />
      </div>

      <template v-else-if="displayRows.length > 0">
        <template v-for="row in displayRows" :key="row.key">
          <button
            v-if="row.group"
            type="button"
            class="group-header"
            @click="toggleGroup(row.group.key)"
          >
            <Icon
              name="chevron-down"
              :size="14"
              class="group-chevron"
              :class="{ open: isGroupExpanded(row.group.key) }"
            />
            <span class="group-label">{{ row.group.label }}</span>
            <span class="group-count">{{ row.group.count }}</span>
          </button>

          <button
            v-else
            type="button"
            class="contact-row"
            :class="{ nested: row.nested }"
            @click="emit('select', row.contact!)"
          >
            <ThreadAvatar
              :account-id="account.id"
              :name="contactDisplayName(row.contact!)"
              :username="row.contact!.username || row.contact!.id"
              :size="40"
            />
            <span class="contact-main">
              <span class="contact-name">{{ contactDisplayName(row.contact!) }}</span>
              <span v-if="row.contact!.alias" class="contact-sub">{{ row.contact!.alias }}</span>
            </span>
            <span class="contact-action">聊天</span>
          </button>
        </template>
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

    <div v-if="detailRequest" class="request-overlay" @click.self="closeDetail">
      <div class="request-detail" role="dialog" aria-modal="true">
        <button type="button" class="detail-close" title="关闭" @click="closeDetail">
          <Icon name="close" :size="14" />
        </button>
        <div class="detail-head">
          <ThreadAvatar
            :account-id="account.id"
            :name="requestName(detailRequest)"
            :username="detailRequest.username"
            :image-url="detailRequest.avatar ?? null"
            :size="72"
          />
          <div class="detail-id">
            <span class="detail-name">{{ requestName(detailRequest) }}</span>
            <span class="detail-source">{{ sceneLabel(detailRequest) }}</span>
          </div>
        </div>
        <div class="detail-body">
          <div v-if="detailRequest.greeting" class="detail-greeting">
            <span class="detail-label">申请消息</span>
            <p>{{ detailRequest.greeting }}</p>
          </div>
          <div class="detail-meta">
            <span class="detail-label">申请时间</span>
            <span>{{ formatRequestTime(detailRequest.createdAt) }}</span>
          </div>
          <div v-if="stateOf(detailRequest)" class="detail-status" :class="resultClass(detailRequest)">
            {{ resultLabel(detailRequest) }}
          </div>
        </div>
        <div class="detail-actions">
          <button
            type="button"
            class="detail-decline"
            :disabled="acceptDisabled(detailRequest)"
            @click="actOnRequest(detailRequest, 'decline')"
          >
            {{ accepting[detailRequest.username] ? '处理中' : '拒绝' }}
          </button>
          <button
            type="button"
            class="request-accept"
            :disabled="acceptDisabled(detailRequest)"
            @click="actOnRequest(detailRequest, 'accept')"
          >
            {{ accepting[detailRequest.username] ? '处理中' : '同意' }}
          </button>
        </div>
      </div>
    </div>
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

/* 目录分类折叠：对齐 Linux 客户端的分组头部（箭头 + 名称 + 数量）。 */
.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 10px;
  padding: 7px 8px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  transition: background 0.15s ease;
}

.group-header:hover {
  background: var(--panel-hover);
}

.group-chevron {
  flex: 0 0 auto;
  color: var(--muted);
  transition: transform 0.18s ease;
}

.group-chevron.open {
  transform: rotate(180deg);
}

.group-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-soft);
  font-size: 12.5px;
  font-weight: 600;
}

.group-count {
  flex: 0 0 auto;
  color: var(--muted-soft);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.contact-row.nested {
  padding-left: 26px;
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

.request-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: 10px;
}

.request-open:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

.request-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.request-accept {
  flex: 0 0 auto;
  align-self: center;
  padding: 4px 12px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-contrast, #fff);
  font-size: 11px;
  font-weight: 500;
  transition: opacity 0.15s ease, filter 0.15s ease;
}

.request-accept:hover:not(:disabled) {
  filter: brightness(1.08);
}

.request-accept:disabled {
  opacity: 0.5;
}

.request-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 45%);
  backdrop-filter: blur(6px);
}

.request-detail {
  position: relative;
  width: 320px;
  padding: 22px;
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  background: var(--popover-bg);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px);
  animation: detail-in 0.18s ease;
}

@keyframes detail-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.detail-close {
  position: absolute;
  top: 12px;
  right: 12px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 50%;
  background: var(--panel-hover);
  color: var(--muted);
  cursor: pointer;
}

.detail-close:hover {
  color: var(--text);
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-right: 28px;
}

.detail-id {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.detail-name {
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-source {
  color: var(--muted);
  font-size: 12px;
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 18px;
}

.detail-greeting {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--panel-hover);
}

.detail-greeting p {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-soft);
  word-break: break-word;
}

.detail-label {
  display: block;
  color: var(--muted-soft);
  font-size: 11px;
}

.detail-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--text-soft);
}

.detail-meta .detail-label {
  flex: 0 0 auto;
}

.detail-status {
  font-size: 12px;
}

.detail-status.ready {
  color: var(--text-soft);
}

.detail-status.blocked {
  color: var(--muted-soft);
}

.detail-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}

.detail-actions button {
  flex: 1;
  padding: 9px 0;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s ease, filter 0.15s ease;
}

.detail-decline {
  border: 1px solid rgba(229, 72, 77, 0.55);
  background: transparent;
  color: #e5484d;
}

.detail-decline:hover:not(:disabled) {
  background: rgba(229, 72, 77, 0.14);
  border-color: rgba(229, 72, 77, 0.75);
}

.detail-actions .request-accept {
  padding: 9px 0;
  border-radius: 12px;
  font-size: 13px;
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
