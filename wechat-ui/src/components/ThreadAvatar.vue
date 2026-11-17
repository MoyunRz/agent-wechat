<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { wechatApi } from '../api'
import { initials } from '../format'
import { specialAvatarBackground, specialAvatarFor } from '../special-avatars'
import type { ThreadAvatarMember } from '../types'

const props = withDefaults(defineProps<{
  accountId: string
  name: string
  username?: string | null
  kind?: string
  members?: ThreadAvatarMember[]
  size?: number
  /** 直接给定的头像 URL（如好友申请 XML 自带），优先于 hub 头像端点。 */
  imageUrl?: string | null
}>(), {
  username: null,
  kind: 'direct',
  members: () => [],
  size: 46,
  imageUrl: null,
})

const REFRESH_TTL = 10 * 60 * 1000
const REFRESH_POLL_INTERVAL = 800
const REFRESH_POLL_LIMIT = 40

const refreshJobs = new Map<string, Promise<boolean>>()
const refreshResults = new Map<string, { ok: boolean, at: number }>()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function isTerminal(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired'
}

/** 头像只缓存最近一次刷新结果，避免同一联系人被多个气泡重复触发刷新。 */
function ensureAvatarCached(accountId: string, username: string): Promise<boolean> {
  const key = `${accountId}\n${username}`
  const remembered = refreshResults.get(key)
  if (remembered && Date.now() - remembered.at < REFRESH_TTL)
    return Promise.resolve(remembered.ok)
  const existing = refreshJobs.get(key)
  if (existing)
    return existing
  const job = refreshAvatarOnce(accountId, username)
    .then((ok) => {
      refreshResults.set(key, { ok, at: Date.now() })
      return ok
    })
    .finally(() => {
      refreshJobs.delete(key)
    })
  refreshJobs.set(key, job)
  return job
}

async function refreshAvatarOnce(accountId: string, username: string): Promise<boolean> {
  try {
    let operation = await wechatApi.refreshAvatar(accountId, username)
    for (let attempt = 0; attempt < REFRESH_POLL_LIMIT && !isTerminal(operation.state); attempt++) {
      await sleep(REFRESH_POLL_INTERVAL)
      operation = await wechatApi.getOperation(accountId, operation.id)
    }
    return operation.state === 'succeeded'
  }
  catch {
    return false
  }
}

const failed = ref(false)
const refreshAttempted = ref(false)
const version = ref(0)
const avatarObjectUrl = ref<string | null>(null)
let identityToken = 0
let avatarLoadSeq = 0
let loadRetried = false

const isGroup = computed(() => props.kind === 'group')
const memberList = computed(() => (props.members ?? []).slice(0, 4))
const useGrid = computed(() => isGroup.value && memberList.value.length >= 2)
// 群聊同样加载群头像图片（daemon 头像端点对 group 生效）；无图时回退四宫格。
const avatarIdentity = computed(() => (props.username ?? '').trim())
// 内置系统账号（文件传输助手、微信支付等）使用固定官方风格图标，不请求远端头像。
const special = computed(() => specialAvatarFor(props.username, props.name))
const specialBackground = computed(() => (special.value ? specialAvatarBackground(special.value) : ''))
const showImage = computed(() => Boolean(avatarObjectUrl.value) && !failed.value)

async function loadAvatarBytes(): Promise<void> {
  if (!props.accountId || !avatarIdentity.value || special.value) {
    avatarObjectUrl.value = null
    return
  }
  const seq = ++avatarLoadSeq
  try {
    // 带全局缓存的加载：视图切换/列表重建时直接复用已缓存的 object URL，不再重复请求。
    const url = await wechatApi.loadAvatarCached(props.accountId, avatarIdentity.value, version.value)
    if (seq !== avatarLoadSeq)
      return
    avatarObjectUrl.value = url
    if (!url) {
      // 缓存里还没有头像：向微信请求一次，成功后重取字节。
      failed.value = false
      if (!refreshAttempted.value) {
        refreshAttempted.value = true
        const token = identityToken
        const ok = await ensureAvatarCached(props.accountId, avatarIdentity.value)
        if (token === identityToken && ok) {
          version.value = Date.now()
          void loadAvatarBytes()
        }
      }
      return
    }
    failed.value = false
  }
  catch {
    if (seq !== avatarLoadSeq)
      return
    avatarObjectUrl.value = null
    // 网络抖动/daemon 重启中的瞬时失败不永久卡在字母回退：延时补试一次。
    if (!loadRetried) {
      loadRetried = true
      window.setTimeout(() => {
        if (seq === avatarLoadSeq)
          void loadAvatarBytes()
      }, 4000)
    }
  }
}

/**
 * daemon 重启后的整批头像失效（App 在 SSE 重连时广播）：清零本地状态后重取。
 * 全局头像 blob 缓存已被换成新 epoch，这里重取必然拿到 daemon 最新字节。
 */
function invalidate(): void {
  if (props.imageUrl?.trim() || special.value)
    return
  identityToken += 1
  failed.value = false
  refreshAttempted.value = false
  loadRetried = false
  void loadAvatarBytes()
}

