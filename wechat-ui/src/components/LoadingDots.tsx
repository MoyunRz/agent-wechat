// Three-dot loading indicator. It replaces the rotating refresh icon wherever
// the interface is waiting, and inherits the surrounding text colour.

import { useT } from '../i18n/useT'
import '../styles/components/loading-dots.css'

type Props = {
  label?: string
  className?: string
}

export default function LoadingDots({ label, className }: Props) {
  const t = useT()
  return (
    <span
      className={`loading-dots${className ? ` ${className}` : ''}`}
      role="status"
      aria-label={label ?? t('加载中')}
    >
      <i />
      <i />
      <i />
    </span>
  )
}
