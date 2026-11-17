<script setup lang="ts">
import { computed, ref } from 'vue'
import { wechatApi } from '../api'
import { connectionLabel, connectionTone } from '../format'
import type { AccountSettings, AccountSummary, ProactiveCacheKinds, RailView, ThemeMode, UiTheme } from '../types'
import Icon from './Icon.vue'
import ThreadAvatar from './ThreadAvatar.vue'

const props = defineProps<{
  account: AccountSummary
  accountName: string
  view: RailView
  accountRefreshing: boolean
  loggingOut: boolean
  offlineToggling: boolean
  themes: UiTheme[]
  themeId: string
  themeMode: ThemeMode
  bubbleFontSize: number
  bubbleInColor: string
  bubbleOutColor: string
  toastDurationMs: number
  toastEnabled: boolean
  /** 全部会话未读总数；离开聊天视图时显示在聊天图标上。 */
  unreadTotal?: number
  /** 待处理好友申请数；离开通讯录视图时显示在通讯录图标上。 */
  friendRequestCount?: number
}>()

const emit = defineEmits<{
  'update:view': [value: RailView]
  'update:themeId': [value: string]
  'update:themeMode': [value: ThemeMode]
  'update:bubbleFontSize': [value: number]
  'update:bubbleInColor': [value: string]
  'update:bubbleOutColor': [value: string]
  'update:toastDurationMs': [value: number]
  'update:toastEnabled': [value: boolean]
  refreshAccount: []
  logout: []
  toggleOffline: [enabled: boolean]
}>()

const incomingPresets = ['#eef1f6', '#ffffff', '#e8f1ff', '#e9f7ef', '#f1ecff', '#1a212c']
const outgoingPresets = ['#2f7cf6', '#22c55e', '#8b5cf6', '#f97316', '#f43f5e']

const activeTheme = computed(() => {
  return props.themes.find(theme => theme.id === props.themeId) ?? props.themes[0]
})

const incomingPreview = computed(() => {
  return props.bubbleInColor || (props.themeMode === 'light' ? '#ffffff' : '#1a212c')
})

const outgoingPreview = computed(() => {
  return props.bubbleOutColor || activeTheme.value?.accent || '#2f7cf6'
})

function onBubbleColorInput(kind: 'in' | 'out', event: Event): void {
  const value = (event.target as HTMLInputElement).value
  if (kind === 'in')
    emit('update:bubbleInColor', value)
  else
    emit('update:bubbleOutColor', value)
}

const accountMenuOpen = ref(false)
const settingsOpen = ref(false)

const accountLabel = computed(() => {
  // 使用登录后的微信昵称；账号槽位别名（Vane-n-test）不在界面上展示。
  return props.accountName?.trim() || '微信'
})

const tone = computed(() => connectionTone(props.account.connection, props.account.authenticated))

function openChats(): void {
  emit('update:view', 'chats')
}

function openContacts(): void {
  emit('update:view', 'contacts')
}

function toggleAccountMenu(): void {
  settingsOpen.value = false
  accountMenuOpen.value = !accountMenuOpen.value
}

function toggleSettings(): void {
  accountMenuOpen.value = false
  settingsOpen.value = !settingsOpen.value
  // 打开时按需拉取账号级缓存设置（仅首次）。
  if (settingsOpen.value)
    void ensureCacheSettings()
}

function closeMenus(): void {
  accountMenuOpen.value = false
  settingsOpen.value = false
}

function refreshAccount(): void {
  accountMenuOpen.value = false
  emit('refreshAccount')
}

function logout(): void {
  accountMenuOpen.value = false
  emit('logout')
}

function toggleOffline(): void {
  emit('toggleOffline', !props.account.offlineMode)
}

function onFontSizeInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value))
    emit('update:bubbleFontSize', value)
}

const toastSeconds = computed(() => Math.round(props.toastDurationMs / 1000))

function onToastDurationInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value))
    emit('update:toastDurationMs', Math.round(value * 1000))
}

/** 徽标文案：超过 99 显示 99+。 */
function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}

