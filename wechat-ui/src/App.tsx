import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import brandLogoUrl from './assets/agent-wechat-logo.svg'
import { hasHubAuth } from './api'
import { formatListTime, threadKindLabel, threadName } from './format'
import { useT } from './i18n/useT'
import { isDesktop } from './platform/env'
import { startRouter, syncLocationHash } from './platform/router'
import {
  setNotificationContext,
  subscribeDesktopNotifications,
  useDesktopSession,
  whenDesktopSessionReady,
} from './platform/desktop'
import { getState } from './store/state'
import { HubConnectScreen } from './components/desktop/HubConnectScreen'
import { DesktopUpdateBanner } from './components/desktop/DesktopUpdateBanner'
import type { Contact } from './types'
import {
  bootstrap,
  dismissToast,
  goBackToList,
  jumpToLatestMessage,
  jumpToSearchResult,
  loadThreads,
  markActiveThreadRead,
  openToast,
  refreshAccount,
  refreshActiveMessages,
  selectActiveThread,
  selectActiveThreadIsOfficial,
  selectConnectionState,
  selectContactProfileName,
  selectDetailsPeerId,
  selectMobileChatOpen,
  selectThread,
  threadSearchSender,
  threadSearchSnippet,
  selectPeerIsStranger,
  selectStreamLabel,
  setContactDialogOpen,
  setDetailsOpen,
  setLightboxSrc,
  setQrFailed,
  setThreadSearchQuery,
  startChatWithContact,
  startChatWithId,
  startLogin,
  cancelLogin,
  clearAccountActionError,
  retryQr,
  toggleThreadSearch,
  startEngine,
} from './store/actions'
import { useStore } from './store/hooks'
import AppRail from './components/AppRail'
import Composer from './components/Composer'
import ContactSearchDialog from './components/ContactSearchDialog'
import ContactsPanel from './components/ContactsPanel'
import Icon from './components/Icon'
import LoginPanel from './components/LoginPanel'
import MessageList from './components/MessageList'
import ThreadAvatar from './components/ThreadAvatar'
import ThreadList from './components/ThreadList'

// The AI panel is only reachable from the rail, so it stays out of the initial
// bundle.
const AiChatPanel = lazy(() => import('./components/AiChatPanel'))

