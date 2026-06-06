import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'

import './tooltip.sass'

export type TooltipPosition = 'top' | 'right' | 'bottom' | 'left'

interface TooltipProps {
  children: ReactNode
  message: string
  position?: TooltipPosition
}

const TOOLTIP_OFFSET = 8

function getTooltipStyle(
  triggerRect: DOMRect,
  position: TooltipPosition
): CSSProperties {
  if (position === 'top') {
    return {
      bottom: window.innerHeight - triggerRect.top + TOOLTIP_OFFSET,
      left: triggerRect.left + (triggerRect.width / 2)
    }
  }

  if (position === 'right') {
    return {
      top: triggerRect.top + (triggerRect.height / 2),
      left: triggerRect.right + TOOLTIP_OFFSET
    }
  }

  if (position === 'left') {
    return {
      top: triggerRect.top + (triggerRect.height / 2),
      right: window.innerWidth - triggerRect.left + TOOLTIP_OFFSET
    }
  }

  return {
    top: triggerRect.bottom + TOOLTIP_OFFSET,
    left: triggerRect.left + (triggerRect.width / 2)
  }
}

export function Tooltip({
  children,
  message,
  position = 'bottom'
}: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>()
  const triggerRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open || triggerRef.current === null) {
      return
    }

    function updateTooltipPosition(): void {
      if (triggerRef.current === null) {
        return
      }

      setTooltipStyle(getTooltipStyle(
        triggerRef.current.getBoundingClientRect(),
        position
      ))
    }

    updateTooltipPosition()
    window.addEventListener('resize', updateTooltipPosition)
    window.addEventListener('scroll', updateTooltipPosition, true)

    return () => {
      window.removeEventListener('resize', updateTooltipPosition)
      window.removeEventListener('scroll', updateTooltipPosition, true)
    }
  }, [open, position])

  return (
    <>
      <span
        ref={triggerRef}
        className="tooltip"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(false)}
      >
        {children}
      </span>
      {createPortal(
        <span
          className={clsx('tooltip-content', `tooltip-content-${position}`, {
            'tooltip-content-open': open
          })}
          role="tooltip"
          style={tooltipStyle}
        >
          {message}
        </span>,
        document.body
      )}
    </>
  )
}
