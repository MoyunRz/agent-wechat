/**
 * 微信内置特殊账号的固定官方风格头像。
 * 这类账号（文件传输助手、微信支付、微信团队、服务通知、公众平台）没有稳定的
 * 远端头像资源，参考官方客户端为其内置固定图标，命中后不再请求 hub 头像端点。
 */

export type SpecialAvatarId = 'filehelper' | 'wechatpay' | 'weixinTeam' | 'friendSuggest' | 'voiceMemo' | 'service' | 'official'

const SPECIAL_BACKGROUNDS: Record<SpecialAvatarId, string> = {
  filehelper: 'linear-gradient(135deg, #0cc25f, #089a4b)',
  wechatpay: 'linear-gradient(135deg, #0cc25f, #089a4b)',
  weixinTeam: 'linear-gradient(135deg, #0cc25f, #089a4b)',
  // 朋友推荐消息：官方为蓝色系人像图标。
  friendSuggest: 'linear-gradient(135deg, #4d9aff, #1567d4)',
  // 语音记事本：官方为青蓝色系话筒图标。
  voiceMemo: 'linear-gradient(135deg, #38c8d8, #0e9fb4)',
  service: 'linear-gradient(135deg, #ffb14e, #f5760a)',
  official: 'linear-gradient(135deg, #4d9aff, #1567d4)',
}

/** 用户名稳定的内置账号；微信团队官方账号用户名为 weixin。 */
const SPECIAL_USERNAMES: Partial<Record<SpecialAvatarId, string[]>> = {
  filehelper: ['filehelper'],
  wechatpay: ['wechatpay'],
  weixinTeam: ['weixin'],
  // 朋友推荐消息 fmessage、语音记事本 medianote 为协议内置账号，用户名固定。
  friendSuggest: ['fmessage'],
  voiceMemo: ['medianote'],
}

/** 服务通知/公众平台类账号用户名不固定（gh_ 号随环境变化），按显示名识别。 */
const SPECIAL_NAMES: Array<[SpecialAvatarId, string[]]> = [
  ['filehelper', ['文件传输助手', 'File Transfer']],
  ['wechatpay', ['微信支付', 'Weixin Pay', 'WeChat Pay']],
  ['weixinTeam', ['微信团队']],
  ['friendSuggest', ['朋友推荐消息', 'Friend Recommendations']],
  ['voiceMemo', ['语音记事本', 'Voice Memo', 'Voice Notes']],
  ['service', ['服务通知', 'Service Notifications']],
  ['official', ['公众平台', '微信公众平台', 'Official Accounts']],
]

export function specialAvatarFor(username?: string | null, name?: string | null): SpecialAvatarId | null {
  const id = (username ?? '').trim().toLowerCase()
  for (const [avatarId, usernames] of Object.entries(SPECIAL_USERNAMES) as Array<[SpecialAvatarId, string[]]>) {
    if (usernames.includes(id))
      return avatarId
  }
  const label = (name ?? '').trim().toLowerCase()
  for (const [avatarId, names] of SPECIAL_NAMES) {
    if (names.some(n => n.toLowerCase() === label))
      return avatarId
  }
  return null
}

export function specialAvatarBackground(id: SpecialAvatarId): string {
  return SPECIAL_BACKGROUNDS[id]
}

/** 企业微信客服（@openim 家族）会话：无品牌头像时使用企业微信风格的默认图标。 */
export function isWecomPeer(username?: string | null): boolean {
  const id = (username ?? '').trim().toLowerCase()
  return id.endsWith('@openim') || id.endsWith('@kefu.openim')
}

export const WECOM_AVATAR_BACKGROUND = 'linear-gradient(135deg, #4795ff, #1a6ce0)'
