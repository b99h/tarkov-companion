import { useEffect, useState } from 'react'
import type { QuestEventNotice } from '@shared/types'

interface Toast extends QuestEventNotice {
  key: number
  /** When set, this is a summary toast standing in for a whole batch. */
  summaryLabel?: string
}

const VERBS: Record<QuestEventNotice['type'], string> = {
  started: 'Quest started',
  failed: 'Quest failed',
  finished: 'Quest complete'
}

const TOAST_MS = 6000

// Above this many events in a single batch (e.g. first live processing of an
// already-long session before any checkpoint exists), collapse into one summary
// toast instead of flooding the corner with a toast per historical event.
const BATCH_SUMMARY_THRESHOLD = 5

/**
 * Bottom-right toasts driven by live quest events from the log watcher. Mount once
 * near the app root; it self-subscribes and needs no props.
 */
export function Toasts(): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    let counter = 0
    return window.api.onQuestEvents((notices) => {
      if (notices.length === 0) return
      const incoming: Toast[] =
        notices.length > BATCH_SUMMARY_THRESHOLD
          ? [
              {
                ...notices[0],
                key: Date.now() + counter++,
                summaryLabel: `Applied ${notices.length} quest updates from log catch-up`
              }
            ]
          : notices.map((n) => ({ ...n, key: Date.now() + counter++ }))
      setToasts((prev) => [...prev, ...incoming])
      for (const toast of incoming) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.key !== toast.key))
        }, TOAST_MS)
      }
    })
  }, [])

  if (toasts.length === 0) return <></>

  return (
    <div className="toast-stack">
      {toasts.map((toast) =>
        toast.summaryLabel ? (
          <div key={toast.key} className="toast toast-finished">
            <span className="toast-label">Log catch-up</span>
            <span className="toast-name">{toast.summaryLabel}</span>
          </div>
        ) : (
          <div key={toast.key} className={`toast toast-${toast.type}`}>
            <span className="toast-label">{VERBS[toast.type]}</span>
            <span className="toast-name">{toast.taskName}</span>
          </div>
        )
      )}
    </div>
  )
}
