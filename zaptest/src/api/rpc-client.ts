/**
 * RPC Client for ZapJS Server Functions
 * Uses IPC for ultra-fast communication (< 1ms latency)
 */

import { rpc } from '@zap-js/server';

/**
 * Make an RPC call to a Rust server function via IPC
 */
export async function rpcCall<T>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return await rpc.call<T>(method, params);
}

/**
 * Batch multiple RPC calls
 */
export async function rpcBatch<T extends unknown[]>(
  calls: Array<{ method: string; params: Record<string, unknown> }>
): Promise<T> {
  const results = await Promise.all(
    calls.map((call) => rpcCall(call.method, call.params))
  );
  return results as T;
}
