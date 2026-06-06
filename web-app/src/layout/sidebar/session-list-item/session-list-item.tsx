import type { CSSProperties } from 'react'
import { Link } from '@tanstack/react-router'
import { clsx } from 'clsx'

import './session-list-item.sass'

interface SessionListItemProps {
  id: string
  title: string
  style?: CSSProperties
}

export function SessionListItem({
  id,
  title,
  style
}: SessionListItemProps) {
  return (
    <li className="session-list-item" style={style}>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: id }}
        className="session-list-item-link"
        activeProps={{
          className: clsx('session-list-item-link', 'session-list-item-active')
        }}
      >
        <span className="session-list-item-title">{title}</span>
      </Link>
    </li>
  )
}
