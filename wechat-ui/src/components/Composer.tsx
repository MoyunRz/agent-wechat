// Message composer. It takes no props: the draft, staged attachments, quoted
// message and mention list all come from the store, and every interaction calls
// an action. The textarea keeps the Vue component's auto-grow and its
// Enter/Shift+Enter contract.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from 'react'
import { EMOTICON_LIST } from '../emoticons'
import { threadName } from '../format'
import { useT } from '../i18n/useT'
import {
  cancelReply,
  ensureGroupMembers,
  registerComposerHandle,
  removeAttachment,
  selectActiveThread,
  selectActiveThreadIsGroup,
  selectConnectionState,
  selectMentionLoading,
  selectMentionOptions,
  selectReplyToDisplay,
  sendMessage,
  setDraft,
  stageFiles,
} from '../store/actions'
import { useStore } from '../store/hooks'
import { registerComposerView } from '../store/viewRefs'
import type { MentionOption, StagedAttachment } from '../types'
import Icon from './Icon'
import LoadingDots from './LoadingDots'
import type { IconName } from './Icon'
import '../styles/components/composer.css'

const MAX_TEXTAREA_HEIGHT = 132
/** Grace period after blur so a click on a mention entry still lands. */
const MENTION_BLUR_DELAY = 150
const MENTION_ITEMS_LIMIT = 50

function iconFor(kind: StagedAttachment['kind']): IconName {
  switch (kind) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'voice':
      return 'mic'
    default:
      return 'paperclip'
  }
}

