import { Component, type ReactNode } from 'react'

/** Shows render crashes on screen instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[GM Agent] UI crashed:', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 24, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap' }}>
        <h2>Something broke in the UI</h2>
        <p>{String(this.state.error.stack ?? this.state.error)}</p>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}