// —— 媒体缓存：主动缓存开关 + 按时间清理（daemon 账号设置与派生缓存） ——
const CACHE_KIND_ITEMS: ReadonlyArray<{ key: keyof ProactiveCacheKinds, label: string, hint: string }> = [
  { key: 'image', label: '图片', hint: '收到的图片' },
  { key: 'sticker', label: '表情', hint: '表情与贴纸' },
  { key: 'file', label: '文件', hint: '收到的文件' },
  { key: 'video', label: '视频', hint: '收到的视频' },
  { key: 'voice', label: '语音', hint: '语音消息' },
]

const CACHE_AGE_OPTIONS: ReadonlyArray<{ label: string, seconds: number | null }> = [
  { label: '24 小时', seconds: 24 * 3600 },
  { label: '3 天', seconds: 3 * 24 * 3600 },
  { label: '7 天', seconds: 7 * 24 * 3600 },
  { label: '14 天', seconds: 14 * 24 * 3600 },
  { label: '30 天', seconds: 30 * 24 * 3600 },
  { label: '全部', seconds: null },
]

const DEFAULT_PROACTIVE: ProactiveCacheKinds = { image: true, sticker: true, file: true, video: true, voice: true }

const cacheSettings = ref<AccountSettings | null>(null)
const cacheLoading = ref(false)
const cacheSavingKey = ref<string | null>(null)
const cacheError = ref('')
const purging = ref(false)
const purgeResult = ref('')

/** 打开设置面板时按需拉取一次账号设置；失败只显示错误，不打断其它设置项。 */
async function ensureCacheSettings(): Promise<void> {
  if (cacheSettings.value || cacheLoading.value)
    return
  cacheLoading.value = true
  cacheError.value = ''
  try {
    const settings = await wechatApi.getAccountSettings(props.account.id)
    cacheSettings.value = settings
    if (!settings.proactiveCache) {
      cacheSettings.value = { ...settings, proactiveCache: DEFAULT_PROACTIVE }
    }
  }
  catch (error) {
    cacheError.value = error instanceof Error ? error.message : '读取设置失败'
  }
  finally {
    cacheLoading.value = false
  }
}