export default function Composer() {
  const t = useT()
  const draft = useStore(state => state.messages.draft)
  const attachments = useStore(state => state.messages.attachments)
  const activeThread = useStore(selectActiveThread)
  const activeThreadId = useStore(state => state.threads.activeThreadId)
  const mentionAvailable = useStore(selectActiveThreadIsGroup)
  const mentionOptions = useStore(selectMentionOptions)
  const mentionLoading = useStore(selectMentionLoading)
  const replyTo = useStore(selectReplyToDisplay)
  const connectionState = useStore(selectConnectionState)

  const disabled = connectionState === 'offline'
  // The shell has no sending flag (the Vue shell never passed one either):
  // queued sends are shown on the optimistic bubble instead. The branch is kept
  // so the send button markup stays identical to the Vue component.
  const sending = false
  const canSend = Boolean(draft.trim()) || attachments.length > 0
  const placeholder = activeThread
    ? t('发消息给 {name}', { name: t(threadName(activeThread)) })
    : t('输入消息')

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  /** Caret position requested by an insertion, applied after the draft renders. */
  const pendingSelectionRef = useRef<number | null>(null)
  const composingRef = useRef(false)
  const mentionBlurTimer = useRef<number | null>(null)

  const [showEmoticons, setShowEmoticons] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionTriggerStart, setMentionTriggerStart] = useState(-1)
  const [mentionActive, setMentionActive] = useState(0)

  const mentionItems = buildMentionItems(mentionOptions, mentionQuery)

  function closeMention(): void {
    setMentionOpen(false)
    setMentionQuery('')
    setMentionTriggerStart(-1)
  }

  function cancelMentionBlur(): void {
    if (mentionBlurTimer.current !== null) {
      window.clearTimeout(mentionBlurTimer.current)
      mentionBlurTimer.current = null
    }
  }

  function closeMentionSoon(): void {
    cancelMentionBlur()
    mentionBlurTimer.current = window.setTimeout(() => {
      mentionBlurTimer.current = null
      closeMention()
    }, MENTION_BLUR_DELAY)
  }

  function resize(): void {
    const el = textareaRef.current
    if (!el)
      return
    el.style.height = 'auto'
    const contentHeight = el.scrollHeight
    el.style.height = `${Math.min(contentHeight, MAX_TEXTAREA_HEIGHT)}px`
    el.style.overflowY = contentHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden'
  }

  const focus = useCallback((): void => {
    textareaRef.current?.focus()
  }, [])

  function toggleEmoticons(): void {
    if (disabled)
      return
    setShowEmoticons(!showEmoticons)
  }

  function closeEmoticons(): void {
    setShowEmoticons(false)
  }

  /** Inserts the emoticon token at the caret and moves the caret after it. */
  function insertEmoticon(name: string): void {
    if (disabled)
      return
    const el = textareaRef.current
    const token = `[${name}]`
    const value = draft
    if (el) {
      const start = el.selectionStart ?? value.length
      const end = el.selectionEnd ?? value.length
      pendingSelectionRef.current = start + token.length
      setDraft(value.slice(0, start) + token + value.slice(end))
    }
    else {
      setDraft(value + token)
    }
  }

  /**
   * Detects an '@keyword' fragment before the caret: it must follow the start
   * of the text or whitespace and must not contain the mention separator
   * U+2005. With no arguments the value and caret come from the textarea.
   */
  function detectMention(value?: string, caret?: number): void {
    cancelMentionBlur()
    if (!mentionAvailable || disabled) {
      closeMention()
      return
    }
    const el = textareaRef.current
    const text = value ?? draft
    const at = caret ?? el?.selectionStart ?? text.length
    const match = /(?:^|\s)@([^\u2005]*)$/u.exec(text.slice(0, at))
    if (!match) {
      closeMention()
      return
    }
    const wasClosed = !mentionOpen
    setMentionOpen(true)
    setMentionQuery(match[1])
    setMentionTriggerStart(at - match[1].length - 1)
    setMentionActive(0)
    if (wasClosed)
      void ensureGroupMembers(activeThreadId ?? '')
  }

  function selectMention(option: MentionOption): void {
    cancelMentionBlur()
    const el = textareaRef.current
    const value = draft
    const caret = el?.selectionStart ?? value.length
    const start = mentionTriggerStart
    if (start < 0 || start > caret) {
      closeMention()
      return
    }
    // Mention spans end with U+2005 (four-per-em space); sending scans for it.
    const token = `@${option.label}\u{2005}`
    pendingSelectionRef.current = start + token.length
    setDraft(value.slice(0, start) + token + value.slice(caret))
    closeMention()
  }

  /** Toolbar @ button: inserts '@' at the caret and opens the picker. */
  function triggerMentionPicker(): void {
    if (disabled || !mentionAvailable)
      return
    cancelMentionBlur()
    const el = textareaRef.current
    const value = draft
    const caret = el?.selectionStart ?? value.length
    const previous = value[caret - 1] ?? ''
    const prefix = caret > 0 && !/\s/u.test(previous) ? ' ' : ''
    pendingSelectionRef.current = caret + prefix.length + 1
    setDraft(value.slice(0, caret) + prefix + '@' + value.slice(caret))
    setMentionOpen(true)
    setMentionQuery('')
    setMentionTriggerStart(caret + prefix.length)
    setMentionActive(0)
    void ensureGroupMembers(activeThreadId ?? '')
  }

  function openFilePicker(): void {
    if (disabled)
      return
    fileInputRef.current?.click()
  }

  function onFilesPicked(event: ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])
    if (files.length > 0)
      stageFiles(files)
    input.value = ''
  }

  /** Pasted images and files are staged; plain text keeps the default paste. */
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    if (disabled)
      return
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length === 0)
      return
    event.preventDefault()
    stageFiles(files)
  }

  function submit(): void {
    if (disabled || sending)
      return
    if (!canSend)
      return
    void sendMessage()
  }

  function onInput(event: ChangeEvent<HTMLTextAreaElement>): void {
    const target = event.target
    setDraft(target.value)
    resize()
    detectMention(target.value, target.selectionStart ?? undefined)
  }

  function onKeydown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (mentionOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMention()
        return
      }
      if (event.key === 'ArrowDown' && mentionItems.length > 0) {
        event.preventDefault()
        setMentionActive((mentionActive + 1) % mentionItems.length)
        return
      }
      if (event.key === 'ArrowUp' && mentionItems.length > 0) {
        event.preventDefault()
        setMentionActive((mentionActive - 1 + mentionItems.length) % mentionItems.length)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current) {
        const item = mentionItems[mentionActive]
        if (item) {
          event.preventDefault()
          selectMention(item)
          return
        }
        // Without a selectable entry, collapse the panel and let Enter send.
        closeMention()
      }
    }
    if (event.key === 'Escape' && showEmoticons) {
      event.preventDefault()
      closeEmoticons()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composingRef.current)
      return
    event.preventDefault()
    submit()
  }

  // The Vue watcher on the model value: refit the textarea after every change,
  // collapse the mention picker when the draft was cleared (for example after a
  // send), and place the caret an insertion asked for.
  useEffect(() => {
    resize()
    if (!draft)
      closeMention()
    if (pendingSelectionRef.current !== null) {
      const caret = pendingSelectionRef.current
      pendingSelectionRef.current = null
      focus()
      const el = textareaRef.current
      if (el) {
        el.selectionStart = caret
        el.selectionEnd = caret
      }
    }
  }, [draft])

  useEffect(() => {
    resize()
  }, [])

  useEffect(() => {
    const handle = { focus }
    // Two registries exist: the view registry and the action handle that
    // startReply and sendMessage read. Expose focus to both.
    registerComposerView(handle)
    registerComposerHandle(handle)
    return () => {
      registerComposerHandle(null)
      registerComposerView(null)
      if (mentionBlurTimer.current !== null) {
        window.clearTimeout(mentionBlurTimer.current)
        mentionBlurTimer.current = null
      }
    }
  }, [focus])

  return (
    <footer className="composer">
      <div className={disabled ? 'composer-box disabled' : 'composer-box'}>
        <input
          className="file-input"
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          onChange={onFilesPicked}
        />

        {replyTo
          ? (
            <div className="reply-bar">
              <Icon name="reply" size={13} className="reply-bar-icon" />
              <span className="reply-bar-text">
                <strong>{replyTo.sender}</strong>{replyTo.preview}
              </span>
              <button
                className="reply-bar-close"
                type="button"
                title={t('取消引用')}
                onClick={cancelReply}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )
          : null}

        {attachments.length > 0
          ? (
            <div className="staged-list">
              {attachments.map(item => (
                <div key={item.id} className="staged-item">
                  {item.kind === 'image' && item.previewUrl
                    ? <img src={item.previewUrl} alt="" className="staged-preview" />
                    : (
                      <span className="staged-icon">
                        <Icon name={iconFor(item.kind)} size={15} />
                      </span>
                    )}
                  <span className="staged-name">{item.name}</span>
                  <button
                    className="staged-remove"
                    type="button"
                    title={t('移除附件')}
                    onClick={() => removeAttachment(item.id)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
            </div>
          )
          : null}

        {showEmoticons
          ? (
            <div className="emoticon-panel">
              <div className="emoticon-head">
                <span>{t('黄豆表情')}</span>
                <button className="emoticon-close" type="button" title={t('收起')} onClick={closeEmoticons}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              <div className="emoticon-grid">
                {EMOTICON_LIST.map(item => (
                  <button
                    key={item.name}
                    className="emoticon-cell"
                    type="button"
                    title={`[${item.name}]`}
                    onClick={() => insertEmoticon(item.name)}
                  >
                    {item.emoji}
                  </button>
                ))}
              </div>
            </div>
          )
          : null}

        {mentionOpen
          ? (
            <div className="mention-panel">
              {mentionLoading && mentionOptions.length === 0
                ? (
                  <div className="mention-empty">
                    <LoadingDots />
                    {t('成员加载中…')}
                  </div>
                )
                : mentionItems.length === 0
                  ? <div className="mention-empty">{t('没有匹配的成员')}</div>
                  : (
                    <div className="mention-list scrollbar-thin">
                      {mentionItems.map((item, index) => (
                        <button
                          key={item.id}
                          className={index === mentionActive ? 'mention-item active' : 'mention-item'}
                          type="button"
                          title={item.id}
                          onMouseDown={event => event.preventDefault()}
                          onClick={() => selectMention(item)}
                        >
                          <span className="mention-at">@</span>
                          <span className="mention-label">{item.label}</span>
                          {item.all ? <span className="mention-tag">{t('全体成员')}</span> : null}
                        </button>
                      ))}
                    </div>
                  )}
            </div>
          )
          : null}

        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          onChange={onInput}
          onKeyDown={onKeydown}
          onPaste={onPaste}
          onClick={() => detectMention()}
          onBlur={closeMentionSoon}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
        />

        <div className="composer-toolbar">
          <div className="composer-tools">
            <button
              className={showEmoticons ? 'tool-button active' : 'tool-button'}
              type="button"
              title={t('黄豆表情')}
              disabled={disabled}
              onClick={toggleEmoticons}
            >
              <Icon name="smile" size={16} />
            </button>
            <button
              className="tool-button"
              type="button"
              title={t('发送图片、视频或语音')}
              disabled={disabled}
              onClick={openFilePicker}
            >
              <Icon name="paperclip" size={16} />
            </button>
            <button
              className="tool-button"
              type="button"
              title={mentionAvailable ? t('提及群成员') : t('群聊中可提及成员')}
              disabled={disabled || !mentionAvailable}
              onClick={triggerMentionPicker}
            >
              <Icon name="at" size={16} />
            </button>
          </div>

          <div className="composer-actions">
            <span className="composer-hint">{t('Enter 发送 · Shift + Enter 换行')}</span>
            <button
              className="send-button"
              type="button"
              disabled={disabled || sending || !canSend}
              title={sending ? t('发送中') : t('发送 (Enter)')}
              onClick={submit}
            >
              <span>{t('发送')}</span>
              {sending
                ? <LoadingDots />
                : <Icon name="send" size={14} />}
            </button>
          </div>
        </div>
      </div>
    </footer>
  )
}

/** Filters the mention entries the way the Vue computed property did. */
function buildMentionItems(options: MentionOption[], query: string): MentionOption[] {
  const needle = query.trim().toLowerCase()
  const all = options.filter(option => option.all)
  const rest = options.filter(option => !option.all)
  const matched = needle
    ? rest.filter(option => option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle))
    : rest
  const allMatched = needle
    ? all.filter(option => option.label.toLowerCase().includes(needle))
    : all
  return [...allMatched, ...matched].slice(0, MENTION_ITEMS_LIMIT)
}
