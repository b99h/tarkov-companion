import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'

const RELEASES_URL = 'https://github.com/b99h/tarkov-companion/releases/latest'

/**
 * Top-of-app banner driven by updater status pushed from main. Mount once near
 * the app root; it self-subscribes and needs no props. Nothing downloads or
 * installs until the user clicks — the banner is the consent step.
 */
export function UpdateBanner(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    return window.api.onUpdateStatus((next) => {
      setStatus(next)
      // A new "update available" (e.g. the 4-hourly re-check found a newer
      // version) re-surfaces a banner the user dismissed for the previous one.
      if (next.state === 'available') setDismissed(false)
    })
  }, [])

  if (!status || dismissed) return <></>
  // 'checking' and 'idle' (no update / check finished clean) render nothing.
  if (status.state !== 'available' && status.state !== 'downloading' && status.state !== 'ready' && status.state !== 'error') {
    return <></>
  }

  return (
    <div className={`update-banner update-banner-${status.state}`}>
      {status.state === 'available' &&
        (status.portable ? (
          <>
            <span>
              Update available: v{status.version}. The portable exe can’t update itself —
              download the new version from GitHub.
            </span>
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">
              Open releases page ↗
            </a>
          </>
        ) : (
          <>
            <span>Update available: v{status.version}</span>
            <button onClick={() => void window.api.downloadUpdate()}>Update now</button>
          </>
        ))}
      {status.state === 'downloading' && (
        <span>
          Downloading v{status.version ?? 'update'}… {status.percent ?? 0}%
        </span>
      )}
      {status.state === 'ready' && (
        <>
          <span>v{status.version} downloaded.</span>
          <button onClick={() => void window.api.installUpdate()}>Restart to install</button>
          <span className="update-banner-hint">Installs now and reopens the app.</span>
        </>
      )}
      {status.state === 'error' && (
        <>
          <span>Update failed: {status.message ?? 'unknown error'}</span>
          <button onClick={() => void window.api.checkForUpdates()}>Retry</button>
        </>
      )}
      <button
        className="update-banner-dismiss"
        title="Hide"
        aria-label="Hide update banner"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  )
}
