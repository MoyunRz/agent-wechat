// Relationship-privacy fields shared by the contact card and the friend-request
// dialogs: the two access levels, and the Moments switches shown for full access.
// Accepting a request sends the chosen settings with the accept operation.

import { useId } from 'react'
import { useT } from '../i18n/useT'
import type { ContactPrivacySettings } from '../types'
import '../styles/components/contact-detail.css'

/** Full access with no Moments hidden, the daemon's supported default. */
export function defaultContactPrivacy(): ContactPrivacySettings {
  return { chatsOnly: false, hideMyPosts: false, hideTheirPosts: false }
}

type ContactPrivacyFieldsProps = {
  value: ContactPrivacySettings
  onChange: (next: ContactPrivacySettings) => void
  disabled?: boolean
  /** Optional explanation rendered under the group title. */
  hint?: string
}

export default function ContactPrivacyFields({
  value,
  onChange,
  disabled = false,
  hint,
}: ContactPrivacyFieldsProps) {
  const t = useT()
  const group = useId()
  const change = (patch: Partial<ContactPrivacySettings>) => onChange({ ...value, ...patch })

  return (
    <fieldset className="contact-privacy" disabled={disabled}>
      <legend className="detail-label">{t('关系隐私')}</legend>
      {hint && <p className="contact-privacy-hint">{t(hint)}</p>}
      <label className="contact-radio">
        <input
          type="radio"
          name={group}
          checked={!value.chatsOnly}
          onChange={() => change({ chatsOnly: false })}
        />
        <span>
          <strong>{t('全部可见')}</strong>
          <small>{t('可以聊天，也能看到彼此的朋友圈')}</small>
        </span>
      </label>
      <label className="contact-radio">
        <input
          type="radio"
          name={group}
          checked={value.chatsOnly}
          onChange={() => change({ chatsOnly: true })}
        />
        <span>
          <strong>{t('仅聊天')}</strong>
          <small>{t('互相看不到朋友圈和微信运动')}</small>
        </span>
      </label>
      {!value.chatsOnly && (
        <div className="contact-switches">
          <button
            type="button"
            role="switch"
            aria-checked={value.hideMyPosts}
            className={`privacy-switch${value.hideMyPosts ? ' on' : ''}`}
            onClick={() => change({ hideMyPosts: !value.hideMyPosts })}
          >
            <span>{t('不让对方看我的朋友圈')}</span>
            <i />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={value.hideTheirPosts}
            className={`privacy-switch${value.hideTheirPosts ? ' on' : ''}`}
            onClick={() => change({ hideTheirPosts: !value.hideTheirPosts })}
          >
            <span>{t('不看对方的朋友圈')}</span>
            <i />
          </button>
        </div>
      )}
    </fieldset>
  )
}
