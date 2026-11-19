import DOMPurify from 'dompurify'
import { marked } from 'marked'

// 同步渲染即可：AI 回复的长度量级下阻塞可忽略；GFM 支持表格/删除线/任务列表。
marked.setOptions({ gfm: true, breaks: true, async: false })

// 外链一律新标签页打开并补 rel，防止 reverse tabnabbing。
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/**
 * 把 AI 回复的 markdown 渲染成安全的 HTML：
 * marked 解析后必须过 DOMPurify 消毒才允许 v-html，防注入。
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false })
  return DOMPurify.sanitize(html, {
    // 有序任务列表的 checkbox 由 CSS 呈现，属性白名单保持最小。
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'start', 'type'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input'],
  })
}
