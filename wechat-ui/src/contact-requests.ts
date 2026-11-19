// Shared display helpers for saved friend-request conversations. Both the
// contacts sidebar and the standalone request inbox render the same rows, so
// their labels and fallbacks live here.

import type { ContactRequest } from './types'

/** Name to show for a request; falls back to the peer id. */
export function requestName(item: ContactRequest): string {
  return item.displayName?.trim() || item.peerId || item.id
}

/** Why a request row cannot be accepted right now. */
export function requestStatus(item: ContactRequest): string {
  if (item.actionable)
    return '申请可处理'
  if (item.isContact || item.state === 'contact')
    return '你们已经是好友了'
  if (item.state === 'request_sent')
    return '等待对方确认'
  return '申请已处理'
}

/** Direction of the conversation for the row's secondary label. */
export function requestDirectionLabel(item: ContactRequest): string {
  return item.direction === 'outgoing' ? '已发送的申请' : '收到的申请'
}

/** One history entry's side. */
export function requestMessageSide(direction: string): string {
  return direction === 'outgoing' ? '我发送' : '对方发送'
}

export function formatRequestTime(value: number | null | undefined): string {
  if (!value)
    return '未知'
  const time = new Date(value * 1000)
  if (Number.isNaN(time.getTime()))
    return '未知'
  return time.toLocaleString('zh-CN', { hour12: false })
}
