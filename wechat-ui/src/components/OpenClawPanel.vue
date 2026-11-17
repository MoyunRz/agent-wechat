<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { wechatApi } from '../api'
import type { AccountSummary } from '../types'

const props = defineProps<{ account: AccountSummary }>()

const loading = ref(false)
const saving = ref(false)
const clearing = ref(false)
const error = ref('')
const notice = ref('')
const updatedAt = ref<number | null>(null)

const dmPolicy = ref<'open' | 'allowlist' | 'disabled'>('disabled')
const allowFrom = ref('')
const groupPolicy = ref<'' | 'open' | 'allowlist' | 'disabled'>('')
const groupAllowFrom = ref('')
const requireMention = ref(true)
const mediaMaxMb = ref(50)
const groupsJson = ref('')

function resetForm(): void {
  dmPolicy.value = 'disabled'
  allowFrom.value = ''
  groupPolicy.value = ''
  groupAllowFrom.value = ''
  requireMention.value = true
  mediaMaxMb.value = 50
  groupsJson.value = ''
}

function valuesToLines(values: unknown): string {
  return Array.isArray(values) ? values.map(String).join('\n') : ''
}

function linesToValues(text: string): string[] {
  return text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    const response = await wechatApi.getOpenClawConfig(props.account.id)
    updatedAt.value = response.updatedAt ?? null
    const config = response.config as Record<string, unknown> | null
    if (!config || typeof config !== 'object') {
      resetForm()
      return
    }
    dmPolicy.value = config.dmPolicy === 'open' || config.dmPolicy === 'allowlist' ? config.dmPolicy : 'disabled'
    allowFrom.value = valuesToLines(config.allowFrom)
    groupPolicy.value = config.groupPolicy === 'open' || config.groupPolicy === 'allowlist' || config.groupPolicy === 'disabled'
      ? config.groupPolicy
      : ''
    groupAllowFrom.value = valuesToLines(config.groupAllowFrom)
    const wildcard = (config.groups as Record<string, Record<string, unknown>> | undefined)?.['*']
    requireMention.value = wildcard?.requireMention !== false
    mediaMaxMb.value = typeof config.mediaMaxMb === 'number' && config.mediaMaxMb > 0 ? config.mediaMaxMb : 50
    groupsJson.value = config.groups && Object.keys(config.groups as object).length
      ? JSON.stringify(config.groups, null, 2)
      : ''
  }
  catch (e) {
    error.value = (e as Error).message || String(e)
  }
  finally {
    loading.value = false
  }
}

function buildConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {
    dmPolicy: dmPolicy.value,
    allowFrom: linesToValues(allowFrom.value),
    groupAllowFrom: linesToValues(groupAllowFrom.value),
  }
  if (groupPolicy.value)
    config.groupPolicy = groupPolicy.value
  const groups: Record<string, unknown> = {}
  if (groupsJson.value.trim()) {
    const parsed = JSON.parse(groupsJson.value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('群组高级覆盖必须是 JSON 对象')
    Object.assign(groups, parsed)
  }
  groups['*'] = { ...(groups['*'] as Record<string, unknown> | undefined ?? {}), requireMention: requireMention.value }
  config.groups = groups
  if (Number.isFinite(mediaMaxMb.value) && mediaMaxMb.value > 0)
    config.mediaMaxMb = Math.round(mediaMaxMb.value)
  return config
}

async function save(): Promise<void> {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const config = buildConfig()
    const response = await wechatApi.setOpenClawConfig(props.account.id, config)
    updatedAt.value = response.updatedAt
    notice.value = '已保存：该微信账号的 OpenClaw 配置已写入数据库并立即生效'
  }
  catch (e) {
    error.value = (e as Error).message || String(e)
  }
  finally {
    saving.value = false
  }
}