onMounted(() => window.addEventListener('wx-avatars-invalidated', invalidate))
onBeforeUnmount(() => window.removeEventListener('wx-avatars-invalidated', invalidate))

watch(
  () => [props.accountId, avatarIdentity.value, props.imageUrl, special.value],
  () => {
    identityToken += 1
    failed.value = false
    refreshAttempted.value = false
    loadRetried = false
    version.value = 0
    if (special.value) {
      avatarObjectUrl.value = null
      return
    }
    if (props.imageUrl?.trim()) {
      avatarObjectUrl.value = null
      return
    }
    void loadAvatarBytes()
  },
  { immediate: true },
)

function gradientFor(name: string): string {
  let hash = 0
  for (const char of name)
    hash = (hash * 31 + char.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${hash} 58% 42%), hsl(${(hash + 42) % 360} 62% 30%))`
}

const fallbackStyle = computed(() => ({
  // 未识别的内置系统会话沿用紫色头像，普通会话按名称散列配色。
  background: props.kind === 'system'
    ? 'linear-gradient(135deg, #8b5cf6, #6d28d9)'
    : gradientFor(props.name),
}))

function memberInitial(member: ThreadAvatarMember): string {
  return initials(member.displayName || member.id)
}

function memberStyle(member: ThreadAvatarMember): Record<string, string> {
  return { background: gradientFor(member.displayName || member.id) }
}
</script>

<template>
  <div
    class="thread-avatar"
    :class="{ 'is-group': isGroup }"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img
      v-if="showImage"
      :src="avatarObjectUrl ?? undefined"
      alt=""
      draggable="false"
    >
    <div v-else-if="useGrid" class="member-grid">
      <span
        v-for="member in memberList"
        :key="member.id"
        class="member-cell"
        :style="memberStyle(member)"
      >
        {{ memberInitial(member) }}
      </span>
    </div>
    <span v-else-if="special" class="fallback special" :style="{ background: specialBackground }">
      <svg v-if="special === 'filehelper'" class="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 2.75h7.3L19.25 8.7V19A2.25 2.25 0 0 1 17 21.25H6A2.25 2.25 0 0 1 3.75 19V5A2.25 2.25 0 0 1 6 2.75z" fill="#fff" />
        <path d="M12.1 17.4v-6M9.5 13.9l2.6-2.6 2.6 2.6" stroke="#0aa14c" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none" />
      </svg>
      <svg v-else-if="special === 'wechatpay'" class="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.4c-4.6 0-8.35 3.2-8.35 7.13 0 2.23 1.16 4.22 2.99 5.56l-.62 2.86a.58.58 0 0 0 .84.64l3.5-1.96c.53.1 1.08.15 1.64.15 4.6 0 8.35-3.2 8.35-7.13S16.6 3.4 12 3.4z" fill="#fff" />
        <path d="m8.6 11.5 2.4 2.4 4.4-4.6" stroke="#089a4b" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none" />
      </svg>
      <svg v-else-if="special === 'weixinTeam'" class="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4.2c-4.5 0-8.15 2.86-8.15 6.38 0 2.03 1.18 3.83 3.02 4.99l-.75 3.42a.6.6 0 0 0 .88.66l3.85-2.14c.37.05.76.08 1.15.08 4.5 0 8.15-2.86 8.15-6.38S16.5 4.2 12 4.2z" fill="#fff" />
        <circle cx="9.1" cy="10.3" r="1.05" fill="#089a4b" />
        <circle cx="14.9" cy="10.3" r="1.05" fill="#089a4b" />
      </svg>
      <svg v-else-if="special === 'service'" class="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18.9 3.85a1.15 1.15 0 0 1 1.73 1v14.3a1.15 1.15 0 0 1-1.73 1L9.3 14.95H5.55A1.95 1.95 0 0 1 3.6 13v-2a1.95 1.95 0 0 1 1.95-1.95H9.3z" fill="#fff" />
        <path d="M7.5 16.15h2.9v1.75a1.9 1.9 0 0 1-3.8 0v-1.75z" fill="#fff" />
      </svg>
      <svg v-else class="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.25 7A2.25 2.25 0 0 1 5.5 4.75h3.9c.66 0 1.28.3 1.7.8l1.06 1.28h6.34a2.25 2.25 0 0 1 2.25 2.25v8.17a2.25 2.25 0 0 1-2.25 2.25h-13a2.25 2.25 0 0 1-2.25-2.25V7z" fill="#fff" />
      </svg>
    </span>
    <span v-else class="fallback" :style="fallbackStyle">
      {{ initials(name) }}
    </span>
  </div>
</template>

<style scoped>
.thread-avatar {
  position: relative;
  flex: 0 0 auto;
  border-radius: 50%;
  overflow: hidden;
  background: var(--panel-soft);
  color: #fff;
  font-weight: 600;
  user-select: none;
}

.thread-avatar img,
.fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.thread-avatar img {
  object-fit: cover;
}

.fallback {
  font-size: 0.9em;
}

.special-glyph {
  width: 62%;
  height: 62%;
  display: block;
}

.member-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, 1fr);
  width: 100%;
  height: 100%;
  gap: 1px;
  background: var(--panel);
}

.member-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.62em;
  color: #fff;
  overflow: hidden;
}
</style>
