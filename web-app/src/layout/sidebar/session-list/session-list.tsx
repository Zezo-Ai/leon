import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { sessionIndex, type ConversationSession } from '../../../data/sessions'
import { useToast } from '../../../components/toast'
import { SessionListItem } from '../session-list-item'

import './session-list.sass'

const SESSION_ITEM_ESTIMATED_HEIGHT = 41
const SESSION_LIST_OVERSCAN = 5

interface SessionListProps {
  collapsed?: boolean
  scrollElementRef: RefObject<HTMLDivElement | null>
}

function sortPinnedSessionsFirst(
  sessions: ConversationSession[]
): ConversationSession[] {
  return [...sessions].sort((firstSession, secondSession) => {
    if (firstSession.isPinned === secondSession.isPinned) {
      return 0
    }

    return firstSession.isPinned ? -1 : 1
  })
}

export function SessionList({
  collapsed = false,
  scrollElementRef
}: SessionListProps) {
  const { showToast } = useToast()
  const virtualListRef = useRef<HTMLUListElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [sessions, setSessions] = useState<ConversationSession[]>(
    () => sessionIndex.sessions
  )
  const sortedSessions = useMemo(
    () => sortPinnedSessionsFirst(sessions),
    [sessions]
  )
  const rowVirtualizer = useVirtualizer({
    count: sortedSessions.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => SESSION_ITEM_ESTIMATED_HEIGHT,
    overscan: SESSION_LIST_OVERSCAN,
    scrollMargin
  })

  function renameSession(sessionId: string, nextTitle: string): void {
    const title = nextTitle.trim()
    const session = sessions.find((currentSession) =>
      currentSession.id === sessionId
    )

    if (
      session === undefined ||
      title.length === 0 ||
      title === session.title
    ) {
      return
    }

    setSessions((currentSessions) =>
      currentSessions.map((currentSession) =>
        currentSession.id === sessionId
          ? {
              ...currentSession,
              title,
              updatedAt: Date.now()
            }
          : currentSession
      )
    )
    showToast({
      type: 'success',
      title: 'Session title edited',
      description: `I edited your session title to "${title}".`
    })
  }

  function deleteSession(sessionId: string): void {
    setSessions((currentSessions) =>
      currentSessions.filter((currentSession) => currentSession.id !== sessionId)
    )
  }

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
          const session = sortedSessions[virtualRow.index]

          if (session === undefined) {
            return null
          }

          return (
            <SessionListItem
              key={session.id}
              id={session.id}
              isPinned={session.isPinned}
              title={session.title}
              onDelete={deleteSession}
              onRename={renameSession}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`
              }}
            />
          )
        })}
      </ul>
      <div className="session-list-mask" aria-hidden="true" />
    </nav>
  )
}