/** 乐观更新一处开关；保存失败回滚并提示。 */
async function toggleCacheKind(key: keyof ProactiveCacheKinds): Promise<void> {
  const settings = cacheSettings.value
  const current = settings?.proactiveCache
  if (!settings || !current || cacheSavingKey.value || cacheLoading.value)
    return
  const next: ProactiveCacheKinds = { ...current, [key]: !current[key] }
  cacheSettings.value = { ...settings, proactiveCache: next }
  cacheSavingKey.value = key
  cacheError.value = ''
  try {
    await wechatApi.updateAccountSettings(props.account.id, {
      autoDownloadMaxBytes: settings.autoDownloadMaxBytes,
      proactiveCache: next,
    })
  }
  catch (error) {
    cacheSettings.value = { ...settings, proactiveCache: current }
    cacheError.value = error instanceof Error ? error.message : '保存失败'
  }
  finally {
    cacheSavingKey.value = null
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** 清理当前账号的派生媒体缓存；confirm 挡住误触，结果用一行文案反馈。 */
async function purgeCache(seconds: number | null): Promise<void> {
  if (purging.value)
    return
  const label = CACHE_AGE_OPTIONS.find(option => option.seconds === seconds)?.label ?? '全部'
  if (!window.confirm(`清理 ${label}之前的媒体缓存？只删除加速缓存文件，不影响聊天记录和收到的消息。`))
    return
  purging.value = true
  purgeResult.value = ''
  cacheError.value = ''
  try {
    const result = await wechatApi.purgeMediaCache(props.account.id, seconds)
    purgeResult.value = result.files > 0
      ? `已清理 ${result.files} 个缓存文件 · ${formatBytes(result.bytes)}`
      : '没有需要清理的缓存'
  }
  catch (error) {
    cacheError.value = error instanceof Error ? error.message : '清理失败'
  }
  finally {
    purging.value = false
  }
}
</script>

<template>
  <nav class="app-rail">
    <button
      type="button"
      class="rail-avatar-button"
      :class="{ active: accountMenuOpen }"
      title="账号信息"
      @click="toggleAccountMenu"
    >
      <ThreadAvatar
        :account-id="account.id"
        :name="accountLabel"
        :username="account.ownUsername"
        :size="38"
      />
      <span class="rail-status" :data-tone="tone" />
    </button>

    <div class="rail-nav">
      <button
        type="button"
        class="rail-button"
        :class="{ active: view === 'chats' }"
        title="聊天"
        @click="openChats"
      >
        <Icon name="message" :size="24" />
        <!-- 进入视图即消失：计数标记只提醒有新内容，不重复列表里的未读红点。 -->
        <span
          v-if="(unreadTotal ?? 0) > 0 && view !== 'chats'"
          class="rail-badge"
        >{{ badgeText(unreadTotal ?? 0) }}</span>
      </button>
      <button
        type="button"
        class="rail-button"
        :class="{ active: view === 'contacts' }"
        title="通讯录"
        @click="openContacts"
      >
        <Icon name="contacts" :size="24" />
        <span
          v-if="(friendRequestCount ?? 0) > 0 && view !== 'contacts'"
          class="rail-badge"
        >{{ badgeText(friendRequestCount ?? 0) }}</span>
      </button>
    </div>

    <div class="rail-bottom">
      <button
        type="button"
        class="rail-button"
        :class="{ active: settingsOpen }"
        title="界面设置"
        @click="toggleSettings"
      >
        <Icon name="settings" :size="19" />
      </button>
    </div>

    <Transition name="fade">
      <div v-if="accountMenuOpen || settingsOpen" class="rail-backdrop" @click="closeMenus" />
    </Transition>

    <Transition name="popover">
      <section v-if="accountMenuOpen" class="rail-popover account-popover">
        <header class="popover-head">
          <ThreadAvatar
            :account-id="account.id"
            :name="accountLabel"
            :username="account.ownUsername"
            :size="40"
          />
          <div class="popover-title">
            <strong>{{ accountLabel }}</strong>
            <span>{{ account.ownUsername ? `@${account.ownUsername}` : '尚未登录' }}</span>
          </div>
          <button type="button" class="popover-close" title="关闭" @click="accountMenuOpen = false">
            <Icon name="close" :size="13" />
          </button>
        </header>

        <div class="popover-body">
          <div class="popover-row">
            <span class="row-label">连接状态</span>
            <span class="row-value" :data-tone="tone">
              <span class="dot" />
              {{ connectionLabel(account.connection, account.authenticated) }}
            </span>
          </div>
          <div class="popover-row">
            <span class="row-label">会话模式</span>
            <span class="row-value">独立 Hub</span>
          </div>
          <div class="popover-row">
            <span class="row-label">离线调试模式</span>
            <span class="row-value" :data-tone="account.offlineMode ? 'pending' : 'offline'">
              <span class="dot" />
              {{ account.offlineMode ? '已开启 · 只读本地缓存' : '未开启' }}
            </span>
          </div>
        </div>

        <div class="popover-actions">
          <button
            type="button"
            class="popover-action"
            :disabled="offlineToggling"
            :title="account.offlineMode ? '关闭后可重新连接微信服务器' : '开启后不请求微信服务器，只读本地缓存，适合调试 UI'"
            @click="toggleOffline"
          >
            <Icon :name="account.offlineMode ? 'refresh' : 'settings'" :size="14" :class="{ spin: offlineToggling }" />
            {{ account.offlineMode ? '关闭离线模式' : '开启离线模式' }}
          </button>
          <button
            type="button"
            class="popover-action"
            :disabled="accountRefreshing || loggingOut"
            @click="refreshAccount"
          >
            <Icon name="refresh" :size="14" :class="{ spin: accountRefreshing }" />
            刷新账号状态
          </button>
          <button
            type="button"
            class="popover-action danger"
            :disabled="loggingOut"
            @click="logout"
          >
            <Icon name="logout" :size="14" :class="{ spin: loggingOut }" />
            退出登录
          </button>
        </div>
      </section>
    </Transition>

    <Transition name="popover">
      <section v-if="settingsOpen" class="rail-popover settings-popover">
        <header class="settings-head">
          <div>
            <strong>界面设置</strong>
            <span>仅影响本机微信界面</span>
          </div>
          <button type="button" class="popover-close" title="关闭" @click="settingsOpen = false">
            <Icon name="close" :size="13" />
          </button>
        </header>

        <div class="settings-section">
          <span class="settings-label">主题模式</span>
          <div class="mode-switch">
            <button
              type="button"
              :class="{ active: themeMode === 'dark' }"
              @click="emit('update:themeMode', 'dark')"
            >
              深色
            </button>
            <button
              type="button"
              :class="{ active: themeMode === 'light' }"
              @click="emit('update:themeMode', 'light')"
            >
              浅色
            </button>
          </div>
        </div>

        <div class="settings-section">
          <span class="settings-label">界面颜色</span>
          <div class="theme-grid">
            <button
              v-for="theme in themes"
              :key="theme.id"
              type="button"
              class="theme-swatch"
              :class="{ active: theme.id === themeId }"
              :style="{ background: theme.bubble }"
              :title="theme.label"
              @click="emit('update:themeId', theme.id)"
            >
              <Icon v-if="theme.id === themeId" name="check" :size="13" />
            </button>
          </div>
        </div>

        <div class="settings-section">
          <span class="settings-label">气泡颜色</span>

          <div class="bubble-color-row">
            <span class="bubble-color-label">对方</span>
            <div class="bubble-color-controls">
              <button
                v-for="color in incomingPresets"
                :key="color"
                type="button"
                class="bubble-swatch"
                :class="{ active: bubbleInColor === color }"
                :style="{ background: color }"
                :title="color"
                @click="emit('update:bubbleInColor', color)"
              />
              <label class="custom-color" title="自定义对方气泡颜色">
                <span class="custom-color-preview" :style="{ background: incomingPreview }" />
                <input type="color" :value="incomingPreview" @input="onBubbleColorInput('in', $event)">
              </label>
              <button
                type="button"
                class="color-auto"
                :class="{ active: !bubbleInColor }"
                @click="emit('update:bubbleInColor', '')"
              >
                自动
              </button>
            </div>
          </div>

          <div class="bubble-color-row">
            <span class="bubble-color-label">我方</span>
            <div class="bubble-color-controls">
              <button
                v-for="color in outgoingPresets"
                :key="color"
                type="button"
                class="bubble-swatch"
                :class="{ active: bubbleOutColor === color }"
                :style="{ background: color }"
                :title="color"
                @click="emit('update:bubbleOutColor', color)"
              />
              <label class="custom-color" title="自定义我方气泡颜色">
                <span class="custom-color-preview" :style="{ background: outgoingPreview }" />
                <input type="color" :value="outgoingPreview" @input="onBubbleColorInput('out', $event)">
              </label>
              <button
                type="button"
                class="color-auto"
                :class="{ active: !bubbleOutColor }"
                @click="emit('update:bubbleOutColor', '')"
              >
                自动
              </button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-row">
            <span class="settings-label">气泡字号</span>
            <span class="settings-value">{{ bubbleFontSize }}px</span>
          </div>
          <input
            class="font-slider"
            type="range"
            min="12"
            max="18"
            step="0.5"
            :value="bubbleFontSize"
            @input="onFontSizeInput"
          >
        </div>

        <div class="settings-section">
          <label class="settings-row settings-toggle">
            <span class="settings-label">新消息提示卡片</span>
            <span
              class="toggle-switch"
              :class="{ on: toastEnabled }"
              role="switch"
              :aria-checked="toastEnabled"
              @click="emit('update:toastEnabled', !toastEnabled)"
            >
              <span class="toggle-knob" />
            </span>
          </label>
        </div>

        <div v-if="toastEnabled" class="settings-section">
          <div class="settings-row">
            <span class="settings-label">新消息卡片消失时间</span>
            <span class="settings-value">{{ toastSeconds }} 秒</span>
          </div>
          <input
            class="font-slider"
            type="range"
            min="2"
            max="30"
            step="1"
            :value="toastSeconds"
            @input="onToastDurationInput"
          >
        </div>

        <!-- 主动缓存：收到对应类型的消息时，daemon 自动下载并缓存，聊天打开即秒出。 -->
        <div class="settings-section">
          <div class="settings-row">
            <span class="settings-label">主动缓存</span>
            <span v-if="cacheLoading" class="settings-value">读取中…</span>
          </div>
          <div class="cache-kind-list">
            <div
              v-for="item in CACHE_KIND_ITEMS"
              :key="item.key"
              class="cache-kind-row"
              :class="{ saving: cacheSavingKey === item.key }"
              role="switch"
              :aria-checked="cacheSettings?.proactiveCache?.[item.key] ?? true"
              tabindex="0"
              @click="toggleCacheKind(item.key)"
              @keydown.enter.prevent="toggleCacheKind(item.key)"
            >
              <span class="cache-kind-text">
                <span class="cache-kind-name">{{ item.label }}</span>
                <span class="cache-kind-hint">{{ item.hint }}</span>
              </span>
              <span
                class="toggle-switch"
                :class="{ on: cacheSettings?.proactiveCache?.[item.key] ?? true }"
              >
                <span class="toggle-knob" />
              </span>
            </div>
          </div>
          <span v-if="cacheError" class="cache-error">{{ cacheError }}</span>
        </div>

        <!-- 缓存清理：删除派生加速缓存文件（按最后使用时间），不动聊天记录。 -->
        <div class="settings-section">
          <span class="settings-label">清理媒体缓存</span>
          <div class="cache-purge-grid">
            <button
              v-for="option in CACHE_AGE_OPTIONS"
              :key="option.label"
              type="button"
              class="cache-purge-btn"
              :disabled="purging"
              @click="purgeCache(option.seconds)"
            >
              {{ option.label }}
            </button>
          </div>
          <span v-if="purgeResult" class="cache-purge-result">{{ purgeResult }}</span>
          <span v-if="purging" class="settings-value">清理中…</span>
        </div>
      </section>
    </Transition>
  </nav>
</template>

<style scoped>
.app-rail {
  position: relative;
  z-index: 20;
  display: flex;
  flex: 0 0 64px;
  flex-direction: column;
  align-items: center;
  width: 64px;
  padding: 14px 0 12px;
  border-right: 1px solid var(--border);
  background: var(--rail-bg);
}

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rail-button {
  position: relative;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: var(--muted);
  transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}

.rail-button:hover:not(:disabled) {
  background: var(--panel-hover);
  color: var(--text-soft);
}

.rail-button.active {
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 26%, transparent);
}

.rail-button.active::before {
  content: '';
  position: absolute;
  top: 50%;
  left: -11px;
  width: 3px;
  height: 18px;
  border-radius: 999px;
  background: var(--accent);
  transform: translateY(-50%);
}

.rail-button:disabled {
  opacity: 0.55;
}

/* 导航计数标记：新消息/新朋友申请提醒，进入对应视图后消失。 */
.rail-badge {
  position: absolute;
  top: 3px;
  right: 3px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: #f43f5e;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2px var(--rail-bg);
  pointer-events: none;
}

.rail-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-top: auto;
}

