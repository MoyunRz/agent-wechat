import { authHeaders, wechatApi } from './api'
import { fetchWithTransport } from './platform/transport'
import type { WechatEvent } from './types'

type EventStreamOptions = {
  accountId: string
  after?: string | null
  signal: AbortSignal
  onOpen?: () => void
  onEvent: (event: WechatEvent) => void
}

function parseFrame(rawFrame: string): WechatEvent | null {
  let eventName = ''
  let eventId = ''
  const dataLines: string[] = []

  for (const rawLine of rawFrame.split('\n')) {
    if (!rawLine || rawLine.startsWith(':'))
      continue
    const colon = rawLine.indexOf(':')
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon)
    let value = colon < 0 ? '' : rawLine.slice(colon + 1)
    if (value.startsWith(' '))
      value = value.slice(1)
    if (field === 'event')
      eventName = value.trim()
    else if (field === 'id')
      eventId = value.trim()
    else if (field === 'data')
      dataLines.push(value)
  }

  if (dataLines.length === 0)
    return null

  let payload: unknown
  try {
    payload = JSON.parse(dataLines.join('\n'))
  }
  catch {
    return null
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (typeof record.kind === 'string') {
      return {
        cursor: typeof record.cursor === 'string' ? record.cursor : eventId,
        kind: record.kind,
        data: record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {},
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      }
    }
  }

  if (!eventName)
    return null

  return {
    cursor: eventId,
    kind: eventName,
    data: payload && typeof payload === 'object' ? payload as Record<string, unknown> : {},
    createdAt: '',
  }
}

/**
 * 读取当前会话的事件流。返回时代表服务端关闭或网络中断，由调用方决定重连。
 * 不使用 EventSource：需要在断线重连时显式携带 after cursor，并跟随组件生命周期取消。
 */
export async function consumeEventStream(options: EventStreamOptions): Promise<void> {
  const params = new URLSearchParams()
  if (options.after)
    params.set('after', options.after)
  const query = params.toString()
  const url = wechatApi.apiUrl(
    `/accounts/${encodeURIComponent(options.accountId)}/events/stream${query ? `?${query}` : ''}`,
  )

  const response = await fetchWithTransport(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'text/event-stream', ...authHeaders() },
    signal: options.signal,
  })
  if (!response.ok)
    throw new Error(`event stream failed (${response.status})`)
  if (!response.body)
    throw new Error('event stream is unavailable')

  options.onOpen?.()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const rawFrame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const event = parseFrame(rawFrame)
        if (event)
          options.onEvent(event)
        index = buffer.indexOf('\n\n')
      }
    }
  }
  finally {
    try {
      await reader.cancel()
    }
    catch {
      // 忽略取消时的竞态错误。
    }
  }
}
