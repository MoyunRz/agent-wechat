// Global search (⌘K / Ctrl+K): saved contacts, saved groups and messages in one
// dialog. Contacts and messages come from the daemon; groups are matched in the
// loaded conversation list. Enter opens the highlighted result.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { wechatApi } from '../api'
import { userFacingErrorMessage } from '../errors'
import { contactName, formatListTime, threadName } from '../format'
import { useT } from '../i18n/useT'
import type { Contact, Message, Thread } from '../types'
import { startChatWithContact, startChatWithId } from '../store/actions'
import { useStore } from '../store/hooks'
import Icon from './Icon'
import ThreadAvatar from './ThreadAvatar'
import '../styles/components/contact-search.css'
import '../styles/components/global-search.css'

type Props = {
  open: boolean
  accountId: string
  onClose: () => void
}

const SEARCH_DEBOUNCE_MS = 300
const RESULT_LIMIT = 20

type Hit =
  | { kind: 'contact', id: string, contact: Contact }
  | { kind: 'group', id: string, thread: Thread }
  | { kind: 'message', id: string, message: Message, threadLabel: string }

type Section = { title: string, items: Hit[] }

export default function GlobalSearchDialog({ open, accountId, onClose }: Props) {
  const t = useT()
  const threads = useStore(state => state.threads.items)

  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const tokenRef = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open)
      return
    setQuery('')
    setContacts([])
    setMessages([])
    setError('')
    setActiveIndex(0)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open)
      return undefined
    const keyword = query.trim()
    const token = ++tokenRef.current
    if (!keyword) {
      setContacts([])
      setMessages([])
      setLoading(false)
      setError('')
      setActiveIndex(0)
      return undefined
    }
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError('')
      void Promise.all([
        wechatApi.listContacts(accountId, keyword, RESULT_LIMIT),
        wechatApi.searchMessages(accountId, keyword, RESULT_LIMIT),
      ])
        .then(([contactPage, messagePage]) => {
          if (token !== tokenRef.current)
            return
          setContacts(contactPage.items ?? [])
          setMessages(messagePage.items ?? [])
        })
        .catch((value) => {
          if (token !== tokenRef.current)
            return
          setContacts([])
          setMessages([])
          setError(userFacingErrorMessage(value, '搜索失败，请稍后重试。'))
        })
        .finally(() => {
          if (token === tokenRef.current)
            setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, query, accountId])

  useEffect(() => () => {
    tokenRef.current += 1
  }, [])

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword)
      return []
    return threads
      .filter(thread => thread.kind === 'group')
      .filter(thread =>
        threadName(thread).toLowerCase().includes(keyword)
        || thread.id.toLowerCase().includes(keyword))
      .slice(0, RESULT_LIMIT)
  }, [threads, query])

  const sections = useMemo<Section[]>(() => {
    const threadLabels = new Map(threads.map(thread => [thread.id, threadName(thread)]))
    return [
      { title: '联系人', items: contacts.map(contact => ({ kind: 'contact' as const, id: contact.id, contact })) },
      { title: '群聊', items: groups.map(thread => ({ kind: 'group' as const, id: thread.id, thread })) },
      {
        title: '消息',
        items: messages.map(message => ({
          kind: 'message' as const,
          id: message.id,
          message,
          threadLabel: threadLabels.get(message.threadId) ?? message.threadId,
        })),
      },
    ].filter(section => section.items.length > 0)
  }, [contacts, groups, messages, threads])

  const hits = useMemo(() => sections.flatMap(section => section.items), [sections])
  const activeHit = hits[Math.min(activeIndex, hits.length - 1)]

  useEffect(() => {
    if (activeIndex >= hits.length)
      setActiveIndex(Math.max(hits.length - 1, 0))
  }, [hits.length, activeIndex])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${String(activeIndex)}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function activate(hit: Hit): void {
    onClose()
    if (hit.kind === 'contact')
      startChatWithContact(hit.contact)
    else if (hit.kind === 'group')
      startChatWithId(hit.thread.id)
    else
      startChatWithId(hit.message.threadId)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(index => Math.min(index + 1, Math.max(hits.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter' && activeHit) {
      event.preventDefault()
      activate(activeHit)
    }
  }

  if (!open)
    return null

  const normalizedQuery = query.trim()
  let runningIndex = -1

  return createPortal(
    <div className="contact-backdrop" onClick={onClose}>
      <section
        className="contact-dialog global-search-dialog"
        onClick={(event) => { event.stopPropagation() }}
        onKeyDown={handleKeyDown}
      >
        <header className="contact-head">
          <div>
            <strong>{t('全局搜索')}</strong>
            <span>{t('搜索联系人、群聊和聊天记录')}</span>
          </div>
          <button type="button" className="contact-close" title={t('关闭')} onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="contact-search">
          <Icon name="search" size={15} className="contact-search-icon" />
          <input
            ref={inputRef}
            value={query}
            type="text"
            placeholder={t('搜索联系人、群聊或消息')}
            spellCheck="false"
            onChange={event => setQuery(event.target.value)}
          />
          {loading && <span className="contact-spinner"><Icon name="refresh" size={14} className="spin" /></span>}
        </div>

        {error && <p className="contact-error">{t(error)}</p>}

        <div className="global-search-results scrollbar-thin" ref={listRef}>
          {!normalizedQuery && (
            <div className="contact-empty">
              <span className="contact-empty-icon"><Icon name="search" size={22} /></span>
              <p>{t('搜索整个账号')}</p>
              <span>{t('输入名称、群名或消息内容；↑↓ 选择，Enter 打开。')}</span>
            </div>
          )}

          {normalizedQuery && !loading && hits.length === 0 && (
            <div className="contact-empty">
              <span className="contact-empty-icon"><Icon name="search" size={22} /></span>
              <p>{t('没有找到匹配的内容')}</p>
              <span>{t('试试更短的关键词，或检查是否已完成同步。')}</span>
            </div>
          )}

          {sections.map(section => (
            <div key={section.title} className="global-search-section">
              <h3>{t(section.title)}<span>{section.items.length}</span></h3>
              {section.items.map((hit) => {
                runningIndex += 1
                const index = runningIndex
                return (
                  <button
                    key={`${hit.kind}:${hit.id}`}
                    type="button"
                    data-index={index}
                    className={`global-search-item${index === activeIndex ? ' active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => activate(hit)}
                  >
                    {hit.kind === 'contact' && (
                      <>
                        <ThreadAvatar accountId={accountId} name={contactName(hit.contact)} username={hit.contact.username} size={34} />
                        <span className="global-search-main">
                          <strong>{contactName(hit.contact)}</strong>
                          <small>{hit.contact.username || hit.contact.id}</small>
                        </span>
                        <span className="global-search-kind">{t('联系人')}</span>
                      </>
                    )}
                    {hit.kind === 'group' && (
                      <>
                        <ThreadAvatar accountId={accountId} name={threadName(hit.thread)} username={hit.thread.id} kind="group" size={34} />
                        <span className="global-search-main">
                          <strong>{threadName(hit.thread)}</strong>
                          <small>{hit.thread.id}</small>
                        </span>
                        <span className="global-search-kind">{t('群聊')}</span>
                      </>
                    )}
                    {hit.kind === 'message' && (
                      <>
                        <span className="global-search-icon"><Icon name="message" size={15} /></span>
                        <span className="global-search-main">
                          <strong>{hit.threadLabel}</strong>
                          <small>{hit.message.body?.trim() || t('[非文本消息]')}</small>
                        </span>
                        <time>{formatListTime(hit.message.createdAt)}</time>
                      </>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <footer className="contact-foot">
          <span className="contact-hint">{t('↑↓ 选择 · Enter 打开 · Esc 关闭')}</span>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
