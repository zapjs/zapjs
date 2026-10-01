import { Suspense } from 'react';
import Counter from './counter';
async function Deferred() {
  await new Promise(resolve => setTimeout(resolve, 150));
  return <p id="streamed">Streamed server component complete</p>;
}
export default function Page() {
  return <main><h1>Zap framework verification</h1><Counter /><Suspense fallback={<p id="pending">Loading server component</p>}><Deferred /></Suspense></main>;
}
