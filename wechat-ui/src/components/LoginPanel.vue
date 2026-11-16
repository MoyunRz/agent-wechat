<script setup lang="ts">
import { computed } from 'vue'
import { connectionLabel, connectionTone } from '../format'
import type { AccountSummary, LoginAttempt } from '../types'
import Icon from './Icon.vue'

const props = defineProps<{
  account: AccountSummary
  attempt: LoginAttempt | null
  qrUrl: string | null
  qrFailed: boolean
  busy: boolean
  error: string
}>()

const emit = defineEmits<{
  start: []
  cancel: []
  refresh: []
  retryQr: []
  qrError: []
}>()

const state = computed(() => props.attempt?.state ?? 'idle')
const tone = computed(() => connectionTone(props.account.connection, props.account.authenticated))

const showQr = computed(() => {
  return state.value === 'awaiting_scan'
    && Boolean(props.qrUrl)
    && !props.qrFailed
})

const expiresLabel = computed(() => {
  const expiresAt = props.attempt?.result?.expiresAt
  if (!expiresAt)
    return ''
  const date = new Date(expiresAt * 1000)
  if (Number.isNaN(date.getTime()))
    return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
})

const statusTitle = computed(() => {
  switch (state.value) {
    case 'starting':
      return '正在启动登录'
    case 'awaiting_scan':
      return '使用微信扫码登录'
    case 'awaiting_approval':
      return '已扫码，请在手机上确认'
    case 'succeeded':
      return '登录成功'
    case 'cancelled':
      return '登录已取消'
    case 'failed':
      return '登录失败'
    case 'rejected':
      return '登录已被拒绝'
    case 'expired':
      return '二维码已过期'
    default:
      return '微信未登录'
  }
})

const statusHint = computed(() => {
  switch (state.value) {
    case 'starting':
      return '正在向微信申请登录二维码，请稍候。'
    case 'awaiting_scan':
      return '打开手机微信扫一扫，扫码后在手机上确认。'
    case 'awaiting_approval':
      return '请在手机微信中确认登录，确认后会自动进入会话列表。'
    case 'succeeded':
      return '正在同步账号信息...'
    case 'cancelled':
      return '本次登录已取消，可以重新生成二维码。'
    case 'failed':
      return '微信拒绝了这次登录，请重新尝试。'
    case 'rejected':
      return '手机端拒绝了本次登录，请重新生成二维码。'
    case 'expired':
      return '二维码已经失效，请重新生成。'
    default:
      return '登录后即可查看会话、收发消息并同步通讯录。'
  }
})

const canStart = computed(() => {
  // 除进行中的状态外都允许重新生成，避免出现 rejected 等未枚举终态时没有按钮。
  return !props.busy && !['starting', 'awaiting_scan', 'awaiting_approval', 'succeeded'].includes(state.value)
})

const canCancel = computed(() => {
  return !props.busy && ['starting', 'awaiting_scan', 'awaiting_approval'].includes(state.value)
})
</script>

