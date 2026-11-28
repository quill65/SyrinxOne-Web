import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[SyrinxOne] Uncaught render error:', error, info.componentStack);
  }

  private handleRecover = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary-shell" role="alert">
          <div className="error-boundary-card">
            <h2>Something went wrong in the workspace view</h2>
            <p className="error-boundary-msg">
              {this.state.error.message || 'An unexpected rendering error occurred.'}
            </p>
            <div className="error-boundary-actions">
              <button type="button" className="btn-primary" onClick={this.handleRecover}>
                Recover View
              </button>
              <button type="button" className="btn-small" onClick={this.handleReload}>
                Reload App
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
