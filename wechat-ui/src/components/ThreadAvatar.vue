<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { wechatApi } from '../api'
import { initials } from '../format'
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
let identityToken = 0

const isGroup = computed(() => props.kind === 'group')
const memberList = computed(() => (props.members ?? []).slice(0, 4))
const useGrid = computed(() => isGroup.value && memberList.value.length >= 2)
const avatarIdentity = computed(() => useGrid.value ? '' : (props.username ?? '').trim())
const avatarUrl = computed(() =>
  props.imageUrl?.trim()
  || wechatApi.avatarUrl(props.accountId, avatarIdentity.value, version.value),
)
const showImage = computed(() => Boolean(avatarUrl.value) && !failed.value)

watch(
  () => [props.accountId, avatarIdentity.value, props.imageUrl],
  () => {
    identityToken += 1
    failed.value = false
    refreshAttempted.value = false
    version.value = 0
  },
)

async function onAvatarError(): Promise<void> {
  failed.value = true
  // 给定 URL 加载失败时不再回退到 hub 头像端点：陌生人不在通讯录，
  // 那条路径对陌生人也拿不到头像，直接展示首字母占位。
  if (!avatarIdentity.value || refreshAttempted.value || props.imageUrl?.trim())
    return
  refreshAttempted.value = true
  const token = identityToken
  const ok = await ensureAvatarCached(props.accountId, avatarIdentity.value)
  if (token !== identityToken)
    return
  if (!ok)
    return
  version.value = Date.now()
  failed.value = false
}

function gradientFor(name: string): string {
  let hash = 0
  for (const char of name)
    hash = (hash * 31 + char.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${hash} 58% 42%), hsl(${(hash + 42) % 360} 62% 30%))`
}

const fallbackStyle = computed(() => ({
  // 文件传输助手等系统会话沿用参考图的紫色头像。
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
    <div v-if="useGrid" class="member-grid">
      <span
        v-for="member in memberList"
        :key="member.id"
        class="member-cell"
        :style="memberStyle(member)"
      >
        {{ memberInitial(member) }}
      </span>
    </div>
    <img
      v-else-if="showImage"
      :src="avatarUrl ?? undefined"
      alt=""
      draggable="false"
      @error="onAvatarError"
    >
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