export default function App() {
  const t = useT()
  const booting = useStore(state => state.session.booting)
  const bootError = useStore(state => state.session.bootError)
  const account = useStore(state => state.session.account)
  const railView = useStore(state => state.ui.railView)
  const activeThread = useStore(selectActiveThread)
  const activeThreadId = useStore(state => state.threads.activeThreadId)
  const isNarrow = useStore(state => state.threads.isNarrow)
  const mobileChatOpen = useStore(selectMobileChatOpen)
  const detailsOpen = useStore(state => state.threads.detailsOpen)
  const contactDialogOpen = useStore(state => state.threads.contactDialogOpen)
  const connectionState = useStore(selectConnectionState)
  const peerIsStranger = useStore(selectPeerIsStranger)
  const accountActionError = useStore(state => state.session.accountActionError)
  const threadsError = useStore(state => state.threads.error)
  const messageError = useStore(state => state.messages.error)
  const manualRefreshing = useStore(state => state.session.manualRefreshing)
  const streamStatus = useStore(state => state.session.streamStatus)
  const streamLabel = useStore(selectStreamLabel)
  const searchOpen = useStore(state => state.messages.searchOpen)
  const searchQuery = useStore(state => state.messages.searchQuery)
  const searchResults = useStore(state => state.messages.searchResults)
  const searching = useStore(state => state.messages.searching)
  const lightboxSrc = useStore(state => state.messages.lightboxSrc)
  const unseenBelow = useStore(state => state.messages.unseenBelow)
  const toasts = useStore(state => state.ui.toasts)
  const activeThreadIsOfficial = useStore(selectActiveThreadIsOfficial)
  const contactProfile = useStore(state => state.threads.contactProfile)
  const contactProfileLoading = useStore(state => state.threads.contactProfileLoading)
  const contactProfileError = useStore(state => state.threads.contactProfileError)
  const contactProfileName = useStore(selectContactProfileName)
  const detailsPeerId = useStore(selectDetailsPeerId)
  const loginAttempt = useStore(state => state.session.loginAttempt)
  const qrObjectUrl = useStore(state => state.session.qrObjectUrl)
  const qrFailed = useStore(state => state.session.qrFailed)
  const loginBusy = useStore(state => state.session.loginBusy)
  const loginError = useStore(state => state.session.loginError)

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const desktop = isDesktop()
  const desktopSession = useDesktopSession()
  const desktopHubId = desktopSession.session?.id ?? ''
  // The engine starts once. In the desktop shell that is after the hub session
  // resolves, and again when the user connects a different hub.
  const [engineReady, setEngineReady] = useState(!desktop)

  useEffect(() => {
    if (!desktop) {
      const dispose = startEngine()
      return dispose
    }
    let active = true
    let dispose: (() => void) | null = null
    void whenDesktopSessionReady().then((session) => {
      if (!active || !session)
        return
      dispose = startEngine()
      setEngineReady(true)
    })
    return () => {
      active = false
      if (dispose)
        dispose()
    }
  }, [desktop, desktopHubId])

  // Keep the notification service pointed at what the window is showing, and
  // open the conversation a notification was clicked for.
  useEffect(() => {
    if (!desktop || !desktopHubId)
      return
    void setNotificationContext({
      connectionId: desktopHubId,
      accountId: account?.id ?? null,
      threadId: activeThreadId ?? null,
    }).catch(() => undefined)
  }, [desktop, desktopHubId, account?.id, activeThreadId])

  useEffect(() => {
    if (!desktop)
      return undefined
    return subscribeDesktopNotifications((target) => {
      const open = (): void => {
        const known = getState().threads.items.find(thread => thread.id === target.threadId)
        if (known) {
          void selectThread(known)
          return
        }
        void loadThreads().then(() => {
          const loaded = getState().threads.items.find(thread => thread.id === target.threadId)
          if (loaded)
            void selectThread(loaded)
        })
      }
      open()
    })
  }, [desktop])

  // The address is the shell's view contract: a reload, a notification or the
  // desktop shell's open-thread event all land on the same screen. It can only
  // be applied once the account exists, because the routes name its data.
  useEffect(() => {
    if (!account)
      return undefined
    return startRouter()
  }, [account?.id])

  const settingsOpen = useStore(state => state.ui.settingsOpen)
  useEffect(() => {
    if (engineReady)
      syncLocationHash()
  }, [engineReady, railView, activeThreadId, detailsOpen, contactDialogOpen, settingsOpen])

  useEffect(() => {
    if (searchOpen)
      searchInputRef.current?.focus()
  }, [searchOpen])

  const authenticated = hasHubAuth()

  if (desktop && !desktopSession.ready) {
    return (
      <div className="app-shell">
        <div className="boot-screen">
          <span className="boot-logo"><img src={brandLogoUrl} alt="Agent WeChat" width={58} height={58} /></span>
          <span className="boot-spinner"><Icon name="refresh" size={16} className="spin" /></span>
          <p>{t('正在连接本机 Hub')}</p>
        </div>
      </div>
    )
  }

  if (desktop && !desktopSession.session) {
    return (
      <HubConnectScreen
        onConnected={() => undefined}
        initialError={desktopSession.error}
      />
    )
  }

  if (booting && (!desktop || engineReady)) {
    return (
      <div className="app-shell">
        <div className="boot-screen">
          <span className="boot-logo"><img src={brandLogoUrl} alt="Agent WeChat" width={58} height={58} /></span>
          <span className="boot-spinner"><Icon name="refresh" size={16} className="spin" /></span>
          <p>{t('正在加载微信会话')}</p>
        </div>
      </div>
    )
  }

  if (bootError && !account) {
    return (
      <div className="app-shell">
        <div className="boot-screen">
          <span className="boot-logo error"><Icon name="alert" size={26} /></span>
          <p>{bootError}</p>
          <button className="boot-retry" type="button" onClick={() => void bootstrap()}>{t('重试')}</button>
        </div>
      </div>
    )
  }

  if (!authenticated) {
    return (
      <div className="app-shell">
        <div className="boot-screen">
          <span className="boot-logo error"><Icon name="alert" size={26} /></span>
          <p>{t('缺少访问凭据：请使用 Hub 启动日志里的一键链接打开本页面。')}</p>
        </div>
      </div>
    )
  }

  if (!account) {
    return (
      <div className="app-shell">
        <div className="boot-screen">
          <span className="boot-logo"><img src={brandLogoUrl} alt="Agent WeChat" width={58} height={58} /></span>
          <p>{t('正在加载微信会话')}</p>
        </div>
      </div>
    )
  }

  const signedIn = Boolean(account.authenticated || account.savedLogin)

  if (!signedIn) {
    return (
      <div className="app-shell">
        <LoginPanel
          account={account}
          attempt={loginAttempt}
          qrUrl={qrObjectUrl}
          qrFailed={qrFailed}
          busy={loginBusy}
          error={loginError}
          onStart={() => void startLogin()}
          onCancel={() => void cancelLogin()}
          onRefresh={() => void refreshAccount()}
          onRetryQr={() => void retryQr()}
          onQrError={() => setQrFailed(true)}
        />
      </div>
    )
  }

  return (
    <div className="app-shell-wrap">
      <DesktopUpdateBanner />
      <div className={`app-shell${isNarrow ? ' is-narrow' : ''}${mobileChatOpen ? ' chat-open' : ''}`}>
        <AppRail />

      {railView === 'ai'
        ? <Suspense fallback={null}><AiChatPanel account={account} /></Suspense>
        : (
          <>
            <div className="rail-slot" hidden={railView !== 'chats'}><ThreadList /></div>
            <div className="rail-slot" hidden={railView !== 'contacts'}><ContactsPanel /></div>

            <main className="chat-pane">
              <header className="chat-header">
                {activeThread
                  ? (
                    <>
                      {isNarrow && (
                        <button
                          type="button"
                          className="icon-button back-button"
                          title={t('返回会话列表')}
                          aria-label={t('返回会话列表')}
                          onClick={goBackToList}
                        >
                          <Icon name="chevron-left" size={20} />
                        </button>
                      )}
                      <button type="button" className="chat-avatar-button" title={t('查看个人信息')} onClick={() => setDetailsOpen(true)}>
                        <ThreadAvatar
                          accountId={account.id}
                          name={threadName(activeThread)}
                          username={activeThread.peerId}
                          kind={activeThread.kind}
                          members={activeThread.avatarMembers}
                          size={36}
                        />
                        <span
                          className="chat-avatar-stream"
                          data-live={streamStatus === 'live'}
                          title={streamLabel}
                          aria-label={streamLabel}
                        />
                      </button>
                      <div className="chat-title">
                        <h2>{threadName(activeThread)}</h2>
                        <p>
                          {t(threadKindLabel(activeThread.kind, activeThread.peerId))}
                          {(activeThread.unreadCount ?? 0) > 0 ? ` · ${activeThread.unreadCount} ${t('条未读')}` : ''}
                        </p>
                      </div>
                      <div className="chat-actions">
                        <button
                          className={`icon-button${searchOpen ? ' active' : ''}`}
                          type="button"
                          title={t('查找聊天记录')}
                          onClick={toggleThreadSearch}
                        >
                          <Icon name="search" size={16} />
                        </button>
                        <button
                          className={`icon-button${detailsOpen ? ' active' : ''}`}
                          type="button"
                          title={t('会话详情')}
                          onClick={() => setDetailsOpen(!detailsOpen)}
                        >
                          <Icon name="panel" size={16} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          title={t('刷新聊天')}
                          disabled={manualRefreshing}
                          onClick={() => void refreshActiveMessages()}
                        >
                          <Icon name="refresh" size={16} className={manualRefreshing ? 'spin' : undefined} />
                        </button>
                      </div>
                    </>
                  )
                  : (
                    <>
                      <span className="brand-logo"><img src={brandLogoUrl} alt="" width={34} height={34} /></span>
                      <div className="chat-title">
                        <h2>Agent WeChat</h2>
                        <p>{t('面向人与 AI 智能体的开源微信客户端')}</p>
                      </div>
                      <div className="chat-actions">
                        <button className="icon-button" type="button" title={t('搜索聊天')} onClick={() => { /* focus thread list search */ }}>
                          <Icon name="search" size={16} />
                        </button>
                      </div>
                    </>
                  )}
              </header>

              {searchOpen && activeThread && (
                <section className="thread-search-panel">
                  <div className="thread-search-input">
                    <Icon name="search" size={14} />
                    <input
                      ref={searchInputRef}
                      value={searchQuery}
                      type="text"
                      placeholder={t('查找当前会话的历史消息')}
                      onChange={event => setThreadSearchQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          toggleThreadSearch()
                        }
                      }}
                    />
                    {searchQuery && (
                      <button type="button" className="thread-search-clear" title={t('清空')} onClick={() => setThreadSearchQuery('')}>
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </div>
                  {searching
                    ? <div className="thread-search-status"><Icon name="refresh" size={12} className="spin" />{t('搜索中…')}</div>
                    : searchResults.length === 0 && searchQuery.trim()
                      ? <div className="thread-search-status">{t('没有找到相关聊天记录')}</div>
                      : searchResults.length > 0
                        ? (
                          <div className="thread-search-results scrollbar-thin">
                            {searchResults.map(item => (
                              <button key={item.id} type="button" className="thread-search-item" onClick={() => void jumpToSearchResult(item)}>
                                <strong>{t(threadSearchSender(item))}</strong>
                                <span className="thread-search-snippet">{t(threadSearchSnippet(item))}</span>
                                <time>{formatListTime(item.createdAt)}</time>
                              </button>
                            ))}
                          </div>
                        )
                        : null}
                </section>
              )}

              <div className="incoming-toasts">
                {toasts.map(toast => (
                  <div
                    key={toast.id}
                    className="incoming-toast"
                    role="button"
                    tabIndex={0}
                    onClick={() => openToast(toast)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        openToast(toast)
                      }
                    }}
                  >
                    <ThreadAvatar
                      accountId={account.id}
                      name={toast.name}
                      username={undefined}
                      kind={undefined}
                      members={undefined}
                      size={32}
                    />
                    <div className="incoming-toast-body">
                      <strong>{toast.name}</strong>
                      <span>{toast.preview}</span>
                    </div>
                    <button
                      type="button"
                      className="incoming-toast-close"
                      title={t('关闭')}
                      onClick={(event) => {
                        event.stopPropagation()
                        dismissToast(toast.id)
                      }}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ))}
              </div>

              {detailsOpen && <div className="chat-details-backdrop" onClick={() => setDetailsOpen(false)} />}

              {detailsOpen && activeThread && (
                <section className="chat-details">
                  <header className="details-head">
                    <div>
                      <strong>{t('会话详情')}</strong>
                      <span>{threadName(activeThread)}</span>
                    </div>
                    <button type="button" className="details-close" title={t('关闭')} onClick={() => setDetailsOpen(false)}>
                      <Icon name="close" size={14} />
                    </button>
                  </header>

                  <div className="details-body">
                    <div className="details-profile">
                      <ThreadAvatar
                        accountId={account.id}
                        name={activeThread.kind === 'group' ? threadName(activeThread) : contactProfileName}
                        username={activeThread.peerId}
                        kind={activeThread.kind}
                        members={activeThread.avatarMembers}
                        size={42}
                      />
                      <div className="profile-main">
                        <strong>{activeThread.kind === 'group' ? threadName(activeThread) : contactProfileName}</strong>
                        {activeThread.kind === 'group'
                          ? (
                            <span className="profile-subtitle">
                              {t(threadKindLabel(activeThread.kind))} · {activeThread.avatarMembers?.length ?? 0} {t('位缓存成员')}
                            </span>
                          )
                          : <span className="profile-subtitle">{contactProfile?.username || detailsPeerId}</span>}
                      </div>
                    </div>

                    {activeThread.kind !== 'group' && activeThread.kind !== 'system' && (
                      contactProfileLoading
                        ? <div className="details-hint"><Icon name="refresh" size={12} className="spin" />{t('正在读取联系人资料…')}</div>
                        : contactProfileError
                          ? <div className="details-hint error"><Icon name="alert" size={12} />{contactProfileError}</div>
                          : contactProfile
                            ? (
                              <>
                                <div className="details-row"><span className="details-label">{t('备注')}</span><span>{contactProfile.remark || '—'}</span></div>
                                <div className="details-row"><span className="details-label">{t('昵称')}</span><span>{contactProfile.nickname || '—'}</span></div>
                                <div className="details-row"><span className="details-label">{t('微信号')}</span><span>{contactProfile.username || detailsPeerId}</span></div>
                                {contactProfile.alias && (
                                  <div className="details-row"><span className="details-label">{t('别名')}</span><span>{contactProfile.alias}</span></div>
                                )}
                              </>
                            )
                            : null
                    )}

                    <div className="details-row"><span className="details-label">{t('会话类型')}</span><span>{t(threadKindLabel(activeThread.kind, activeThread.peerId))}</span></div>
                    <div className="details-row"><span className="details-label">{t('会话 ID')}</span><code>{activeThread.id}</code></div>
                    <div className="details-row"><span className="details-label">{t('未读消息')}</span><span>{activeThread.unreadCount ?? 0}</span></div>
                    <div className="details-row">
                      <span className="details-label">{t('置顶 / 免打扰')}</span>
                      <span>{activeThread.pinned ? t('已置顶') : t('未置顶')} · {activeThread.muted ? t('已静音') : t('正常')}</span>
                    </div>
                  </div>

                  <div className="details-actions">
                    <button type="button" className="details-action" onClick={markActiveThreadRead}>
                      <Icon name="check" size={14} />
                      {t('标记已读')}
                    </button>
                    <button type="button" className="details-action" disabled={manualRefreshing} onClick={() => void refreshActiveMessages()}>
                      <Icon name="refresh" size={14} className={manualRefreshing ? 'spin' : undefined} />
                      {t('刷新会话')}
                    </button>
                  </div>
                </section>
              )}

              {peerIsStranger && (
                <div className="chat-banner stranger">
                  <Icon name="contacts" size={14} />
                  <span>{t('对方还不是你的朋友，暂请在手机微信上添加（桌面添加即将支持）')}</span>
                </div>
              )}

              {connectionState !== 'online' && (
                <div className="chat-banner">
                  <Icon name="wifi-off" size={14} />
                  <span>{t(connectionState === 'pending' ? '微信正在连接，消息可能延迟' : '微信当前离线，消息可能延迟')}</span>
                  <button type="button" disabled={manualRefreshing} onClick={() => void refreshAccount()}>{t('立即刷新')}</button>
                </div>
              )}

              {accountActionError && (
                <div className="chat-banner error">
                  <Icon name="alert" size={14} />
                  <span>{accountActionError}</span>
                  <button type="button" onClick={clearAccountActionError}>{t('关闭')}</button>
                </div>
              )}

              {threadsError && (
                <div className="chat-banner error">
                  <Icon name="alert" size={14} />
                  <span>{threadsError}</span>
                  <button type="button" onClick={() => void loadThreads()}>{t('重试')}</button>
                </div>
              )}

              {messageError && (
                <div className="chat-banner error">
                  <Icon name="alert" size={14} />
                  <span>{messageError}</span>
                </div>
              )}

              <MessageList />

              {lightboxSrc && (
                <div className="lightbox" onClick={() => setLightboxSrc(null)}>
                  <img src={lightboxSrc} alt="" />
                </div>
              )}

              {activeThread && unseenBelow > 0 && (
                <button type="button" className="new-message-jump" onClick={jumpToLatestMessage}>
                  <Icon name="chevron-down" size={14} />
                  {unseenBelow} {t('条新消息')}
                </button>
              )}

              {activeThread && !activeThreadIsOfficial && <Composer />}
            </main>
          </>
        )}

        <ContactSearchDialog
          open={contactDialogOpen}
          accountId={account.id}
          onClose={() => setContactDialogOpen(false)}
          onSelect={(contact: Contact) => startChatWithContact(contact)}
          onStartId={(id: string) => startChatWithId(id)}
        />
      </div>
    </div>
  )
}
