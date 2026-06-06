import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import sessionsData from '../../../data/sessions.json'
import { SessionListItem } from '../session-list-item'

import './session-list.sass'

const SESSION_ITEM_ESTIMATED_HEIGHT = 40
const SESSION_LIST_OVERSCAN = 5

interface ConversationSession {
  id: string
  title: string
  isTitleGenerated: boolean
  isPinned: boolean
  createdAt: number
  updatedAt: number
  lastMessageAt: number | null
  messageCount: number
  modelTarget: string | null
}

interface ConversationSessionIndex {
  activeSessionId: string
  sessions: ConversationSession[]
}

interface SessionListProps {
  collapsed?: boolean
  scrollElementRef: RefObject<HTMLDivElement | null>
}

const sessionIndex = sessionsData satisfies ConversationSessionIndex

export function SessionList({
  collapsed = false,
  scrollElementRef
}: SessionListProps) {
  const virtualListRef = useRef<HTMLUListElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const sessions = sessionIndex.sessions
  const rowVirtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => SESSION_ITEM_ESTIMATED_HEIGHT,
    overscan: SESSION_LIST_OVERSCAN,
    scrollMargin
  })

  useLayoutEffect(() => {
    const virtualList = virtualListRef.current

    if (virtualList === null) {
      return undefined
    }

    // The sidebar scroll container starts above this list, so the virtual rows
    // need the list offset to keep their transforms local to the list element.
    function updateScrollMargin(): void {
      setScrollMargin(virtualList?.offsetTop ?? 0)
    }

    updateScrollMargin()

    const resizeObserver = new ResizeObserver(updateScrollMargin)
    resizeObserver.observe(virtualList)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  if (collapsed) {
    return null
  }

  return (
    <nav className="session-list" aria-labelledby="session-list-title">
      <h2 className="session-list-title" id="session-list-title">
        Recents
      </h2>
      <ul
        className="session-list-items"
        ref={virtualListRef}
        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const session = sessions[virtualRow.index]

          if (session === undefined) {
            return null
          }

          return (
            <SessionListItem
              key={session.id}
              id={session.id}
              title={session.title}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`
              }}
            />
          )
        })}
      </ul>
    </nav>
  )
}
