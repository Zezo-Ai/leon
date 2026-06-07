import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'

import './dropdown.sass'

type DropdownPlacement = 'top' | 'bottom'
type DropdownItemVariant = 'default' | 'danger'

interface DropdownItem {
  iconName: string
  label: string
  variant?: DropdownItemVariant
  onSelect?: () => void
}

interface DropdownProps {
  children: ReactNode
  items: DropdownItem[]
}

const DROPDOWN_OFFSET = 6
const DROPDOWN_WIDTH = 180
const DROPDOWN_ESTIMATED_ITEM_HEIGHT = 40
const DROPDOWN_VERTICAL_PADDING = 8

function getDropdownHeight(itemCount: number): number {
  return (itemCount * DROPDOWN_ESTIMATED_ITEM_HEIGHT) + DROPDOWN_VERTICAL_PADDING
}

function getDropdownPosition(
  triggerRect: DOMRect,
  itemCount: number
): {
  placement: DropdownPlacement
  style: CSSProperties
} {
  const dropdownHeight = getDropdownHeight(itemCount)
  const spaceBelow = window.innerHeight - triggerRect.bottom
  const placement =
    spaceBelow >= dropdownHeight + DROPDOWN_OFFSET ? 'bottom' : 'top'
  const preferredTop = placement === 'bottom'
    ? triggerRect.bottom + DROPDOWN_OFFSET
    : triggerRect.top - dropdownHeight - DROPDOWN_OFFSET
  const top = Math.min(
    Math.max(preferredTop, DROPDOWN_OFFSET),
    window.innerHeight - dropdownHeight - DROPDOWN_OFFSET
  )
  const left = Math.min(
    Math.max(triggerRect.right - DROPDOWN_WIDTH, DROPDOWN_OFFSET),
    window.innerWidth - DROPDOWN_WIDTH - DROPDOWN_OFFSET
  )

  return {
    placement,
    style: {
      top,
      left,
      width: DROPDOWN_WIDTH
    }
  }
}

export function Dropdown({
  children,
  items
}: DropdownProps) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<DropdownPlacement>('bottom')
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties>()

  function updateDropdownPosition(): void {
    if (triggerRef.current === null) {
      return
    }

    const nextPosition = getDropdownPosition(
      triggerRef.current.getBoundingClientRect(),
      items.length
    )

    setPlacement(nextPosition.placement)
    setDropdownStyle(nextPosition.style)
  }

  function toggleDropdown(): void {
    if (open) {
      setOpen(false)
      return
    }

    updateDropdownPosition()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) {
      return undefined
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target

      if (!(target instanceof Node)) {
        return
      }

      if (
        triggerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return
      }

      setOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    updateDropdownPosition()
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', updateDropdownPosition)
    window.addEventListener('scroll', updateDropdownPosition, true)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', updateDropdownPosition)
      window.removeEventListener('scroll', updateDropdownPosition, true)
    }
  }, [items.length, open])

  return (
    <>
      <span
        ref={triggerRef}
        className="dropdown-trigger"
        onClick={(event) => {
          event.stopPropagation()
          toggleDropdown()
        }}
      >
        {children}
      </span>
      {createPortal(
        <div
          ref={dropdownRef}
          className={clsx(
            'dropdown-content',
            `dropdown-content-${placement}`,
            { 'dropdown-content-open': open }
          )}
          role="menu"
          style={dropdownStyle}
        >
          {items.map((item) => (
            <button
              type="button"
              className={clsx(
                'dropdown-item',
                `dropdown-item-${item.variant ?? 'default'}`
              )}
              key={item.label}
              role="menuitem"
              onClick={() => {
                item.onSelect?.()
                setOpen(false)
              }}
            >
              <i
                className={`dropdown-item-icon ri-${item.iconName}-line`}
                aria-hidden="true"
              />
              <span className="dropdown-item-label">{item.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
