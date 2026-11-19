// Account-level media cache settings: the proactive-cache switches and purge
// actions used by the "media and cache" settings category. Ported from the Vue
// component; the request sequence and error handling are unchanged.

import { useEffect, useRef, useState } from 'react'
import { wechatApi } from '../../api'
import { useStore } from '../../store/hooks'
import type { AccountSettings, ProactiveCacheKinds } from '../../types'

export type CacheKindItem = {
  key: keyof ProactiveCacheKinds
  label: string
  hint: string
}

/** Proactive cache switch rows; labels are Chinese source strings translated on render. */
export const CACHE_KIND_ITEMS: ReadonlyArray<CacheKindItem> = [
  { key: 'image', label: '图片', hint: '收到的图片' },
  { key: 'sticker', label: '表情', hint: '表情与贴纸' },
  { key: 'file', label: '文件', hint: '收到的文件' },
  { key: 'video', label: '视频', hint: '收到的视频' },
  { key: 'voice', label: '语音', hint: '语音消息' },
]

export type CacheAgeOption = {
  label: string
  seconds: number | null
}

/** Purge cut-offs, newest to oldest; null means "everything". */
export const CACHE_AGE_OPTIONS: ReadonlyArray<CacheAgeOption> = [
  { label: '24 小时', seconds: 24 * 3600 },
  { label: '3 天', seconds: 3 * 24 * 3600 },
  { label: '7 天', seconds: 7 * 24 * 3600 },
  { label: '14 天', seconds: 14 * 24 * 3600 },
  { label: '30 天', seconds: 30 * 24 * 3600 },
  { label: '全部', seconds: null },
]

const DEFAULT_PROACTIVE: ProactiveCacheKinds = { image: true, sticker: true, file: true, video: true, voice: true }

/** One purge confirmation: the cut-off in seconds and its catalogue label. */
export type PurgeConfirm = {
  seconds: number | null
  label: string
}

/** Last purge feedback: a freed byte count, or an empty result. */
export type PurgeResult = { files: number, size: string } | 'empty' | null

export type CacheSettingsHandle = {
  settings: AccountSettings | null
  loading: boolean
  savingKey: keyof ProactiveCacheKinds | null
  error: string
  purging: boolean
  purgeResult: PurgeResult
  purgeConfirm: PurgeConfirm | null
  toggleKind: (key: keyof ProactiveCacheKinds) => void
  requestPurge: (seconds: number | null) => void
  cancelPurge: () => void
  confirmPurge: () => void
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * Reads the account settings once per mounted panel, keeps one optimistic
 * switch update in flight, and runs the purge confirmation flow. Errors stay
 * local so the other settings keep working.
 */
export function useCacheSettings(active: boolean): CacheSettingsHandle {
  const accountId = useStore(state => state.session.account?.id ?? '')

  const [settings, setSettings] = useState<AccountSettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [savingKey, setSavingKey] = useState<keyof ProactiveCacheKinds | null>(null)
  const [error, setError] = useState('')
  const [purging, setPurging] = useState(false)
  const [purgeResult, setPurgeResult] = useState<PurgeResult>(null)
  const [purgeConfirm, setPurgeConfirm] = useState<PurgeConfirm | null>(null)

  // The guards are refs so the async flows read the latest values without
  // being recreated on every render.
  const settingsRef = useRef<AccountSettings | null>(null)
  const loadingRef = useRef(false)
  const savingRef = useRef<keyof ProactiveCacheKinds | null>(null)
  const purgingRef = useRef(false)

  function applySettings(next: AccountSettings | null): void {
    settingsRef.current = next
    setSettings(next)
  }

  /** Fetches the settings once; a failure only shows the error line. */
  async function ensureCacheSettings(id: string): Promise<void> {
    if (settingsRef.current || loadingRef.current)
      return
    loadingRef.current = true
    setLoading(true)
    setError('')
    try {
      const loaded = await wechatApi.getAccountSettings(id)
      applySettings(loaded.proactiveCache ? loaded : { ...loaded, proactiveCache: DEFAULT_PROACTIVE })
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : '读取设置失败')
    }
    finally {
      loadingRef.current = false
      setLoading(false)
    }
  }

  /** Optimistic switch update; a failed save rolls back and reports. */
  async function toggleCacheKind(key: keyof ProactiveCacheKinds): Promise<void> {
    const current = settingsRef.current
    const proactive = current?.proactiveCache
    if (!current || !proactive || savingRef.current || loadingRef.current)
      return
    const next: ProactiveCacheKinds = { ...proactive, [key]: !proactive[key] }
    applySettings({ ...current, proactiveCache: next })
    savingRef.current = key
    setSavingKey(key)
    setError('')
    try {
      await wechatApi.updateAccountSettings(accountId, {
        autoDownloadMaxBytes: current.autoDownloadMaxBytes,
        proactiveCache: next,
      })
    }
    catch (failure) {
      applySettings({ ...current, proactiveCache: proactive })
      setError(failure instanceof Error ? failure.message : '保存失败')
    }
    finally {
      savingRef.current = null
      setSavingKey(null)
    }
  }

  function requestPurge(seconds: number | null): void {
    if (purgingRef.current)
      return
    setPurgeConfirm({
      seconds,
      label: CACHE_AGE_OPTIONS.find(option => option.seconds === seconds)?.label ?? '全部',
    })
  }

  function cancelPurge(): void {
    setPurgeConfirm(null)
  }

  async function confirmPurge(): Promise<void> {
    const pending = purgeConfirm
    if (!pending || purgingRef.current)
      return
    setPurgeConfirm(null)
    purgingRef.current = true
    setPurging(true)
    setPurgeResult(null)
    setError('')
    try {
      const result = await wechatApi.purgeMediaCache(accountId, pending.seconds)
      setPurgeResult(result.files > 0 ? { files: result.files, size: formatBytes(result.bytes) } : 'empty')
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : '清理失败')
    }
    finally {
      purgingRef.current = false
      setPurging(false)
    }
  }

  // Opening the settings panel triggers the one lazy read, matching the Vue
  // component's ensureCacheSettings() call in toggleSettings().
  useEffect(() => {
    if (active && accountId)
      void ensureCacheSettings(accountId)
    // The guards inside ensureCacheSettings() make repeated opens a no-op.
  }, [active, accountId])

  return {
    settings,
    loading,
    savingKey,
    error,
    purging,
    purgeResult,
    purgeConfirm,
    toggleKind: (key) => {
      void toggleCacheKind(key)
    },
    requestPurge,
    cancelPurge,
    confirmPurge: () => {
      void confirmPurge()
    },
  }
}