.rail-avatar-button {
  position: relative;
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin-bottom: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  transition: transform 0.16s ease;
}

.rail-avatar-button:hover {
  transform: translateY(-1px);
}

.rail-avatar-button.active {
  box-shadow: 0 0 0 2px var(--accent);
}

.rail-status {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 10px;
  height: 10px;
  border: 2px solid var(--rail-bg);
  border-radius: 50%;
  background: var(--muted-soft);
}

.rail-status[data-tone="online"] {
  background: var(--success);
}

.rail-status[data-tone="pending"] {
  background: var(--warning);
}

.rail-backdrop {
  position: fixed;
  inset: 0;
  z-index: 25;
}

.rail-popover {
  position: absolute;
  bottom: 60px;
  left: 56px;
  z-index: 30;
  width: 258px;
  padding: 14px;
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: var(--popover-bg);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px);
}

/* 账号入口在栏顶：账号弹窗从顶部展开，设置弹窗保持底部。 */
.account-popover {
  top: 62px;
  bottom: auto;
}

/* 设置面板加宽 5%，容纳更长的设置项文案 */
.settings-popover {
  width: 271px;
}

.popover-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.popover-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  gap: 2px;
}

.popover-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.popover-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
}

.popover-close {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
}

.popover-close:hover {
  background: var(--panel-hover);
  color: var(--text);
}

