import { describe, expect, it } from 'vitest'
import { isWecomPeer, specialAvatarBackground, specialAvatarFor, WECOM_AVATAR_BACKGROUND } from './special-avatars'

describe('specialAvatarFor', () => {
  it('matches the built-in accounts by username', () => {
    expect(specialAvatarFor('filehelper')).toBe('filehelper')
    expect(specialAvatarFor('WeChatPay')).toBe('wechatpay')
    expect(specialAvatarFor('weixin')).toBe('weixinTeam')
    expect(specialAvatarFor('fmessage')).toBe('friendSuggest')
    expect(specialAvatarFor('medianote')).toBe('voiceMemo')
  })

  it('matches by display name when the username varies', () => {
    expect(specialAvatarFor('gh_123', '服务通知')).toBe('service')
    expect(specialAvatarFor('gh_123', '公众平台')).toBe('official')
    expect(specialAvatarFor(null, '文件传输助手')).toBe('filehelper')
    expect(specialAvatarFor(null, 'File Transfer')).toBe('filehelper')
  })

  it('returns null for ordinary peers', () => {
    expect(specialAvatarFor('wxid_abc', 'Alice')).toBeNull()
    expect(specialAvatarFor(null, null)).toBeNull()
  })
})

describe('specialAvatarBackground', () => {
  it('returns a gradient per built-in account', () => {
    expect(specialAvatarBackground('filehelper')).toContain('linear-gradient')
    expect(specialAvatarBackground('service')).toContain('linear-gradient')
  })
})

describe('isWecomPeer', () => {
  it('recognises the openim families', () => {
    expect(isWecomPeer('brand@openim')).toBe(true)
    expect(isWecomPeer('brand@kefu.openim')).toBe(true)
    expect(isWecomPeer('room@chatroom')).toBe(false)
    expect(isWecomPeer(null)).toBe(false)
  })

  it('exposes the WeCom avatar background', () => {
    expect(WECOM_AVATAR_BACKGROUND).toContain('linear-gradient')
  })
})
