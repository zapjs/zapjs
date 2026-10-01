'use client';
export default function ErrorBoundary({ reset }: { reset: () => void }) { return <section><h1>Handled page error</h1><button onClick={reset}>Retry</button></section>; }
