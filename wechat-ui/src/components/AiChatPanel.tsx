import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { wechatApi, type AiConfig } from '../api'
import { useT } from '../i18n/useT'
import { renderMarkdown } from '../markdown'
import type { AccountSummary } from '../types'
import Icon from './Icon'
import '../styles/components/ai-chat.css'

type AiChatPanelProps = { account: AccountSummary }

/** One conversation message; a pending flag marks an assistant reply that is streaming. */
type AiMessage = { role: 'user' | 'assistant', content: string, pending?: boolean, failed?: boolean }

/** One conversation: its own message list and a title (defaults to the first user message). */
type AiSession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: AiMessage[]
}

/** Title of a fresh conversation; also the sentinel that lets the first message rename it. */
const NEW_SESSION_TITLE = '新会话'
/** Title of a conversation migrated from the old single-conversation key. */
const LEGACY_SESSION_TITLE = '历史会话'

/** Sessions are stored per WeChat account so switching accounts does not mix them up. */
const SESSION_STORE_PREFIX = 'wx-ai-chats-'
const LEGACY_STORE_PREFIX = 'wx-ai-chat-'

/** Must match the ai-settings-fade-* animation duration in the stylesheet. */
const SETTINGS_FADE_MS = 160

/**
 * Thinking placeholder shown before the first token arrives; a random hint is
 * picked every 3 seconds. Entries are Chinese source strings translated on
 * render.
 */
const THINKING_HINTS = [
  '正在思考…',
  '灵光乍现中 ✨',
  '神经元开足马力…',
  '正在组织语言…',
  '翻阅大脑百科…',
  '键盘敲得飞起…',
  '喝口水再想…',
  '让子弹再飞一会…',
  '认真琢磨中…',
  '马上就好…',
]

/** Reasoning-effort choices for the composer picker; the empty value sends nothing. */
const REASONING_OPTIONS: Array<{ value: string, label: string }> = [
  { value: '', label: '默认' },
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

function newId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `s-${Date.now().toString(36)}-${random}`
}

function createSession(): AiSession {
  const now = Date.now()
  return { id: newId(), title: NEW_SESSION_TITLE, createdAt: now, updatedAt: now, messages: [] }
}

