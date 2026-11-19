// Hub selection for the desktop shell: this device, another saved hub, or a new
// remote hub. Shown when no hub session is restored at startup.
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import brandLogoUrl from '../../assets/agent-wechat-logo.svg'
import { useT } from '../../i18n/useT'
import {
  desktopErrorMessage,
  keepLocalHubRunning,
  loadDesktopSettings,
  saveLocalHubSettings,
  selectLocalHub,
  selectRemoteHub,
  selectSavedHub,
  stopLeftoverHub,
  type DesktopSession,
  type DesktopSettings,
} from '../../platform/desktop'
import '../../styles/components/desktop.css'

export type HubConnectScreenProps = {
  /** Called after the shell latched the selected hub. */
  onConnected: (session: DesktopSession) => void
  /** Startup failure to show, such as a hub that could not be restored. */
  initialError?: string
}

type Mode = 'choose' | 'remote' | 'settings'

export function HubConnectScreen({ onConnected, initialError = '' }: HubConnectScreenProps) {
  const t = useT()
  const [mode, setMode] = useState<Mode>('choose')
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:6174')
  const [key, setKey] = useState('')
  const [certificate, setCertificate] = useState('')
  const [localPort, setLocalPort] = useState(6174)
  const [networkPort, setNetworkPort] = useState(6175)
  const [network, setNetwork] = useState(false)

  const https = endpoint.trim().toLowerCase().startsWith('https://')

  const refreshSettings = useCallback(async () => {
    const value = await loadDesktopSettings()
    setSettings(value)
    setLocalPort(value.localPort)
    setNetworkPort(value.networkPort)
    setNetwork(value.networkEnabled)
  }, [])

  useEffect(() => {
    if (mode === 'remote')
      return
    void refreshSettings().catch((reason) => {
      setError(desktopErrorMessage(reason))
    })
  }, [mode, refreshSettings])

  async function connect(operation: () => Promise<DesktopSession>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const session = await operation()
      setKey('')
      setCertificate('')
      onConnected(session)
    }
    catch (reason) {
      setError(desktopErrorMessage(reason))
      // A failed local start can reveal a hub left running by an earlier run.
      void refreshSettings().catch(() => {})
    }
    finally {
      setBusy(false)
    }
  }

  async function submitRemote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await connect(() => selectRemoteHub({
      name,
      endpoint,
      token: key,
      certificate: https ? certificate.trim() || null : null,
    }))
  }

  async function stopLeftover() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const session = await stopLeftoverHub()
      if (session)
        onConnected(session)
      else
        await refreshSettings()
    }
    catch (reason) {
      setError(desktopErrorMessage(reason))
    }
    finally {
      setBusy(false)
    }
  }

  async function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const session = await saveLocalHubSettings({ localPort, networkPort, networkEnabled: network })
      await refreshSettings()
      setNotice(t('已保存'))
      if (session)
        onConnected(session)
    }
    catch (reason) {
      setError(desktopErrorMessage(reason))
    }
    finally {
      setBusy(false)
    }
  }

  async function toggleKeepLocalHub(enabled: boolean) {
    setBusy(true)
    setError('')
    try {
      await keepLocalHubRunning(enabled)
      await refreshSettings()
    }
    catch (reason) {
      setError(desktopErrorMessage(reason))
    }
    finally {
      setBusy(false)
    }
  }

  const hasLocal = settings?.connections.some(connection => connection.local) ?? false
  const title = mode === 'settings'
    ? t('桌面设置')
    : mode === 'remote'
      ? t('连接 Hub')
      : t('欢迎使用 AgentWechat')
  const subtitle = mode === 'settings'
    ? t('管理本机的 Hub 连接与端口。')
    : mode === 'remote'
      ? t('此连接将保存在系统钥匙串中。')
      : t('使用本机内置的 Hub，或连接已有的 agent-wechat Hub。')

  return (
    <div className="desktop-connect">
      <div className="desktop-connect-backdrop" aria-hidden="true" />
      <section className="desktop-connect-panel" aria-labelledby="desktop-connect-title">
        <header className="desktop-connect-head">
          <img src={brandLogoUrl} alt="" width={44} height={44} />
          <h1 id="desktop-connect-title">{title}</h1>
          <p>{subtitle}</p>
        </header>

        {mode === 'choose' && (
          <div className="desktop-choices">
            <button
              type="button"
              className="continue-button"
              disabled={busy}
              onClick={() => void connect(selectLocalHub)}
            >
              {busy ? t('正在打开…') : t('使用本机')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setMode('remote')}
            >
              {t('连接其他 Hub')}
            </button>
            {settings?.connections.filter(connection => !connection.local).map(connection => (
              <button
                key={connection.id}
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void connect(() => selectSavedHub(connection.id))}
              >
                {connection.name}
                <small>{connection.endpoint}</small>
              </button>
            ))}
            <button
              type="button"
              className="text-button"
              onClick={() => setMode('settings')}
            >
              {t('桌面设置')}
            </button>
          </div>
        )}

        {mode === 'remote' && (
          <form className="desktop-form" onSubmit={submitRemote}>
            <label>
              {t('连接名称')}
              <input
                required
                value={name}
                autoComplete="off"
                onChange={event => setName(event.target.value)}
              />
            </label>
            <label>
              {t('Hub 地址')}
              <input
                required
                type="url"
                value={endpoint}
                autoComplete="off"
                onChange={event => setEndpoint(event.target.value)}
              />
            </label>
            <label>
              {t('访问密钥')}
              <input
                required
                type="password"
                value={key}
                autoComplete="off"
                onChange={event => setKey(event.target.value)}
              />
            </label>
            {https && (
              <details className="desktop-certificate">
                <summary>{t('高级')}</summary>
                <p>{t('大多数 Hub 无需额外证书。如果 Hub 使用私有证书，请粘贴其所有者提供的 PEM 证书。')}</p>
                <label>
                  {t('私有证书（可选）')}
                  <textarea
                    value={certificate}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    spellCheck={false}
                    onChange={event => setCertificate(event.target.value)}
                  />
                </label>
              </details>
            )}
            <button className="continue-button" disabled={busy}>
              {busy ? t('正在连接…') : t('连接')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setKey('')
                setCertificate('')
                setError('')
                setMode('choose')
              }}
            >
              {t('返回')}
            </button>
          </form>
        )}

        {mode === 'settings' && (
          <div className="desktop-settings">
            {settings?.localHubError && (
              <p role="alert" className="connection-error">
                {t('本机 Hub 未运行：{error}', { error: settings.localHubError })}
              </p>
            )}
            <form className="desktop-form" onSubmit={submitSettings}>
              <div className="setting">
                <span>
                  {t('允许网络连接')}
                  <small>{t('使用访问密钥的 HTTPS 访问，供其他设备使用。')}</small>
                </span>
                <input
                  type="checkbox"
                  aria-label={t('允许网络连接')}
                  checked={network}
                  disabled={busy}
                  onChange={event => setNetwork(event.target.checked)}
                />
              </div>
              <details>
                <summary>{t('连接端口')}</summary>
                <div className="desktop-port-fields">
                  <label>
                    {t('本机')}
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      required
                      value={localPort}
                      onChange={event => setLocalPort(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    {t('网络')}
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      required
                      value={networkPort}
                      onChange={event => setNetworkPort(Number(event.target.value))}
                    />
                  </label>
                </div>
              </details>
              {hasLocal && (
                <div className="setting">
                  <span>
                    {t('保留本机 Hub 运行')}
                    <small>{t('使用其他 Hub 时保持本机 Hub 运行，让命令行工具和其他应用可以访问。退出 AgentWechat 时总会停止。')}</small>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={t('保留本机 Hub 运行')}
                    checked={settings?.keepLocalHubRunning ?? false}
                    disabled={busy || !settings}
                    onChange={event => void toggleKeepLocalHub(event.target.checked)}
                  />
                </div>
              )}
              <button className="secondary" disabled={busy}>
                {busy ? t('正在应用…') : t('应用')}
              </button>
            </form>
            {settings?.networkEnabled && (
              <div className="desktop-connection-details">
                {settings.networkAddresses.map(address => (
                  <code key={address}>{address}</code>
                ))}
              </div>
            )}
            {settings?.leftoverHub && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void stopLeftover()}
              >
                {busy ? t('正在停止…') : t('停止遗留的 Hub')}
              </button>
            )}
            <button
              type="button"
              className="text-button"
              onClick={() => setMode('choose')}
            >
              {t('返回')}
            </button>
          </div>
        )}

        {notice && <p role="status" className="desktop-notice">{notice}</p>}
        {error && (
          <p role="alert" className="connection-error">
            {error}
          </p>
        )}
        {mode === 'choose' && settings?.leftoverHub && (
          <button
            type="button"
            className="secondary desktop-leftover"
            disabled={busy}
            onClick={() => void stopLeftover()}
          >
            {busy ? t('正在停止…') : t('停止遗留的 Hub')}
          </button>
        )}
      </section>
    </div>
  )
}

export default HubConnectScreen