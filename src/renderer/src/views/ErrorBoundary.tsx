import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render errors in whatever view it wraps so one broken view degrades to
 * an inline error card instead of blanking the whole app (how the Phase 3
 * cache-shape crash presented). Wrapped per-view and keyed by the active view in
 * App, so switching views — or the explicit "Try again" — resets it. "Reload
 * data" does a full renderer reload, the surest way to recover from bad cached
 * data the boundary can't fix on its own.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[view] render error:', error, info.componentStack)
  }

  private reset = (): void => this.setState({ error: null })

  private reload = (): void => window.location.reload()

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="view-error">
        <h2>Something went wrong in this view</h2>
        <p className="error">{error.message}</p>
        <div className="button-row">
          <button onClick={this.reset}>Try again</button>
          <button onClick={this.reload}>Reload data</button>
        </div>
      </div>
    )
  }
}
