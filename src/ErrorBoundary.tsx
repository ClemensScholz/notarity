import { Component, type ReactNode } from 'react'
import { logError } from './errorLog'

interface Props {
  children: ReactNode
  fallback: (error: Error) => ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    logError('ErrorBoundary', error)
  }

  componentDidUpdate(prevProps: Props) {
    // Reset once the thing being rendered changes (e.g. a new file prop
    // further up), so a fixed/different input gets a fresh render attempt
    // instead of staying stuck on a stale error.
    if (prevProps.children !== this.props.children && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) return this.props.fallback(this.state.error)
    return this.props.children
  }
}
