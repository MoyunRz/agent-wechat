import type { Contact, Message, Thread } from './types'

export function initials(value: string | null | undefined): string {
  const text = value?.trim() ?? ''
  if (!text)
    return '?'
  const chars = Array.from(text)
  return (chars[0] ?? '?').toUpperCase()
}

export function contactName(contact: Contact | null | undefined): string {
  if (!contact)
    return ''
  return contact.displayName?.trim()
    || contact.remark?.trim()
    || contact.nickname?.trim()
    || contact.username
    || contact.id
}

export function threadName(thread: Thread | null | undefined): string {
  if (!thread)
    return ''
  const name = thread.displayName?.trim()
  // 企业微信客服（@openim）没有资料行，服务端标签回退成原始 ID；
  // GetContact 也不提供其资料，统一兜底为可读文案。
  const peer = (thread.peerId || thread.id).trim()
  if (peer.endsWith('@openim') && (!name || name === peer))
    return '企业微信客服'
  return name || thread.id || '未命名会话'
}

export function threadKindLabel(kind: string, peerId?: string | null): string {
  // daemon 对 gh_ 公众号/服务号与 @openim 客服会话仍给 direct 分类，按 peerId 修正展示。
  // @openim 家族即企业微信客服（瑞幸等品牌客服与小程序客服同属此通道）。
  const peer = (peerId ?? '').trim()
  if (peer.startsWith('gh_'))
    return '服务号'
  if (peer.endsWith('@openim'))
    return '企业微信客服'
  switch (kind) {
    case 'group':
      return '群聊'
    case 'system':
      return '系统会话'
    default:
      return '单聊'
  }
}

export function previewText(thread: Thread): string {
  const message = thread.lastMessage
  if (!message)
    return '暂无消息'
  // 好友申请卡片消息原文为不可读的英文兜底，统一显示可读文案。
  if (message.type === 37)
    return '[好友申请]'
  if (message.text?.trim())
    return message.text.trim()
  return messageTypeLabel(message.type, undefined)
}

export function messageTypeLabel(type: number, appMessageType?: number): string {
  switch (type) {
    case 1:
      return '[文本]'
    case 3:
      return '[图片]'
    case 34:
      return '[语音]'
    case 43:
      return '[视频]'
    case 47:
      return '[表情]'
    case 48:
      return '[位置]'
    case 37:
      return '[好友申请]'
    case 49:
      switch (appMessageType) {
        case 5:
          return '[链接]'
        case 6:
          return '[文件]'
        case 19:
          return '[合并转发]'
        case 57:
          return '[引用]'
        default:
          return '[应用消息]'
      }
    case 10000:
      return '[系统消息]'
    default:
      return '[消息]'
  }
}

export function messageText(message: Pick<Message, 'type' | 'appMessageType' | 'body'>): string {
  const body = message.body?.trim()
  if (body)
    return body
  return messageTypeLabel(message.type, message.appMessageType)
}

export function formatClock(value: string | null | undefined): string {
  if (!value)
    return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function formatListTime(value: string | null | undefined): string {
  if (!value)
    return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay)
    return formatClock(value)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString())
    return '昨天'
  if (date.getFullYear() === now.getFullYear())
    return `${date.getMonth() + 1}/${date.getDate()}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

export function dayKey(value: string | null | undefined): string {
  if (!value)
    return 'unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return 'unknown'
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export function dayLabel(value: string | null | undefined): string {
  if (!value)
    return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return '未知时间'
  const now = new Date()
  if (date.toDateString() === now.toDateString())
    return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString())
    return '昨天'
  return date.toLocaleDateString('zh-CN', {
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export function connectionTone(connection: string | undefined, authenticated: boolean): 'online' | 'pending' | 'offline' {
  // 账号创建等响应可能省略 connection 字段，按未连接处理而不是崩溃。
  const normalized = (connection ?? 'disconnected').trim().toLowerCase()
  if (authenticated && (normalized === 'connected' || normalized === 'online'))
    return 'online'
  if (normalized === 'connecting' || normalized === 'reconnecting')
    return 'pending'
  return 'offline'
}

export function connectionLabel(connection: string | undefined, authenticated: boolean): string {
  const tone = connectionTone(connection, authenticated)
  if (tone === 'online')
    return '已连接'
  if (tone === 'pending')
    return '连接中'
  return authenticated ? '离线' : '未登录'
}

export function isOwnMessage(message: Pick<Message, 'direction'>): boolean {
  return message.direction === 'outgoing'
}

export function compareMessages(a: Pick<Message, 'createdAt' | 'id'>, b: Pick<Message, 'createdAt' | 'id'>): number {
  const left = a.createdAt ? new Date(a.createdAt).getTime() : 0
  const right = b.createdAt ? new Date(b.createdAt).getTime() : 0
  if (left !== right)
    return left - right
  return a.id.localeCompare(b.id)
}
