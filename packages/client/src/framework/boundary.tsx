'use client';
import React from 'react';
interface Props { children: React.ReactNode; fallback?: React.ComponentType<{ error: Error; reset: () => void }>; resetKey?: string; document?: boolean }
export class RouteBoundary extends React.Component<Props, { error: Error | null; key?: string }> {
  state: { error: Error | null; key?: string } = { error: null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(props: Props, state: { key?: string }) { return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null; }
  reset = () => { this.setState({ error: null }); window.dispatchEvent(new Event('zap:refresh')); };
  render() {
    if (!this.state.error) return this.props.children;
    const Fallback = this.props.fallback;
    if (Fallback) return <Fallback error={this.state.error} reset={this.reset} />;
    const content = <main role="alert"><h1>Something went wrong</h1><button onClick={this.reset}>Try again</button></main>;
    return this.props.document ? <html><body>{content}</body></html> : content;
  }
}
