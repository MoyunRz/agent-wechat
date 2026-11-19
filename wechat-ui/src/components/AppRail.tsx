// Left navigation rail: the view switcher (chats, contacts, AI), the account
// avatar with its menu, the settings panel trigger and the count badges. All
// state comes from the store; the popovers live in ./settings/.

import { useState } from 'react'
import { connectionTone } from '../format'
import { useT } from '../i18n/useT'
import {
  logoutAccount,
  refreshAccount,
  selectUnreadTotal,
  setRailView,
  setSettingsOpen as setSettingsOpenAction,
} from '../store/actions'
import { useStore } from '../store/hooks'
import Icon from './Icon'
import ThreadAvatar from './ThreadAvatar'
import AccountMenu from './settings/AccountMenu'
import SettingsPanel from './settings/SettingsPanel'
import { phaseAttribute, usePresence } from './settings/usePresence'
import '../styles/components/rail.css'

/** Durations of the Vue <Transition> wrappers: fade 0.16s, popover 0.18s. */
const FADE_MS = 160
const POPOVER_MS = 180

/** Badge text: everything above 99 is capped. */
function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export default function AppRail() {
  const t = useT()

  const account = useStore(state => state.session.account)
  const selfName = useStore(state => state.session.selfName)
  const view = useStore(state => state.ui.railView)
  const unreadTotal = useStore(selectUnreadTotal)
  const friendRequestCount = useStore(state => state.session.friendRequestCount)
  const accountRefreshing = useStore(state => state.session.manualRefreshing)
  const loggingOut = useStore(state => state.session.loggingOut)

  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const settingsOpen = useStore(state => state.ui.settingsOpen)
  const setSettingsOpen = setSettingsOpenAction

  const backdrop = usePresence(accountMenuOpen || settingsOpen, FADE_MS)
  const accountMenu = usePresence(accountMenuOpen, POPOVER_MS)

  if (!account)
    return null

  // The WeChat nickname is preferred; the account slot alias is never shown.
  const accountLabel = selfName.trim() || t('微信')
  const tone = connectionTone(account.connection, account.authenticated)

  function toggleAccountMenu(): void {
    setSettingsOpen(false)
    setAccountMenuOpen(open => !open)
  }

  function toggleSettings(): void {
    setAccountMenuOpen(false)
    setSettingsOpenAction(!settingsOpen)
  }

  function closeMenus(): void {
    setAccountMenuOpen(false)
    setSettingsOpen(false)
  }

  function handleRefresh(): void {
    setAccountMenuOpen(false)
    void refreshAccount()
  }

  function handleLogout(): void {
    setAccountMenuOpen(false)
    void logoutAccount()
  }

  return (
    <nav className="app-rail">
      <button
        type="button"
        className={`rail-avatar-button${accountMenuOpen ? ' active' : ''}`}
        title={t('账号信息')}
        onClick={toggleAccountMenu}
      >
        <ThreadAvatar
          accountId={account.id}
          name={accountLabel}
          username={account.ownUsername}
          size={38}
        />
        <span className="rail-status" data-tone={tone} />
      </button>

      <div className="rail-nav">
        <button
          type="button"
          className={`rail-button${view === 'chats' ? ' active' : ''}`}
          title={t('聊天')}
          onClick={() => setRailView('chats')}
        >
          <Icon name="message" size={24} />
          {/* The count badge disappears once the view is open: it is a hint of
              new content, not a duplicate of the unread dots in the list. */}
          {unreadTotal > 0 && view !== 'chats' && (
            <span className="rail-badge">{badgeText(unreadTotal)}</span>
          )}
        </button>
        <button
          type="button"
          className={`rail-button${view === 'contacts' ? ' active' : ''}`}
          title={t('通讯录')}
          onClick={() => setRailView('contacts')}
        >
          <Icon name="contacts" size={24} />
        </button>
        <button
          type="button"
          className={`rail-button${view === 'requests' ? ' active' : ''}`}
          title={t('好友申请')}
          onClick={() => setRailView('requests')}
        >
          <Icon name="users" size={22} />
          {friendRequestCount > 0 && view !== 'requests' && (
            <span className="rail-badge">{badgeText(friendRequestCount)}</span>
          )}
        </button>
        <button
          type="button"
          className={`rail-button${view === 'ai' ? ' active' : ''}`}
          title={t('AI 对话')}
          onClick={() => setRailView('ai')}
        >
          <Icon name="gpt" size={20} />
        </button>
      </div>

      <div className="rail-bottom">
        <button
          type="button"
          className={`rail-button${settingsOpen ? ' active' : ''}`}
          title={t('界面设置')}
          onClick={toggleSettings}
        >
          <Icon name="settings" size={19} />
        </button>
      </div>

      {backdrop.mounted && (
        <div className="rail-backdrop" data-phase={phaseAttribute(backdrop.phase)} onClick={closeMenus} />
      )}

      {accountMenu.mounted && (
        <AccountMenu
          account={account}
          accountLabel={accountLabel}
          tone={tone}
          accountRefreshing={accountRefreshing}
          loggingOut={loggingOut}
          phase={accountMenu.phase}
          onClose={() => setAccountMenuOpen(false)}
          onRefresh={handleRefresh}
          onLogout={handleLogout}
        />
      )}

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </nav>
  )
}
