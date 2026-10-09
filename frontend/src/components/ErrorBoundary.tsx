import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/components/Button';

/**
 * Catches a render crash so one broken screen does not blank the whole app.
 *
 * `resetKey` clears the error when it changes — the shell passes the route,
 * so navigating away from a broken page shows the next page normally.
 * Navigation uses `window.location` so the fallback also works above the
 * router (the top-level boundary).
 */
interface Props { children: ReactNode; resetKey?: string; fullPage?: boolean }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console for whoever opens dev tools; nothing is sent anywhere.
    console.error('Screen crashed:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.fullPage ? 'min-h-screen flex items-center justify-center p-4 bg-neutral-50' : 'py-6'}>
        <div role="alert" className="dash-card max-w-[520px] w-full mx-auto p-6">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Something went wrong</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">This screen could not be shown</h1>
          <p className="text-13 text-neutral-600 mt-2">
            Your data is safe — nothing was saved or lost by this. Reload to try again, or go back to the dashboard.
          </p>
          {this.state.error.message ? (
            <p className="mt-3 text-12 text-neutral-500 font-mono break-words">{this.state.error.message}</p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => window.location.reload()}>Reload</Button>
            <Button onClick={() => window.location.assign('/')}>Go to dashboard</Button>
          </div>
        </div>
      </div>
    );
  }
}

/** The boundary for routed content: resets whenever the route changes. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}
