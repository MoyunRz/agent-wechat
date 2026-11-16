const NETWORK_ERROR_PATTERN = /failed to fetch|networkerror|load failed|network request failed|fetch failed|networkerror when attempting to fetch resource/i

const CHINESE_PATTERN = /[\u4e00-\u9fa5]/

const SEND_ERROR_MESSAGES: Record<string, string> = {
  auth_required: '登录状态已失效，请重新登录微信。',
  profile_keys_missing: '微信账号尚未完成登录，请先扫码登录。',
  not_connected: '微信当前未连接，请连接后重试。',
  timeout: '微信响应超时，请稍后重试。',
  rate_limited: '发送过于频繁，请稍后再试。',
  network_error: '网络连接失败，请检查网络后重试。',
  media_expired: '附件已过期，请重新发送。',
  unsupported: '当前消息类型暂不支持发送。',
  invalid_request: '消息内容不符合要求，请修改后重试。',
  not_found: '找不到对应的聊天，请刷新后重试。',
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof Error && NETWORK_ERROR_PATTERN.test(error.message)
}

/**
 * 把底层异常转换成用户能看懂的短句。
 * 只有中文业务提示会透出，英文异常（如 Failed to fetch）统一替换为网络提示或兜底文案。
 */
export function userFacingErrorMessage(error: unknown, fallback: string): string {
  if (isNetworkError(error))
    return '网络连接失败，请检查网络后重试。'
  if (error instanceof Error && CHINESE_PATTERN.test(error.message))
    return error.message
  return fallback
}

/**
 * 把发送失败原因转换成用户能看懂的短句。
 * 已知错误码映射为中文；无法识别的错误码和英文原始原因不直接展示。
 */
export function sendFailureMessage(reason: unknown, fallback = '发送失败，请稍后重试。'): string {
  const value = typeof reason === 'string' ? reason.trim() : ''
  if (!value)
    return fallback
  const known = SEND_ERROR_MESSAGES[value.toLowerCase()]
  if (known)
    return known
  if (CHINESE_PATTERN.test(value))
    return value
  return fallback
}