async function clearConfig(): Promise<void> {
  clearing.value = true
  error.value = ''
  notice.value = ''
  try {
    const response = await wechatApi.setOpenClawConfig(props.account.id, null)
    updatedAt.value = response.updatedAt
    resetForm()
    notice.value = '已清除：该账号恢复使用 OpenClaw 宿主配置'
  }
  catch (e) {
    error.value = (e as Error).message || String(e)
  }
  finally {
    clearing.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="openclaw-page">
    <header class="page-head">
      <h2>OpenClaw 配置</h2>
      <p class="page-sub">
        按微信账号隔离：这里修改只对当前登录的账号生效，其他微信账号互不影响。
        未保存副本的账号回退使用 OpenClaw 宿主配置。
      </p>
    </header>

    <div v-if="loading" class="state-line">加载中…</div>

    <form v-else class="config-form" @submit.prevent="save">
      <label class="field">
        <span class="field-label">私聊策略 (dmPolicy)</span>
        <select v-model="dmPolicy">
          <option value="open">open — 任何人可私聊触发</option>
          <option value="allowlist">allowlist — 仅白名单</option>
          <option value="disabled">disabled — 关闭私聊回复</option>
        </select>
      </label>

      <label class="field">
        <span class="field-label">私聊白名单 (allowFrom，每行一个，* 代表全部)</span>
        <textarea v-model="allowFrom" rows="4" placeholder="wxid_xxx&#10;*" />
      </label>

      <label class="field">
        <span class="field-label">群聊策略 (groupPolicy，留空跟随宿主配置)</span>
        <select v-model="groupPolicy">
          <option value="">（未设置）</option>
          <option value="open">open — 白名单群全部回复</option>
          <option value="allowlist">allowlist — 仅白名单群</option>
          <option value="disabled">disabled — 关闭群聊回复</option>
        </select>
      </label>

      <label class="field">
        <span class="field-label">群白名单 (groupAllowFrom，每行一个群 ID)</span>
        <textarea v-model="groupAllowFrom" rows="3" placeholder="123456@chatroom" />
      </label>

      <label class="field field-check">
        <input v-model="requireMention" type="checkbox">
        <span>群聊需要 @ 才回复（groups["*"].requireMention）</span>
      </label>

      <label class="field">
        <span class="field-label">群组高级覆盖 (groups，JSON 对象，可为空)</span>
        <textarea v-model="groupsJson" rows="5" placeholder='{ "123456@chatroom": { "requireMention": false } }' />
      </label>

      <label class="field">
        <span class="field-label">媒体大小上限 (mediaMaxMb，MiB)</span>
        <input v-model.number="mediaMaxMb" type="number" min="1" max="1024">
      </label>

      <div v-if="error" class="state-line error">{{ error }}</div>
      <div v-else-if="notice" class="state-line ok">{{ notice }}</div>
      <div class="state-line muted">
        {{ updatedAt ? `最近更新：${new Date(updatedAt * 1000).toLocaleString()}` : '该账号当前未存储副本（回退宿主配置）' }}
      </div>

      <div class="actions">
        <button type="submit" class="primary" :disabled="saving">
          {{ saving ? '保存中…' : '保存配置' }}
        </button>
        <button type="button" :disabled="clearing || loading" @click="clearConfig">
          {{ clearing ? '清除中…' : '清除副本' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.openclaw-page {
  flex: 1;
  overflow-y: auto;
  padding: 22px 26px;
  min-width: 0;
}

.page-head h2 {
  margin: 0 0 6px;
  font-size: 17px;
}

.page-sub {
  margin: 0 0 18px;
  color: var(--text-soft);
  font-size: 12.5px;
  line-height: 1.6;
}

.config-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 560px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12.5px;
  color: var(--text-soft);
}

.field input[type='number'],
.field select,
.field textarea {
  background: var(--input-bg, rgba(127, 127, 127, 0.08));
  color: inherit;
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  resize: vertical;
}

.field-check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.state-line {
  font-size: 12.5px;
}

.state-line.error {
  color: var(--danger-text, #e5484d);
}

.state-line.ok {
  color: var(--success-text, #2fa96e);
}

.state-line.muted {
  color: var(--text-soft);
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.actions button {
  border: 1px solid rgba(127, 127, 127, 0.3);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  padding: 8px 16px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.actions button.primary {
  background: var(--accent, #2f7cf6);
  border-color: var(--accent, #2f7cf6);
  color: #fff;
}

.actions button:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