<template>
  <div class="login-shell">
    <div class="login-backdrop" aria-hidden="true" />

    <div class="login-layout">
      <aside class="brand-panel">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none">
            <defs>
              <linearGradient id="vane-logo-surface" x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
                <stop stop-color="#223042" />
                <stop offset="1" stop-color="#0c121b" />
              </linearGradient>
              <linearGradient id="vane-logo-accent" x1="18" y1="16" x2="31" y2="32" gradientUnits="userSpaceOnUse">
                <stop stop-color="#34d399" />
                <stop offset="1" stop-color="#16a34a" />
              </linearGradient>
            </defs>
            <rect x="1" y="1" width="46" height="46" rx="14" fill="url(#vane-logo-surface)" stroke="rgba(52, 211, 153, 0.28)" />
            <path
              d="M13 18.5A5.5 5.5 0 0 1 18.5 13h11a5.5 5.5 0 0 1 5.5 5.5v5.2a5.5 5.5 0 0 1-5.5 5.5h-6.7l-5.8 4.2c-.66.48-1.58-.02-1.58-.82v-4.1A5.5 5.5 0 0 1 13 23.7v-5.2Z"
              fill="#f8fafc"
            />
            <path d="m21.8 18.4-3.2 4.2 3.2 4.2" stroke="url(#vane-logo-accent)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" />
            <path d="m27.6 18.4 3.2 4.2-3.2 4.2" stroke="url(#vane-logo-accent)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>

        <h1>把微信会话<br>放进同一个工作台</h1>
        <p class="brand-copy">扫码登录，会话独立、数据隔离</p>
        <ul class="brand-points">
          <li><Icon name="check" :size="13" /> 多账号独立登录与运行</li>
          <li><Icon name="check" :size="13" /> 本地数据隔离，互不干扰</li>
          <li><Icon name="check" :size="13" /> 登录后实时同步消息与会话</li>
        </ul>
      </aside>

      <section class="login-card fade-in">
        <header class="login-header">
          <div class="login-heading">
            <h2>微信登录</h2>
            <p>使用手机微信扫码授权</p>
          </div>
          <span class="connection-badge" :data-tone="tone">
            <span class="dot" />
            {{ connectionLabel(account.connection, account.authenticated) }}
          </span>
        </header>

        <div class="login-body" :data-state="state">
          <template v-if="state === 'starting' || state === 'succeeded'">
            <div class="state-icon spinning">
              <Icon name="refresh" :size="30" />
            </div>
          </template>

          <template v-else-if="showQr">
            <div class="qr-frame">
              <img
                :src="qrUrl ?? undefined"
                alt="微信登录二维码"
                draggable="false"
                @error="emit('qrError')"
              >
            </div>
            <p v-if="expiresLabel" class="qr-expiry">
              <Icon name="clock" :size="13" />
              二维码有效期至 {{ expiresLabel }}
            </p>
          </template>

          <template v-else-if="state === 'awaiting_scan' && qrFailed">
            <div class="state-icon warning">
              <Icon name="alert" :size="28" />
            </div>
            <button class="text-button" type="button" @click="emit('retryQr')">
              二维码加载失败，点击重试
            </button>
          </template>

          <template v-else-if="state === 'awaiting_approval'">
            <div class="state-icon success">
              <Icon name="check" :size="32" />
            </div>
          </template>

          <template v-else-if="state === 'failed' || state === 'cancelled' || state === 'expired' || state === 'rejected'">
            <div class="state-icon danger">
              <Icon name="alert" :size="28" />
            </div>
          </template>

          <template v-else>
            <div class="state-icon idle">
              <Icon name="qr" :size="32" />
            </div>
          </template>

          <h3 class="state-title">{{ statusTitle }}</h3>
          <p class="state-hint">{{ statusHint }}</p>

          <p v-if="error" class="login-error">
            <Icon name="alert" :size="13" />
            <span>{{ error }}</span>
          </p>

          <div class="login-actions">
            <button
              v-if="canStart"
              class="primary-button"
              type="button"
              :disabled="busy"
              @click="emit('start')"
            >
              <Icon name="qr" :size="16" />
              生成登录二维码
            </button>

            <button
              v-if="canCancel"
              class="ghost-button"
              type="button"
              :disabled="busy"
              @click="emit('cancel')"
            >
              取消登录
            </button>

            <button
              class="text-button"
              type="button"
              :disabled="busy"
              @click="emit('refresh')"
            >
              <Icon name="refresh" :size="13" />
              刷新账号状态
            </button>
          </div>
        </div>

        <footer class="login-footer">
          <span class="status-dot" :data-tone="tone" />
          每个微信会话独立进程、独立数据，可同时登录多个账号
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.login-shell {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 0;
  height: 100%;
  padding: 48px;
  overflow: auto;
}

.login-backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  background:
    radial-gradient(560px 420px at 14% 18%, rgba(34, 197, 94, 0.1), transparent 64%),
    radial-gradient(620px 480px at 88% 82%, var(--accent-faint), transparent 62%),
    var(--bg);
}

.login-backdrop::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.05) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(circle at 50% 42%, #000 0%, transparent 76%);
}

.login-layout {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 396px;
  gap: 56px;
  align-items: center;
  width: min(1060px, 100%);
}

.brand-panel {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 460px;
}

