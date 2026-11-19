import { describe, expect, it } from 'vitest'
import {
  compareMessages,
  connectionLabel,
  connectionTone,
  contactName,
  dayKey,
  initials,
  messageTypeLabel,
  previewText,
  threadKindLabel,
  threadName,
  threadNoNotify,
} from './format'
import type { Contact, Thread } from './types'

function thread(patch: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    accountId: 'account-1',
    peerId: 'peer-1',
    kind: 'direct',
    displayName: null,
    unreadCount: 0,
    readStateVersion: 'v1',
    ...patch,
  }
}

describe('initials', () => {
  it('uses the first code point, uppercased', () => {
    expect(initials('alice')).toBe('A')
    expect(initials('  小明 ')).toBe('小')
  })

  it('falls back to a question mark', () => {
    expect(initials('')).toBe('?')
    expect(initials(null)).toBe('?')
  })
})

describe('contactName', () => {
  it('prefers display name, then remark, then nickname, then username', () => {
    const contact: Contact = { id: 'c1', username: 'wxid_1', displayName: 'Display', remark: 'Remark', nickname: 'Nick' }
    expect(contactName(contact)).toBe('Display')
    expect(contactName({ ...contact, displayName: null })).toBe('Remark')
    expect(contactName({ ...contact, displayName: null, remark: null })).toBe('Nick')
    expect(contactName({ ...contact, displayName: null, remark: null, nickname: null })).toBe('wxid_1')
    expect(contactName(null)).toBe('')
  })
})

describe('threadName', () => {
  it('uses the display name and falls back to the id', () => {
    expect(threadName(thread({ displayName: ' Team ' }))).toBe('Team')
    expect(threadName(thread({ displayName: null, id: 'room@chatroom' }))).toBe('room@chatroom')
    expect(threadName(thread({ displayName: null, id: '' }))).toBe('未命名会话')
    expect(threadName(null)).toBe('')
  })

  it('labels an unprofiled openim peer as WeCom support', () => {
    expect(threadName(thread({ displayName: null, id: 'x@openim', peerId: 'x@openim' }))).toBe('企业微信客服')
    expect(threadName(thread({ displayName: 'x@openim', id: 'x@openim', peerId: 'x@openim' }))).toBe('企业微信客服')
  })
})

describe('threadNoNotify', () => {
  it('treats muted threads and official accounts as silent', () => {
    expect(threadNoNotify(thread({ muted: true }))).toBe(true)
    expect(threadNoNotify(thread({ peerId: 'gh_abc' }))).toBe(true)
    expect(threadNoNotify(thread({ peerId: 'peer' }))).toBe(false)
    expect(threadNoNotify(null)).toBe(false)
  })
})

describe('threadKindLabel', () => {
  it('corrects official and openim peers before the daemon kind', () => {
    expect(threadKindLabel('direct', 'gh_abc')).toBe('服务号')
    expect(threadKindLabel('direct', 'x@openim')).toBe('企业微信客服')
    expect(threadKindLabel('group', 'room@chatroom')).toBe('群聊')
    expect(threadKindLabel('system')).toBe('系统会话')
    expect(threadKindLabel('direct')).toBe('单聊')
  })
})

describe('previewText', () => {
  it('prefers the preview text', () => {
    expect(previewText(thread({ lastMessage: { id: 'm', senderId: null, senderName: null, direction: null, type: 1, text: ' hi ', createdAt: null } }))).toBe('hi')
  })

  it('replaces the friend-request body with a readable label', () => {
    expect(previewText(thread({ lastMessage: { id: 'm', senderId: null, senderName: null, direction: null, type: 37, text: 'raw english', createdAt: null } }))).toBe('[好友申请]')
  })

  it('falls back to the message type label and to a placeholder', () => {
    expect(previewText(thread({ lastMessage: { id: 'm', senderId: null, senderName: null, direction: null, type: 3, text: ' ', createdAt: null } }))).toBe('[图片]')
    expect(previewText(thread())).toBe('暂无消息')
  })
})

describe('messageTypeLabel', () => {
  it('maps app message types', () => {
    expect(messageTypeLabel(49, 5)).toBe('[链接]')
    expect(messageTypeLabel(49, 6)).toBe('[文件]')
    expect(messageTypeLabel(49, 19)).toBe('[合并转发]')
    expect(messageTypeLabel(49, 57)).toBe('[引用]')
    expect(messageTypeLabel(49)).toBe('[应用消息]')
    expect(messageTypeLabel(10000)).toBe('[系统消息]')
    expect(messageTypeLabel(999)).toBe('[消息]')
  })
})

describe('compareMessages', () => {
  it('orders by timestamp then id', () => {
    const older = { id: 'b', createdAt: '2024-01-01T00:00:00Z' }
    const newer = { id: 'a', createdAt: '2024-01-02T00:00:00Z' }
    expect(compareMessages(older, newer)).toBeLessThan(0)
    expect(compareMessages({ id: 'a', createdAt: null }, { id: 'b', createdAt: null })).toBeLessThan(0)
  })
})

describe('dayKey', () => {
  it('uses the local calendar day and marks invalid input', () => {
    expect(dayKey('2024-03-05T10:00:00')).toBe('2024-3-5')
    expect(dayKey(null)).toBe('unknown')
    expect(dayKey('not a date')).toBe('unknown')
  })
})

describe('connectionTone', () => {
  it('maps the daemon connection state', () => {
    expect(connectionTone('connected', true)).toBe('online')
    expect(connectionTone('online', true)).toBe('online')
    expect(connectionTone('connected', false)).toBe('offline')
    expect(connectionTone('connecting', true)).toBe('pending')
    expect(connectionTone('reconnecting', true)).toBe('pending')
    expect(connectionTone(undefined, true)).toBe('offline')
  })

  it('labels the tone', () => {
    expect(connectionLabel('connected', true)).toBe('已连接')
    expect(connectionLabel('connecting', true)).toBe('连接中')
    expect(connectionLabel('disconnected', true)).toBe('离线')
    expect(connectionLabel('disconnected', false)).toBe('未登录')
  })
})
