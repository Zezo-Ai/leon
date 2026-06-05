import type { ReactNode } from 'react'
import { useState } from 'react'
import { clsx } from 'clsx'

import './tooltip.sass'

export type TooltipPosition = 'top' | 'right' | 'bottom' | 'left'

interface TooltipProps {
  children: ReactNode
  message: string
  position?: TooltipPosition
}

export function Tooltip({
  children,
  message,
  position = 'bottom'
}: TooltipProps) {
  const [open, setOpen] = useState(false)

  return (
    <span
      className={clsx('tooltip', `tooltip-${position}`, {
        'tooltip-open': open
      })}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen(false)}
    >
      {children}
      <span className="tooltip-content" role="tooltip">
        {message}
      </span>
    </span>
  )
}