.brand-mark {
  width: 56px;
  height: 56px;
  margin-bottom: 22px;
  border-radius: 17px;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(52, 211, 153, 0.08);
  animation: brand-mark-in 0.6s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.brand-mark svg {
  display: block;
  width: 100%;
  height: 100%;
}

.brand-panel h1 {
  margin: 0;
  color: var(--text);
  font-size: 34px;
  font-weight: 700;
  line-height: 1.22;
  letter-spacing: -0.01em;
  animation: brand-rise 0.55s cubic-bezier(0.22, 1, 0.36, 1) 0.06s both;
}

.brand-copy {
  max-width: 380px;
  margin: 16px 0 0;
  color: var(--muted);
  font-size: 13.5px;
  line-height: 1.75;
  animation: brand-rise 0.55s cubic-bezier(0.22, 1, 0.36, 1) 0.14s both;
}

.brand-points {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 26px 0 0;
  padding: 0;
  list-style: none;
}

.brand-points li {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--text-soft);
  font-size: 12.5px;
  animation: brand-rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.brand-points li:nth-child(1) {
  animation-delay: 0.24s;
}

.brand-points li:nth-child(2) {
  animation-delay: 0.32s;
}

.brand-points li:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes brand-mark-in {
  from {
    opacity: 0;
    transform: scale(0.86) translateY(10px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes brand-rise {
  from {
    opacity: 0;
    transform: translateY(14px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .brand-mark,
  .brand-panel h1,
  .brand-copy,
  .brand-points li {
    animation: none;
  }
}

.brand-points :deep(svg) {
  flex: 0 0 auto;
  padding: 3px;
  border-radius: 50%;
  color: var(--success-text);
  background: rgba(34, 197, 94, 0.12);
  width: 19px;
  height: 19px;
}

.login-card {
  position: relative;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 24px;
  background: var(--popover-bg);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  overflow: hidden;
}

.login-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 22px 16px;
  border-bottom: 1px solid var(--border);
}

.login-heading {
  min-width: 0;
  flex: 1;
}

.login-heading h2 {
  margin: 0;
  color: var(--text);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.login-heading p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.connection-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}

.connection-badge[data-tone="online"] {
  color: var(--success-text);
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.08);
}

.connection-badge[data-tone="pending"] {
  color: var(--warning-text);
  border-color: rgba(251, 191, 36, 0.3);
  background: rgba(251, 191, 36, 0.08);
}

.connection-badge .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.login-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 30px 24px 22px;
  text-align: center;
}

.state-icon {
  display: grid;
  place-items: center;
  width: 76px;
  height: 76px;
  margin-bottom: 18px;
  border: 1px solid var(--border);
  border-radius: 24px;
  background: var(--panel-soft);
  color: var(--accent);
}

.state-icon.idle {
  color: var(--success-text);
  border-color: rgba(34, 197, 94, 0.28);
  background: rgba(34, 197, 94, 0.08);
}

.state-icon.success {
  color: var(--success-text);
  border-color: rgba(52, 211, 153, 0.32);
  background: rgba(52, 211, 153, 0.1);
}

.state-icon.warning {
  color: var(--warning);
  border-color: rgba(251, 191, 36, 0.28);
  background: rgba(251, 191, 36, 0.08);
}

.state-icon.danger {
  color: var(--danger);
  border-color: rgba(248, 113, 113, 0.28);
  background: rgba(248, 113, 113, 0.08);
}

.state-icon.spinning svg {
  animation: spin 1.1s linear infinite;
}

.qr-frame {
  display: grid;
  place-items: center;
  width: 218px;
  height: 218px;
  margin-bottom: 12px;
  padding: 11px;
  border-radius: 20px;
  background: #fff;
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.38);
}

.qr-frame img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}

.qr-expiry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0 0 14px;
  color: var(--muted);
  font-size: 12px;
}

.state-title {
  margin: 0 0 7px;
  color: var(--text);
  font-size: 17px;
  font-weight: 650;
}

.state-hint {
  max-width: 300px;
  margin: 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.65;
}

.login-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 14px 0 0;
  padding: 9px 12px;
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 10px;
  background: rgba(248, 113, 113, 0.08);
  color: var(--danger-text);
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
}

.login-error :deep(svg) {
  flex: 0 0 auto;
  margin-top: 1px;
}

.login-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 22px;
}

.primary-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 42px;
  border: 0;
  border-radius: 12px;
  background: linear-gradient(135deg, #22c55e, #0e9f6e);
  box-shadow: 0 12px 28px rgba(34, 197, 94, 0.22);
  color: #fff;
  font-weight: 600;
  transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
}

.primary-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 16px 32px rgba(34, 197, 94, 0.28);
}

.primary-button:disabled {
  opacity: 0.55;
}

.ghost-button {
  width: 100%;
  height: 38px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: transparent;
  color: var(--text-soft);
  transition: background 0.18s ease;
}

.ghost-button:hover:not(:disabled) {
  background: var(--panel-hover);
}

.text-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
}

.text-button:hover:not(:disabled) {
  color: var(--text);
}

.login-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 13px 20px;
  border-top: 1px solid var(--border);
  color: var(--muted-soft);
  font-size: 11px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted-soft);
}

.status-dot[data-tone="online"] {
  background: var(--success);
}

.status-dot[data-tone="pending"] {
  background: var(--warning);
}

@media (max-width: 900px) {
  .login-shell {
    padding: 28px;
  }

  .login-layout {
    grid-template-columns: 1fr;
    gap: 26px;
    justify-items: center;
    width: min(420px, 100%);
  }

  .brand-panel {
    align-items: center;
    max-width: 100%;
    text-align: center;
  }

  .brand-mark {
    width: 46px;
    height: 46px;
    margin-bottom: 14px;
    border-radius: 14px;
  }

  .brand-panel h1 {
    font-size: 26px;
  }

  .brand-copy {
    margin-top: 10px;
    font-size: 12.5px;
  }

  .brand-points {
    display: none;
  }
}

@media (max-height: 720px) and (min-width: 901px) {
  .login-shell {
    padding: 24px;
  }

  .login-layout {
    gap: 36px;
  }

  .brand-panel h1 {
    font-size: 30px;
  }

  .brand-points {
    margin-top: 18px;
  }

  .login-body {
    padding: 22px 24px 18px;
  }
}
</style>
