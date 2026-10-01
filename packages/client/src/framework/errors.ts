import { randomUUID } from 'node:crypto';
const format = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** React exposes only this opaque identifier; full errors stay in server logs. */
export function reportError(error: unknown): string {
  const previous = error && typeof error === 'object' && 'digest' in error ? error.digest : undefined;
  const digest = typeof previous === 'string' && format.test(previous) ? previous : randomUUID();
  console.error(`[zap] Error ${digest}`, error);
  return digest;
}

/** Never serialize arbitrary thrown values or expose application error messages. */
export function actionFailure(thrown: unknown): { message: string; digest: string } {
  return { message: 'Server action failed', digest: reportError(thrown) };
}