.popover-body {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 0;
}

.popover-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 11.5px;
}

.row-label {
  color: var(--muted);
}

.row-value {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-soft);
}

.row-value[data-tone="online"] {
  color: var(--success-text);
}

.row-value[data-tone="pending"] {
  color: var(--warning);
}

.row-value .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.popover-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.popover-action {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-soft);
  color: var(--text-soft);
  font-size: 12px;
  transition: background 0.16s ease;
}

.popover-action:hover:not(:disabled) {
  background: var(--panel-hover);
}

.popover-action.danger {
  border-color: rgba(248, 113, 113, 0.22);
  color: var(--danger-text);
  background: rgba(248, 113, 113, 0.06);
}

.popover-action.danger:hover:not(:disabled) {
  background: rgba(248, 113, 113, 0.12);
}

.settings-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.settings-head > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-head strong {
  font-size: 13px;
}

.settings-head span {
  color: var(--muted);
  font-size: 11px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding-top: 13px;
}

.settings-label {
  color: var(--text-soft);
  font-size: 11.5px;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.settings-toggle {
  cursor: pointer;
  user-select: none;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: var(--panel-soft);
  border: 1px solid var(--border);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.toggle-switch .toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-soft);
  transition: transform 0.15s ease, background 0.15s ease;
}

