import type { ReactNode } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  id: string
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => void
}

interface ToastProviderProps {
  children: ReactNode
}

interface ToastCardProps {
  toast: ToastItem
  onClose: (toastId: string) => void
}

const DEFAULT_TOAST_DURATION_MS = 7_000
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
    <article className={clsx('toast', `toast-${toast.type}`)}>
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
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const closeToast = useCallback((toastId: string): void => {
    setToasts((currentToasts) =>
      currentToasts.filter((toast) => toast.id !== toastId)
    )
  }, [])

  const contextValue = useMemo<ToastContextValue>(() => ({
    showToast: (toast) => {
      setToasts((currentToasts) => [
        {
          id: createToastId(),
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
          {toasts.map((toast) => (
            <ToastCard
              key={toast.id}
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
