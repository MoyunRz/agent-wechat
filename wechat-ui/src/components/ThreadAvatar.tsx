// Thread avatar: hub avatar with a shared object-URL cache, fixed glyphs for
// WeChat system accounts, a member grid for groups, and an initials fallback.
// Cache and invalidation behaviour mirror the Vue component.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { wechatApi } from '../api'
import { initials } from '../format'
import {
  isWecomPeer,
  specialAvatarBackground,
  specialAvatarFor,
  WECOM_AVATAR_BACKGROUND,
  type SpecialAvatarId,
} from '../special-avatars'
import type { ThreadAvatarMember } from '../types'
import Icon from './Icon'
import '../styles/components/thread-avatar.css'

const REFRESH_TTL = 10 * 60 * 1000
const REFRESH_POLL_INTERVAL = 800
const REFRESH_POLL_LIMIT = 40

const refreshJobs = new Map<string, Promise<boolean>>()
const refreshResults = new Map<string, { ok: boolean, at: number }>()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function isTerminal(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired'
}

/**
 * Only the latest refresh result per contact is remembered, so the same contact
 * is not refreshed repeatedly by several message bubbles.
 */
function ensureAvatarCached(accountId: string, username: string): Promise<boolean> {
  const key = `${accountId}\n${username}`
  const remembered = refreshResults.get(key)
  if (remembered && Date.now() - remembered.at < REFRESH_TTL)
    return Promise.resolve(remembered.ok)
  const existing = refreshJobs.get(key)
  if (existing)
    return existing
  const job = refreshAvatarOnce(accountId, username)
    .then((ok) => {
      refreshResults.set(key, { ok, at: Date.now() })
      return ok
    })
    .finally(() => {
      refreshJobs.delete(key)
    })
  refreshJobs.set(key, job)
  return job
}

async function refreshAvatarOnce(accountId: string, username: string): Promise<boolean> {
  try {
    let operation = await wechatApi.refreshAvatar(accountId, username)
    for (let attempt = 0; attempt < REFRESH_POLL_LIMIT && !isTerminal(operation.state); attempt++) {
      await sleep(REFRESH_POLL_INTERVAL)
      operation = await wechatApi.getOperation(accountId, operation.id)
    }
    return operation.state === 'succeeded'
  }
  catch {
    return false
  }
}

