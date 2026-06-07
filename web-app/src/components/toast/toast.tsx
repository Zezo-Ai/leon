import type { ReactNode } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'

import { Button } from '../button'

import './toast.sass'

type ToastType = 'success' | 'info' | 'warning' | 'error'

interface ToastInput {
  type?: ToastType
  title: string
  description: string
}

interface ToastItem extends Required<ToastInput> {
  exiting: boolean
  id: string
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => void
}

interface ToastProviderProps {
  children: ReactNode
}

interface ToastCardProps {
  stackIndex: number
  toast: ToastItem
  onClose: (toastId: string) => void
}

const DEFAULT_TOAST_DURATION_MS = 120_000
const TOAST_EXIT_DURATION_MS = 350
const MAX_VISIBLE_TOASTS = 3
const TOAST_ICONS: Record<ToastType, string> = {
  success: 'check-line',
  info: 'info-i',
  warning: 'alert-line',
  error: 'close-circle-line'
}
const ToastContext = createContext<ToastContextValue | null>(null)

function createToastId(): string {
  return window.crypto.randomUUID()
}

function ToastCard({
  stackIndex,
  toast,
  onClose
}: ToastCardProps) {
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      onClose(toast.id)
    }, DEFAULT_TOAST_DURATION_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [onClose, toast.id])

  return (
    <article
      className={clsx(
        'toast',
        `toast-${toast.type}`,
        `toast-stack-${stackIndex}`,
        { 'toast-exiting': toast.exiting }
      )}
    >
      <div className="toast-content-container">
        <div className="toast-header">
          <span className="toast-icon" aria-hidden="true">
            <i className={`toast-icon-symbol ri-${TOAST_ICONS[toast.type]}`} />
          </span>
          <strong className="toast-title">{toast.title}</strong>
        </div>
        <p className="toast-description">{toast.description}</p>
      </div>
      <div
        className="toast-close-button"
      >
        <Button
          iconName="close"
          ariaLabel="Close notification"
          onClick={() => onClose(toast.id)}
        />
      </div>
    </article>
  )
}

export function ToastProvider({
  children
}: ToastProviderProps) {
  const removalTimeoutsRef = useRef<Map<string, number>>(new Map())
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const closeToast = useCallback((toastId: string): void => {
    setToasts((currentToasts) =>
      currentToasts.map((toast) =>
        toast.id === toastId
          ? { ...toast, exiting: true }
          : toast
      )
    )

    if (removalTimeoutsRef.current.has(toastId)) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setToasts((currentToasts) =>
        currentToasts.filter((toast) => toast.id !== toastId)
      )
      removalTimeoutsRef.current.delete(toastId)
    }, TOAST_EXIT_DURATION_MS)

    removalTimeoutsRef.current.set(toastId, timeoutId)
  }, [])

  useEffect(() => () => {
    removalTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId)
    })
  }, [])

  const contextValue = useMemo<ToastContextValue>(() => ({
    showToast: (toast) => {
      setToasts((currentToasts) => [
        {
          id: createToastId(),
          exiting: false,
          type: toast.type ?? 'info',
          title: toast.title,
          description: toast.description
        },
        ...currentToasts
      ].slice(0, MAX_VISIBLE_TOASTS))
    }
  }), [])

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {createPortal(
        <section
          className="toast-region"
          aria-label="Notifications"
          aria-live="polite"
        >
          {toasts.map((toast, stackIndex) => (
            <ToastCard
              key={toast.id}
              stackIndex={stackIndex}
              toast={toast}
              onClose={closeToast}
            />
          ))}
        </section>,
        document.body
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const contextValue = useContext(ToastContext)

  if (contextValue === null) {
    throw new Error('useToast must be used within ToastProvider.')
  }

  return contextValue
}
