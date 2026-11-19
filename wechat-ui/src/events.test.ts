import { afterEach, describe, expect, it } from 'vitest'
import { consumeEventStream } from './events'
import { setFetchTransport } from './platform/transport'
import type { WechatEvent } from './types'

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(chunks: string[], options: { onOpen?: () => void } = {}): Promise<WechatEvent[]> {
  setFetchTransport(() => Promise.resolve(sseResponse(chunks)))
  const events: WechatEvent[] = []
  await consumeEventStream({
    accountId: 'account-1',
    signal: new AbortController().signal,
    onOpen: options.onOpen,
    onEvent: (event) => { events.push(event) },
  })
  return events
}

afterEach(() => {
  setFetchTransport(null)
})

describe('consumeEventStream', () => {
  it('parses frames that carry a kind in the payload', async () => {
    const events = await collect([
      'event: message\ndata: {"kind":"message.committed","cursor":"c1","data":{"threadId":"t1"},"createdAt":"2024-01-01T00:00:00Z"}\n\n',
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      cursor: 'c1',
      kind: 'message.committed',
      data: { threadId: 't1' },
      createdAt: '2024-01-01T00:00:00Z',
    })
  })

  it('falls back to the event name and id fields', async () => {
    const events = await collect(['event: thread.updated\nid: 42\ndata: {"threadId":"t1"}\n\n'])
    expect(events[0]).toEqual({ cursor: '42', kind: 'thread.updated', data: { threadId: 't1' }, createdAt: '' })
  })

  it('reassembles frames split across chunks', async () => {
    const events = await collect([
      'event: send.updated\ndata: {"kind":"send.upd',
      'ated","data":{"id":"s1","state":"accepted"}}\n\n',
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('send.updated')
    expect(events[0].data).toEqual({ id: 's1', state: 'accepted' })
  })

  it('drops comments, empty payloads and malformed JSON', async () => {
    const events = await collect([
      ': keep-alive\n\n',
      'event: noop\n\n',
      'event: broken\ndata: not-json\n\n',
      'event: ok\ndata: {"kind":"thread.read-state","data":{"threadId":"t2"}}\n\n',
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('thread.read-state')
  })

  it('reports the stream opening before the first frame', async () => {
    let opened = false
    const events = await collect(['event: ok\ndata: {"kind":"x"}\n\n'], { onOpen: () => { opened = true } })
    expect(opened).toBe(true)
    expect(events).toHaveLength(1)
  })

  it('rejects a failed response', async () => {
    setFetchTransport(() => Promise.resolve(new Response('nope', { status: 500 })))
    await expect(consumeEventStream({
      accountId: 'account-1',
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).rejects.toThrow(/event stream failed \(500\)/)
  })
})