function gradientFor(name: string): string {
  let hash = 0
  for (const char of name)
    hash = (hash * 31 + char.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${hash} 58% 42%), hsl(${(hash + 42) % 360} 62% 30%))`
}

function memberInitial(member: ThreadAvatarMember): string {
  return initials(member.displayName || member.id)
}

function memberStyle(member: ThreadAvatarMember): { background: string } {
  return { background: gradientFor(member.displayName || member.id) }
}

export type ThreadAvatarProps = {
  accountId: string
  name: string
  username?: string | null
  kind?: string
  members?: ThreadAvatarMember[]
  size?: number
  /** Avatar URL supplied directly (for example by a friend request payload); it wins over the hub avatar endpoint. */
  imageUrl?: string | null
  /** Fallback without an image: initials (default) or the grey user glyph. */
  fallback?: 'initials' | 'user'
  className?: string
}

function SpecialGlyph({ id }: { id: SpecialAvatarId }) {
  switch (id) {
    case 'filehelper':
      return (
        <svg className="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.3 16.6v-9M9.3 7.6 6.7 10.2" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M14.7 7.4v9M14.7 16.4l2.6-2.6" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      )
    case 'wechatpay':
      return (
        <svg className="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.4c-4.6 0-8.35 3.2-8.35 7.13 0 2.23 1.16 4.22 2.99 5.56l-.62 2.86a.58.58 0 0 0 .84.64l3.5-1.96c.53.1 1.08.15 1.64.15 4.6 0 8.35-3.2 8.35-7.13S16.6 3.4 12 3.4z" fill="#fff" />
          <path d="m8.6 11.5 2.4 2.4 4.4-4.6" stroke="#089a4b" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      )
    case 'weixinTeam':
      return (
        <svg className="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10.1 4.5c-4.3 0-7.7 2.8-7.7 6.2 0 1.9 1.1 3.7 2.8 4.8l-.7 3.2 3.4-1.8c.7.2 1.4.3 2.2.3h.4a6 6 0 0 1-.3-1.9c0-3.2 3.2-5.8 7.2-5.8h.4c-.7-3-3.9-5-7.7-5Z" fill="#fff" />
          <circle cx="7.7" cy="9.1" r="1" fill="#0aa14c" />
          <circle cx="12.5" cy="9.1" r="1" fill="#0aa14c" />
          <path d="M16.9 10.9c-2.9 0-5.2 1.8-5.2 4s2.3 4 5.2 4c.5 0 1-.1 1.5-.2l2.4 1.2-.6-2.1c1.1-.7 1.8-1.7 1.8-2.9 0-2.2-2.3-4-5.1-4Z" fill="#fff" />
        </svg>
      )
    case 'friendSuggest':
      return (
        <svg className="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10" cy="9" r="3.2" fill="#fff" />
          <path d="M4.3 18.6a5.8 5.8 0 0 1 11.4 0c-1.5.9-3.4 1.4-5.7 1.4s-4.2-.5-5.7-1.4Z" fill="#fff" />
          <path d="M17.6 7.7v4.2M15.5 9.8h4.2" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" fill="none" />
        </svg>
      )
    case 'voiceMemo':
      return (
        <svg className="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9.5" y="4" width="5" height="9.2" rx="2.5" fill="#fff" />
          <path d="M6.7 11.4a5.3 5.3 0 0 0 10.6 0" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" fill="none" />
          <path d="M12 16.9v2.7M9.3 19.6h5.4" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" fill="none" />
        </svg>
      )
    case 'service':
      return (
        <svg className="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18.9 3.85a1.15 1.15 0 0 1 1.73 1v14.3a1.15 1.15 0 0 1-1.73 1L9.3 14.95H5.55A1.95 1.95 0 0 1 3.6 13v-2a1.95 1.95 0 0 1 1.95-1.95H9.3z" fill="#fff" />
          <path d="M7.5 16.15h2.9v1.75a1.9 1.9 0 0 1-3.8 0v-1.75z" fill="#fff" />
        </svg>
      )
    default:
      return (
        <svg className="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.25 7A2.25 2.25 0 0 1 5.5 4.75h3.9c.66 0 1.28.3 1.7.8l1.06 1.28h6.34a2.25 2.25 0 0 1 2.25 2.25v8.17a2.25 2.25 0 0 1-2.25 2.25h-13a2.25 2.25 0 0 1-2.25-2.25V7z" fill="#fff" />
        </svg>
      )
  }
}

function WecomGlyph() {
  return (
      <svg className="special-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.1 6A2.15 2.15 0 0 1 6.25 3.85h7.9A2.15 2.15 0 0 1 16.3 6v5.4a2.15 2.15 0 0 1-2.15 2.15H9.6l-3.9 3.1v-3.1h.55A2.15 2.15 0 0 1 4.1 11.4Z" fill="#fff" />
        <path d="M14.9 10.3h3a2.15 2.15 0 0 1 2.15 2.15v3.2a2.15 2.15 0 0 1-2.15 2.15h-.35v2.3l-2.85-2.3h-2a2.15 2.15 0 0 1-2-1.4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
  )
}

export default function ThreadAvatar({
  accountId,
  name,
  username = null,
  kind = 'direct',
  members = [],
  size = 46,
  imageUrl = null,
  fallback = 'initials',
  className,
}: ThreadAvatarProps) {
  const identity = username?.trim() ?? ''
  const special = specialAvatarFor(username, name)
  const specialBackground = special ? specialAvatarBackground(special) : ''
  const isWecom = isWecomPeer(identity)
  const isGroup = kind === 'group'
  const memberList = members.slice(0, 4)
  const useGrid = isGroup && memberList.length >= 2

  const [avatarObjectUrl, setAvatarObjectUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const versionRef = useRef(0)
  const refreshAttemptedRef = useRef(false)
  const identityTokenRef = useRef(0)
  const avatarLoadSeqRef = useRef(0)
  const loadRetriedRef = useRef(false)
  const retryTimerRef = useRef<number | null>(null)

  async function loadAvatarBytes(): Promise<void> {
    if (!accountId || !identity || special) {
      setAvatarObjectUrl(null)
      return
    }
    const seq = ++avatarLoadSeqRef.current
    try {
      // Cached load: view switches and list rebuilds reuse the cached object URL.
      const url = await wechatApi.loadAvatarCached(accountId, identity, versionRef.current)
      if (seq !== avatarLoadSeqRef.current)
        return
      setAvatarObjectUrl(url)
      if (!url) {
        // Nothing cached yet: ask WeChat once, then fetch the bytes again.
        setFailed(false)
        if (!refreshAttemptedRef.current) {
          refreshAttemptedRef.current = true
          const token = identityTokenRef.current
          const ok = await ensureAvatarCached(accountId, identity)
          if (token === identityTokenRef.current && ok) {
            versionRef.current = Date.now()
            void loadAvatarBytes()
          }
        }
        return
      }
      setFailed(false)
    }
    catch {
      if (seq !== avatarLoadSeqRef.current)
        return
      setAvatarObjectUrl(null)
      // A transient failure (network jitter, daemon restart) must not stick to
      // initials forever: retry once after a short delay.
      if (!loadRetriedRef.current) {
        loadRetriedRef.current = true
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          if (seq === avatarLoadSeqRef.current)
            void loadAvatarBytes()
        }, 4000)
      }
    }
  }

  const invalidateRef = useRef<() => void>(() => {})

  // Identity changes reload the avatar. The layout effect runs before paint, so
  // the previous contact's image is dropped before it could be shown again.
  // It also keeps the invalidation handler bound to the current identity, so the
  // window listener below never runs with a stale account or username.
  useLayoutEffect(() => {
    /**
     * The whole avatar cache is replaced after a daemon restart: the shell
     * dispatches 'wx-avatars-invalidated' when the event stream reconnects, and
     * every avatar resets and fetches again from the new cache epoch.
     */
    invalidateRef.current = () => {
      if (imageUrl?.trim() || special)
        return
      identityTokenRef.current += 1
      setFailed(false)
      refreshAttemptedRef.current = false
      loadRetriedRef.current = false
      void loadAvatarBytes()
    }

    identityTokenRef.current += 1
    setFailed(false)
    refreshAttemptedRef.current = false
    loadRetriedRef.current = false
    versionRef.current = 0
    // A same-identity invalidation (event stream reconnect) intentionally keeps
    // the old image to avoid a flash; only a new identity clears it first.
    setAvatarObjectUrl(null)
    if (special)
      return
    if (imageUrl?.trim())
      return
    void loadAvatarBytes()
  }, [accountId, identity, imageUrl, special])

  useEffect(() => {
    const handler = () => invalidateRef.current()
    window.addEventListener('wx-avatars-invalidated', handler)
    return () => window.removeEventListener('wx-avatars-invalidated', handler)
  }, [])

  useEffect(() => () => {
    if (retryTimerRef.current !== null)
      window.clearTimeout(retryTimerRef.current)
  }, [])

  const fallbackStyle = {
    // Unrecognised built-in system threads keep the purple avatar; ordinary
    // threads are coloured by a hash of their name.
    background: kind === 'system'
      ? 'linear-gradient(135deg, #8b5cf6, #6d28d9)'
      : gradientFor(name),
  }

  const rootClassName = ['thread-avatar', isGroup && 'is-group', className].filter(Boolean).join(' ')

  let content: ReactNode
  if (avatarObjectUrl && !failed) {
    content = <img src={avatarObjectUrl} alt="" draggable={false} />
  }
  else if (useGrid) {
    content = (
      <div className="member-grid">
        {memberList.map(member => (
          <span key={member.id} className="member-cell" style={memberStyle(member)}>
            {memberInitial(member)}
          </span>
        ))}
      </div>
    )
  }
  else if (special) {
    content = (
      <span className="fallback special" style={{ background: specialBackground }}>
        <SpecialGlyph id={special} />
      </span>
    )
  }
  else if (isWecom) {
    content = (
      <span className="fallback special" style={{ background: WECOM_AVATAR_BACKGROUND }}>
        <WecomGlyph />
      </span>
    )
  }
  else if (fallback === 'user') {
    content = (
      <span className="fallback user-fallback" aria-hidden="true">
        <Icon name="user" size={Math.max(16, Math.round(size * 0.52))} />
      </span>
    )
  }
  else {
    content = (
      <span className="fallback" style={fallbackStyle}>
        {initials(name)}
      </span>
    )
  }

  return (
    <div className={rootClassName} style={{ width: `${size}px`, height: `${size}px` }}>
      {content}
    </div>
  )
}
