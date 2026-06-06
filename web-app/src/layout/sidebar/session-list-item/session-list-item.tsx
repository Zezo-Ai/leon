import type { CSSProperties } from 'react'
import { Link } from '@tanstack/react-router'
import { clsx } from 'clsx'

import { Button } from '../../../components/button'
import { Dropdown } from '../../../components/dropdown'

import './session-list-item.sass'

interface SessionListItemProps {
  id: string
  isPinned: boolean
  title: string
  style?: CSSProperties
}

export function SessionListItem({
  id,
  isPinned,
  title,
  style
}: SessionListItemProps) {
  const pinDropdownItem = isPinned
    ? {
        iconName: 'unpin',
        label: 'Unpin session'
      }
    : {
        iconName: 'pushpin',
        label: 'Pin session'
      }

  return (
    <li className={clsx('session-list-item', { 'session-list-item-pinned': isPinned })} style={style}>
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
      {isPinned && (
        <i
          className="session-list-item-pinned-icon ri-unpin-fill"
          aria-hidden="true"
        />
      )}
      <div className="session-list-item-actions">
        <Dropdown
          items={[
            {
              iconName: 'edit',
              label: 'Rename'
            },
            pinDropdownItem,
            {
              iconName: 'delete-bin',
              label: 'Delete',
              variant: 'danger'
            }
          ]}
        >
          <Button
            iconName="more-2"
            ariaLabel="Session options"
          />
        </Dropdown>
      </div>
    </li>
  )
}