function formatSessionTime(stamp: number): string {
  const date = new Date(stamp)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function extractDelta(chunk: Record<string, unknown>): string {
  const choices = chunk.choices as Array<Record<string, unknown>> | undefined
  const first = choices?.[0]
  const delta = first?.delta as Record<string, unknown> | undefined
  return typeof delta?.content === 'string' ? delta.content : ''
}

function extractMessageContent(payload: Record<string, unknown>): string {
  const choices = payload.choices as Array<Record<string, unknown>> | undefined
  const message = choices?.[0]?.message as Record<string, unknown> | undefined
  return typeof message?.content === 'string' ? message.content : ''
}

/**
 * Mount a node with the enter fade and keep it mounted while it fades out.
 * Replaces the Vue Transition wrapper around the settings dialog.
 */
function useFadePresence(open: boolean): { mounted: boolean, closing: boolean } {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const wasOpen = useRef(open)

  useEffect(() => {
    if (open) {
      wasOpen.current = true
      setMounted(true)
      setClosing(false)
      return
    }
    if (!wasOpen.current) {
      setMounted(false)
      return
    }
    // Close: play the leave animation, then unmount.
    wasOpen.current = false
    setClosing(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, SETTINGS_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  return { mounted, closing }
}

export default function AiChatPanel({ account }: AiChatPanelProps) {
  const t = useT()
  const storeKey = `${SESSION_STORE_PREFIX}${account.id}`

  const [sessions, setSessions] = useState<AiSession[]>([])
  /** Archived conversations: hidden from the list, restorable from the sidebar. */
  const [archived, setArchived] = useState<AiSession[]>([])
  const [activeId, setActiveId] = useState('')
  /** Account whose sessions are in state; keeps persistence off the wrong key after a switch. */
  const [loadedAccountId, setLoadedAccountId] = useState('')
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const [archivedOpen, setArchivedOpen] = useState(false)

  const listRef = useRef<HTMLDivElement | null>(null)
  const aborterRef = useRef<AbortController | null>(null)

  const activeSession = sessions.find(session => session.id === activeId) ?? null
  const messages = activeSession?.messages ?? []

  /**
   * Display a stored session title. Only the default titles are translated; a
   * title taken from the first user message is shown as typed.
   */
  function sessionTitle(title: string): string {
    return title === NEW_SESSION_TITLE || title === LEGACY_SESSION_TITLE ? t(title) : title
  }

  // ---- session management ----

  function loadSessions(): void {
    // Migrate the old single-conversation key by keeping its history as one session.
    let migrated: AiSession | null = null
    try {
      const legacy = window.localStorage.getItem(`${LEGACY_STORE_PREFIX}${account.id}`)
      const fresh = window.localStorage.getItem(storeKey)
      if (legacy && !fresh) {
        const parsed = JSON.parse(legacy) as unknown
        if (Array.isArray(parsed)) {
          const items = parsed.filter((item): item is AiMessage =>
            typeof item === 'object' && item !== null
            && ((item as AiMessage).role === 'user' || (item as AiMessage).role === 'assistant')
            && typeof (item as AiMessage).content === 'string')
          if (items.length) {
            const firstUser = items.find(message => message.role === 'user')
            migrated = {
              id: newId(),
              title: firstUser?.content.slice(0, 24) || LEGACY_SESSION_TITLE,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: items,
            }
          }
        }
        window.localStorage.removeItem(`${LEGACY_STORE_PREFIX}${account.id}`)
      }
    }
    catch {
      // A failed migration must not block loading; continue as if there were none.
    }

    let nextSessions: AiSession[]
    let nextArchived: AiSession[]
    try {
      const raw = window.localStorage.getItem(storeKey)
      const parsed = raw ? JSON.parse(raw) as unknown : null
      const list = Array.isArray((parsed as { sessions?: unknown })?.sessions)
        ? ((parsed as { sessions: unknown[] }).sessions.filter((item): item is AiSession =>
          typeof item === 'object' && item !== null
          && typeof (item as AiSession).id === 'string'
          && Array.isArray((item as AiSession).messages)) as AiSession[])
        : []
      const storedArchived = Array.isArray((parsed as { archived?: unknown })?.archived)
        ? ((parsed as { archived: unknown[] }).archived.filter((item): item is AiSession =>
          typeof item === 'object' && item !== null
          && typeof (item as AiSession).id === 'string'
          && Array.isArray((item as AiSession).messages)) as AiSession[])
        : []
      nextSessions = migrated ? [migrated, ...list] : list
      nextArchived = storedArchived
    }
    catch {
      nextSessions = migrated ? [migrated] : []
      nextArchived = []
    }
    if (!nextSessions.length)
      nextSessions = [createSession()]
    setSessions(nextSessions)
    setArchived(nextArchived)
    setActiveId(nextSessions[0].id)
    setLoadedAccountId(account.id)
  }

  /**
   * Scroll the message list to the latest message. The Vue component awaited
   * nextTick(); React commits pending state before the animation frame, so the
   * frame callback measures the updated scroll height.
   */
  function scrollBottom(): void {
    const element = listRef.current
    if (!element)
      return
    window.requestAnimationFrame(() => {
      element.scrollTo({ top: element.scrollHeight })
    })
  }

  function selectSession(id: string): void {
    if (streaming)
      return
    setActiveId(id)
    setError('')
    scrollBottom()
  }

  function createNewSession(): void {
    if (streaming)
      return
    // Do not stack another empty conversation on an existing empty one.
    if (activeSession && !activeSession.messages.length)
      return
    const session = createSession()
    setSessions(list => [session, ...list])
    setActiveId(session.id)
    setError('')
    scrollBottom()
  }

  function deleteSession(id: string): void {
    if (streaming)
      return
    const index = sessions.findIndex(session => session.id === id)
    if (index >= 0) {
      const remaining = sessions.filter(session => session.id !== id)
      if (activeId === id) {
        const next = remaining.length ? remaining : [createSession()]
        setSessions(next)
        setActiveId(next[0].id)
      }
      else {
        setSessions(remaining)
      }
    }
    else {
      setArchived(list => list.filter(session => session.id !== id))
    }
  }

  /** Archive a conversation: move it out of the list, keeping one empty session behind. */
  function archiveSession(id: string): void {
    if (streaming)
      return
    const session = sessions.find(item => item.id === id)
    if (!session)
      return
    const remaining = sessions.filter(item => item.id !== id)
    setArchived(list => [session, ...list])
    if (activeId === id) {
      const next = remaining.length ? remaining : [createSession()]
      setSessions(next)
      setActiveId(next[0].id)
    }
    else {
      setSessions(remaining)
    }
  }

  /** Restore an archived conversation to the top of the list and select it. */
  function restoreSession(id: string): void {
    if (streaming)
      return
    const session = archived.find(item => item.id === id)
    if (!session)
      return
    setArchived(list => list.filter(item => item.id !== id))
    setSessions(list => [session, ...list])
    setActiveId(session.id)
  }

  function clearActiveSession(): void {
    if (!activeSession)
      return
    const sessionId = activeSession.id
    setSessions(list => list.map(session => session.id !== sessionId
      ? session
      : { ...session, messages: [], title: NEW_SESSION_TITLE, updatedAt: Date.now() }))
  }

  // ---- thinking placeholder ----

  const [thinkingHint, setThinkingHint] = useState('正在思考…')
  const thinkingHintRef = useRef('正在思考…')
  const thinkingTimerRef = useRef<number | null>(null)

  function randomThinkingHint(): void {
    let next = THINKING_HINTS[Math.floor(Math.random() * THINKING_HINTS.length)]
    // Never show the same hint twice in a row.
    if (next === thinkingHintRef.current && THINKING_HINTS.length > 1)
      next = THINKING_HINTS[(THINKING_HINTS.indexOf(next) + 1) % THINKING_HINTS.length]
    thinkingHintRef.current = next
    setThinkingHint(next)
  }

  function startThinking(): void {
    randomThinkingHint()
    stopThinking()
    thinkingTimerRef.current = window.setInterval(randomThinkingHint, 3000)
  }

  function stopThinking(): void {
    if (thinkingTimerRef.current !== null) {
      window.clearInterval(thinkingTimerRef.current)
      thinkingTimerRef.current = null
    }
  }

  // ---- configuration ----

  const [config, setConfig] = useState<AiConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  /** Reasoning effort; empty means the request carries no reasoning_effort. */
  const [selectedReasoning, setSelectedReasoning] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // The Vue component declared this flag but never set it, so the pull button
  // label always shows the idle text. Kept so the markup stays identical.
  const [fetchingModels] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [settingsNotice, setSettingsNotice] = useState('')
  const [formBaseUrl, setFormBaseUrl] = useState('')
  const [formApiKey, setFormApiKey] = useState('')
  const [formModels, setFormModels] = useState<string[]>([])
  const [newModel, setNewModel] = useState('')
  const [formModel, setFormModel] = useState('')
  const [formReasoning, setFormReasoning] = useState('')

  /** Model and reasoning-effort popover inside the composer. */
  const [pickerOpen, setPickerOpen] = useState(false)
  const settingsPresence = useFadePresence(settingsOpen)

  const configured = Boolean(config && config.baseUrl && config.keyConfigured && selectedModel)

  async function loadConfig(): Promise<void> {
    setConfigLoading(true)
    try {
      const next = await wechatApi.getAiConfig(account.id)
      setConfig(next)
      setSelectedModel(next.model || next.models[0] || '')
      setSelectedReasoning(next.reasoning || '')
    }
    catch (e) {
      setError((e as Error).message || String(e))
    }
    finally {
      setConfigLoading(false)
    }
  }

  function openSettings(): void {
    setPickerOpen(false)
    setSettingsError('')
    setSettingsNotice('')
    setFormBaseUrl(config?.baseUrl ?? '')
    setFormApiKey('')
    setFormModels([...(config?.models ?? [])])
    setFormModel(config?.model || config?.models[0] || '')
    setFormReasoning(config?.reasoning ?? '')
    setNewModel('')
    setSettingsOpen(true)
  }

  function addModel(): void {
    const name = newModel.trim()
    if (!name)
      return
    if (!formModels.includes(name))
      setFormModels(list => [...list, name])
    setNewModel('')
  }

  function removeModel(name: string): void {
    const next = formModels.filter(model => model !== name)
    setFormModels(next)
    if (formModel === name)
      setFormModel(next[0] ?? '')
  }

  async function saveSettings(): Promise<void> {
    setSaving(true)
    setSettingsError('')
    setSettingsNotice('')
    try {
      await wechatApi.saveAiConfig(account.id, {
        baseUrl: formBaseUrl.trim(),
        // An empty key keeps the key the daemon already stored; never echo it back.
        apiKey: formApiKey.trim() || undefined,
        models: formModels,
        model: formModel || formModels[0] || '',
        reasoning: formReasoning,
      })
      setSettingsNotice(t('已保存。'))
      await loadConfig()
    }
    catch (e) {
      setSettingsError((e as Error).message || String(e))
    }
    finally {
      setSaving(false)
    }
  }

  async function pullModels(): Promise<void> {
    // Save the form first: pulling models depends on the stored base URL and key.
    setSaving(true)
    setSettingsError('')
    try {
      await wechatApi.saveAiConfig(account.id, {
        baseUrl: formBaseUrl.trim(),
        apiKey: formApiKey.trim() || undefined,
        models: formModels,
        model: formModel || formModels[0] || '',
        reasoning: formReasoning,
      })
      const { models } = await wechatApi.refreshAiModels(account.id)
      if (models.length) {
        setFormModels(models)
        if (!formModel || !models.includes(formModel))
          setFormModel(models[0])
        setSettingsNotice(t('已拉取 {count} 个模型。', { count: models.length }))
      }
      else {
        setSettingsNotice(t('服务未返回模型列表，可手动添加。'))
      }
    }
    catch (e) {
      setSettingsError((e as Error).message || String(e))
    }
    finally {
      setSaving(false)
    }
  }

  async function changeModel(model: string): Promise<void> {
    setSelectedModel(model)
    // Persist the choice to the daemon so it survives a different browser.
    if (config && config.baseUrl && config.keyConfigured) {
      try {
        await wechatApi.saveAiConfig(account.id, {
          baseUrl: config.baseUrl,
          models: config.models,
          model,
          reasoning: selectedReasoning,
        })
      }
      catch {
        // A failed selection does not block the conversation; settings save it again.
      }
    }
  }

  async function changeReasoning(reasoning: string): Promise<void> {
    setSelectedReasoning(reasoning)
    if (config && config.baseUrl && config.keyConfigured) {
      try {
        await wechatApi.saveAiConfig(account.id, {
          baseUrl: config.baseUrl,
          models: config.models,
          model: selectedModel,
          reasoning,
        })
      }
      catch {
        // A failed selection does not block the conversation; settings save it again.
      }
    }
  }

  // ---- conversation ----

  function stopStreaming(): void {
    aborterRef.current?.abort()
    aborterRef.current = null
  }

  /** Parse an OpenAI-compatible SSE stream: data chunks, ended by [DONE]. */
  async function consumeSse(response: Response, onDelta: (delta: string) => void): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader)
      throw new Error(t('AI 服务未返回任何内容。'))
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line.startsWith('data:'))
          continue
        const data = line.slice(5).trim()
        if (data === '[DONE]')
          return
        try {
          const chunk = JSON.parse(data) as Record<string, unknown>
          const delta = extractDelta(chunk)
          if (delta)
            onDelta(delta)
        }
        catch {
          // Ignore lines that are not JSON (keepalive comments and the like).
        }
      }
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || streaming)
      return
    if (!configured) {
      setError(t('请先点击右上角设置，配置 AI 服务地址、API Key 和模型。'))
      openSettings()
      return
    }
    const current = activeSession
    if (!current)
      return
    setError('')
    setDraft('')
    const reply: AiMessage = { role: 'assistant', content: '', pending: true }
    const nextMessages: AiMessage[] = [...current.messages, { role: 'user', content: text }, reply]
    const replyIndex = nextMessages.length - 1
    const nextSession: AiSession = {
      ...current,
      // The first user message names the conversation.
      title: current.title === NEW_SESSION_TITLE ? text.slice(0, 24) : current.title,
      updatedAt: Date.now(),
      messages: nextMessages,
    }
    // Keep the most recently used conversation at the top of the list.
    setSessions(list => [nextSession, ...list.filter(session => session.id !== current.id)])
    scrollBottom()

    setStreaming(true)
    startThinking()
    aborterRef.current = new AbortController()
    let replyContent = ''
    const appendDelta = (delta: string): void => {
      replyContent += delta
      setSessions(list => list.map(session => session.id !== current.id
        ? session
        : {
            ...session,
            messages: session.messages.map((message, index) =>
              index === replyIndex ? { ...message, content: replyContent } : message),
          }))
      scrollBottom()
    }
    try {
      const history = nextMessages
        .filter(message => !message.pending && message.content)
        .map(message => ({ role: message.role, content: message.content }))
      const response = await wechatApi.aiChatCompletions(account.id, {
        model: selectedModel,
        messages: history,
        stream: true,
        // Empty values are not sent: some models and services reject the parameter.
        ...(selectedReasoning ? { reasoning_effort: selectedReasoning } : {}),
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream'))
        await consumeSse(response, appendDelta)
      else
        replyContent = extractMessageContent(await response.json() as Record<string, unknown>)

      const content = replyContent
      setSessions(list => list.map(session => {
        if (session.id !== current.id)
          return session
        const updated = session.messages.map((message, index) =>
          index === replyIndex ? { ...message, content, pending: false } : message)
        return {
          ...session,
          updatedAt: Date.now(),
          // An empty reply is removed instead of leaving an empty bubble.
          messages: content ? updated : updated.filter((_, index) => index !== replyIndex),
        }
      }))
    }
    catch (e) {
      const aborted = (e as Error).name === 'AbortError'
      const content = aborted
        ? (replyContent ? `${replyContent}\n${t('（已停止）')}` : t('（已停止）'))
        : replyContent || ((e as Error).message || String(e))
      setSessions(list => list.map(session => session.id !== current.id
        ? session
        : {
            ...session,
            updatedAt: Date.now(),
            messages: session.messages.map((message, index) =>
              index === replyIndex
                ? { ...message, content, pending: false, ...(aborted ? {} : { failed: true }) }
                : message),
          }))
    }
    finally {
      setStreaming(false)
      stopThinking()
      aborterRef.current = null
      scrollBottom()
    }
  }

  // ---- effects ----

  useEffect(() => {
    // Sessions and AI settings are per account; reload both when it changes.
    stopStreaming()
    loadSessions()
    void loadConfig()
  }, [account.id])

  useEffect(() => {
    // Same payload the Vue deep watcher wrote on every session change. Skip
    // until the state belongs to the current account so a switch cannot write
    // one account's sessions into another account's key.
    if (loadedAccountId !== account.id)
      return
    try {
      window.localStorage.setItem(storeKey, JSON.stringify({ sessions, archived, activeId }))
    }
    catch {
      // Storage can be unavailable; keep the sessions in memory only.
    }
  }, [storeKey, account.id, loadedAccountId, sessions, archived, activeId])

  useEffect(() => () => {
    aborterRef.current?.abort()
    stopThinking()
  }, [])

  // ---- rendering helpers ----

  function handleSessionActionKeyDown(event: KeyboardEvent<HTMLSpanElement>, action: () => void): void {
    // Mirrors the @keydown.enter.stop.prevent modifier on the spans acting as buttons.
    if (event.key !== 'Enter')
      return
    event.stopPropagation()
    event.preventDefault()
    action()
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Mirrors @keydown.enter.exact.prevent: Enter alone sends, Shift+Enter wraps.
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)
      return
    event.preventDefault()
    void send()
  }

  return (
    <>
      <section className="ai-page">
        <header className="ai-head">
          <div className="ai-heading">
            <h2>{t('AI 对话')}</h2>
            <p className="ai-sub">
              {configLoading
                ? t('正在读取 AI 配置…')
                : configured ? selectedModel : t('未配置 AI 服务')}
            </p>
          </div>
          <div className="ai-head-actions">
            {messages.length > 0 && (
              <button
                className="ai-ghost"
                type="button"
                disabled={streaming}
                title={t('清空当前会话')}
                onClick={clearActiveSession}
              >
                {t('清空对话')}
              </button>
            )}
            <button className="ai-icon-button" type="button" title={t('AI 设置')} onClick={openSettings}>
              <Icon name="settings" size={17} />
            </button>
          </div>
        </header>

        <div className="ai-body">
          <aside className="ai-sidebar">
            <button className="ai-new-session" type="button" disabled={streaming} onClick={createNewSession}>
              <Icon name="plus" size={14} />
              {t('新建会话')}
            </button>
            <div className="ai-session-list">
              {sessions.map(session => (
                <button
                  key={session.id}
                  className={`ai-session-item${session.id === activeId ? ' active' : ''}`}
                  type="button"
                  onClick={() => selectSession(session.id)}
                >
                  <span className="ai-session-title">{sessionTitle(session.title)}</span>
                  <span className="ai-session-time">{formatSessionTime(session.updatedAt)}</span>
                  <span className="ai-session-actions">
                    <span
                      className="ai-session-action"
                      title={t('归档会话')}
                      role="button"
                      tabIndex={0}
                      onClick={event => { event.stopPropagation(); archiveSession(session.id) }}
                      onKeyDown={event => handleSessionActionKeyDown(event, () => archiveSession(session.id))}
                    >
                      <Icon name="archive" size={13} />
                    </span>
                    {sessions.length > 1 && (
                      <span
                        className="ai-session-action"
                        title={t('删除会话')}
                        role="button"
                        tabIndex={0}
                        onClick={event => { event.stopPropagation(); deleteSession(session.id) }}
                        onKeyDown={event => handleSessionActionKeyDown(event, () => deleteSession(session.id))}
                      >
                        <Icon name="trash" size={13} />
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>

            {archived.length > 0 && (
              <div className="ai-archived">
                <button className="ai-archived-toggle" type="button" onClick={() => setArchivedOpen(open => !open)}>
                  <Icon name={archivedOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                  {t('已归档 · {count}', { count: archived.length })}
                </button>
                {archivedOpen && (
                  <div className="ai-archived-list">
                    {archived.map(session => (
                      <div key={session.id} className="ai-archived-item">
                        <span className="ai-session-title" title={sessionTitle(session.title)}>
                          {sessionTitle(session.title)}
                        </span>
                        <span className="ai-archived-actions">
                          <span
                            className="ai-session-action"
                            title={t('恢复会话')}
                            role="button"
                            tabIndex={0}
                            onClick={() => restoreSession(session.id)}
                          >
                            <Icon name="archive-restore" size={13} />
                          </span>
                          <span
                            className="ai-session-action"
                            title={t('彻底删除')}
                            role="button"
                            tabIndex={0}
                            onClick={() => deleteSession(session.id)}
                          >
                            <Icon name="trash" size={13} />
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </aside>

          <main className="ai-main">
            <div ref={listRef} className="ai-list">
              {!messages.length && (
                <div className="ai-empty">
                  <div className="ai-empty-icon"><Icon name="gpt" size={30} /></div>
                  <p>{t('开始与 AI 助手的新对话。')}</p>
                  <p>
                    {t('发送前请在右上角设置里配置 OpenAI 兼容的服务地址、API Key 与模型。')}
                  </p>
                </div>
              )}

              {messages.map(message => (
                <div
                  key={`${message.role}-${message.content.slice(0, 24)}`}
                  className="ai-row"
                  data-role={message.role}
                >
                  <div className="ai-bubble" data-failed={message.failed || undefined}>
                    <span className="ai-content">
                      {message.pending && !message.content
                        ? <span className="ai-thinking">{t(thinkingHint)}</span>
                        : message.role === 'assistant'
                          ? (
                            <>
                              {/* Assistant replies render as markdown (already sanitized); user text stays plain. */}
                              <span
                                className="ai-md"
                                dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                              />
                              {message.pending && <span className="ai-cursor" />}
                            </>
                          )
                          : message.content}
                    </span>
                  </div>
                </div>
              ))}

              {error && (
                <div className="ai-error">
                  <Icon name="alert" size={13} />
                  <span>{error}</span>
                </div>
              )}
            </div>

            <footer className="ai-composer">
              <div className="ai-composer-box">
                <textarea
                  className="ai-input"
                  rows={2}
                  placeholder={t('输入消息，Enter 发送，Shift+Enter 换行')}
                  disabled={streaming}
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                />
                <div className="ai-composer-bar">
                  <button
                    className="ai-model-pill"
                    type="button"
                    disabled={!config?.models.length}
                    aria-expanded={pickerOpen}
                    title={t('选择模型与思考程度')}
                    onClick={() => setPickerOpen(open => !open)}
                  >
                    <span className="ai-model-pill-name">{selectedModel || t('选择模型')}</span>
                    <Icon name="chevron-down" size={13} />
                  </button>
                  <div className="ai-composer-spacer" />
                  {streaming
                    ? (
                      <button className="ai-stop" type="button" title={t('停止生成')} onClick={stopStreaming}>
                        <Icon name="close" size={16} />
                      </button>
                    )
                    : (
                      <button
                        className="ai-send"
                        type="button"
                        disabled={!draft.trim()}
                        title={t('发送')}
                        onClick={() => void send()}
                      >
                        <Icon name="send" size={16} />
                      </button>
                    )}
                </div>

                {pickerOpen && (
                  <>
                    <div className="ai-picker-backdrop" onClick={() => setPickerOpen(false)} />
                    <div className="ai-picker" role="dialog" aria-label={t('选择模型与思考程度')}>
                      <div className="ai-picker-section">
                        <div className="ai-picker-label">{t('思考程度')}</div>
                        <div className="ai-picker-segments">
                          {REASONING_OPTIONS.map(option => (
                            <button
                              key={option.value}
                              type="button"
                              className={`ai-segment${selectedReasoning === option.value ? ' active' : ''}`}
                              onClick={() => void changeReasoning(option.value)}
                            >
                              {t(option.label)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="ai-picker-models">
                        {(config?.models ?? []).map(model => (
                          <button
                            key={model}
                            type="button"
                            className={`ai-picker-model${model === selectedModel ? ' active' : ''}`}
                            onClick={() => { void changeModel(model); setPickerOpen(false) }}
                          >
                            <span className="ai-picker-model-name">{model}</span>
                            {model === selectedModel && <Icon name="check" size={14} />}
                          </button>
                        ))}
                      </div>
                      <button className="ai-picker-add" type="button" onClick={openSettings}>
                        <Icon name="settings" size={14} />
                        {t('添加模型 / AI 设置')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </footer>
          </main>
        </div>
      </section>

      {settingsPresence.mounted && createPortal(
        <div
          className="ai-settings-backdrop"
          data-closing={settingsPresence.closing ? 'true' : undefined}
          onClick={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}
        >
          <div className="ai-settings" role="dialog" aria-label={t('AI 设置')}>
            <header className="ai-settings-head">
              <h3>{t('AI 设置')}</h3>
              <button
                className="ai-icon-button"
                type="button"
                title={t('关闭')}
                onClick={() => setSettingsOpen(false)}
              >
                <Icon name="close" size={15} />
              </button>
            </header>

            <div className="ai-settings-body">
              <label className="ai-field">
                <span>{t('服务地址（OpenAI 兼容 base URL）')}</span>
                <input
                  type="text"
                  value={formBaseUrl}
                  onChange={event => setFormBaseUrl(event.target.value)}
                  placeholder="https://api.openai.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              <label className="ai-field">
                <span>
                  {'API Key '}
                  {config?.keyConfigured ? t('（已配置，留空保持不变）') : ''}
                </span>
                <input
                  type="password"
                  value={formApiKey}
                  onChange={event => setFormApiKey(event.target.value)}
                  placeholder={config?.keyConfigured ? '••••••••' : 'sk-…'}
                  autoComplete="new-password"
                />
              </label>

              <div className="ai-field">
                <span>{t('模型列表')}</span>
                <div className="ai-model-tags">
                  {formModels.map(model => (
                    <span key={model} className="ai-model-tag">
                      {model}
                      <button
                        type="button"
                        title={t('移除 {name}', { name: model })}
                        onClick={() => removeModel(model)}
                      >
                        <Icon name="close" size={11} />
                      </button>
                    </span>
                  ))}
                  {!formModels.length && (
                    <span className="ai-model-empty">{t('暂无模型，可手动添加或从服务拉取')}</span>
                  )}
                </div>
                <div className="ai-model-add">
                  <input
                    type="text"
                    value={newModel}
                    onChange={event => setNewModel(event.target.value)}
                    placeholder={t('添加模型 id，如 gpt-4o-mini')}
                    autoComplete="off"
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter')
                        return
                      event.preventDefault()
                      addModel()
                    }}
                  />
                  <button type="button" disabled={!newModel.trim()} onClick={addModel}>{t('添加')}</button>
                  <button type="button" disabled={saving || !formBaseUrl.trim()} onClick={() => void pullModels()}>
                    {fetchingModels ? t('拉取中…') : t('从服务拉取')}
                  </button>
                </div>
              </div>

              <label className="ai-field">
                <span>{t('当前模型')}</span>
                <select value={formModel} onChange={event => setFormModel(event.target.value)}>
                  {formModels.map(model => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>

              <label className="ai-field">
                <span>{t('思考程度（发送 reasoning_effort；「默认」不发送）')}</span>
                <select value={formReasoning} onChange={event => setFormReasoning(event.target.value)}>
                  <option value="">{t('默认（不发送）')}</option>
                  <option value="minimal">{t('minimal — 极简')}</option>
                  <option value="low">{t('low — 低')}</option>
                  <option value="medium">{t('medium — 中')}</option>
                  <option value="high">{t('high — 高')}</option>
                </select>
              </label>

              {settingsError
                ? (
                  <div className="ai-error">
                    <Icon name="alert" size={13} />
                    <span>{settingsError}</span>
                  </div>
                )
                : settingsNotice ? <div className="ai-notice">{settingsNotice}</div> : null}
            </div>

            <footer className="ai-settings-foot">
              <button type="button" onClick={() => setSettingsOpen(false)}>{t('取消')}</button>
              <button
                type="button"
                className="ai-primary"
                disabled={saving || !formBaseUrl.trim() || !formModels.length}
                onClick={() => void saveSettings()}
              >
                {saving ? t('保存中…') : t('保存')}
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