.toggle-switch.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.toggle-switch.on .toggle-knob {
  transform: translateX(14px);
  background: var(--accent);
}

.mode-switch {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-soft);
}

.mode-switch button {
  flex: 1;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
  transition: background 0.16s ease, color 0.16s ease;
}

.mode-switch button.active {
  background: var(--panel-elevated);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.bubble-color-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bubble-color-label {
  flex: 0 0 24px;
  color: var(--muted);
  font-size: 11px;
}

.bubble-color-controls {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.bubble-swatch {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.14);
  transition: transform 0.16s ease, border-color 0.16s ease;
}

.bubble-swatch:hover {
  transform: scale(1.08);
}

.bubble-swatch.active {
  border-color: var(--text);
}

.custom-color {
  position: relative;
  display: block;
  width: 24px;
  height: 24px;
  padding: 2px;
  border-radius: 50%;
  background: conic-gradient(#f43f5e, #f97316, #22c55e, #2f7cf6, #8b5cf6, #f43f5e);
  cursor: pointer;
}

.custom-color-preview {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.16);
}

.custom-color input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.color-auto {
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 10.5px;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}

.color-auto.active {
  border-color: var(--accent);
  background: var(--accent-faint);
  color: var(--text);
}

.settings-value {
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.theme-grid {
  display: flex;
  align-items: center;
  gap: 9px;
}

.theme-swatch {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  color: #fff;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
  transition: transform 0.16s ease, border-color 0.16s ease;
}

.theme-swatch:hover {
  transform: scale(1.08);
}

.theme-swatch.active {
  border-color: var(--text);
}

.font-slider {
  width: 100%;
  accent-color: var(--accent);
}

/* 媒体缓存：主动缓存开关行 + 清理按钮组 */
.cache-kind-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: -3px;
  padding: 2px;
  border-radius: 10px;
}

.cache-kind-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 9px;
  cursor: pointer;
  user-select: none;
  transition: background 0.14s ease, opacity 0.14s ease;
}

.cache-kind-row:hover,
.cache-kind-row:focus-visible {
  background: var(--panel-hover);
  outline: none;
}

.cache-kind-row.saving {
  opacity: 0.55;
  pointer-events: none;
}

.cache-kind-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.cache-kind-name {
  color: var(--text-soft);
  font-size: 11.5px;
}

.cache-kind-hint {
  color: var(--muted);
  font-size: 10px;
}

.cache-error {
  color: var(--danger-text, #f87171);
  font-size: 10.5px;
}

.cache-purge-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.cache-purge-btn {
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-soft);
  color: var(--text-soft);
  font-size: 11px;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.cache-purge-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--danger-text, #f87171) 35%, transparent);
  color: var(--danger-text, #f87171);
  background: rgba(248, 113, 113, 0.08);
}

.cache-purge-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.cache-purge-result {
  color: var(--muted);
  font-size: 10.5px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.16s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.popover-enter-active,
.popover-leave-active {
  transition: opacity 0.16s ease, transform 0.18s ease;
}

.popover-enter-from,
.popover-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
