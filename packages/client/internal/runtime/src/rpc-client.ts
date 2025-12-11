/**
 * RPC Client for calling Rust server functions from TypeScript
 */

import { IpcClient } from './ipc-client.js';
import type { RpcMessage, RpcCallMessage, PendingRequest } from './types.js';
import { isRpcResponseMessage, isRpcErrorMessage } from './types.js';

let ipcClient: IpcClient | null = null;
let requestCounter = 0;
const pendingRequests = new Map<string, PendingRequest>();

/**
 * Custom error class for RPC errors
 */
export class RpcError extends Error {
  constructor(
    public readonly errorType: string,
    message: string
  ) {
    super(message);
    this.name = 'RpcError';

    // Restore prototype chain for proper instanceof checks
    Object.setPrototypeOf(this, RpcError.prototype);
  }
}

/**
 * Initialize the RPC client with a socket path
 */
export function initRpcClient(socketPath: string): void {
  if (ipcClient) {
    throw new Error('RPC client already initialized');
  }

  ipcClient = new IpcClient(socketPath);

  // Setup response handler
  ipcClient.on('message', (message: unknown) => {
    // Validate message structure
    if (!message || typeof message !== 'object') {
      return;
    }

    const msg = message as RpcMessage;

    if (isRpcResponseMessage(msg) && msg.request_id) {
      const pending = pendingRequests.get(msg.request_id);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(msg.result);
        pendingRequests.delete(msg.request_id);
      }
    } else if (isRpcErrorMessage(msg) && msg.request_id) {
      const pending = pendingRequests.get(msg.request_id);
      if (pending) {
        clearTimeout(pending.timeout);
        const error = new RpcError(
          msg.error_type || 'UnknownError',
          msg.error || 'Unknown error'
        );
        pending.reject(error);
        pendingRequests.delete(msg.request_id);
      }
    }
  });

  ipcClient.on('error', (error: Error) => {
    // Reject all pending requests on connection error
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    pendingRequests.clear();
  });
}

/**
 * Call a Rust server function via RPC
 */
export async function rpcCall<T = unknown>(
  functionName: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = 30000
): Promise<T> {
  if (!ipcClient) {
    throw new Error('RPC client not initialized. Call initRpcClient() first.');
  }

  const requestId = `req_${Date.now()}_${requestCounter++}`;

  const message: RpcCallMessage = {
    type: 'rpc_call',
    function_name: functionName,
    params,
    request_id: requestId,
  };

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new RpcError('TimeoutError', `RPC call to ${functionName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timeout,
    });

    try {
      ipcClient!.send(message);
    } catch (error) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Wait for a response from a specific request
 */
export async function waitForResponse<T = unknown>(
  requestId: string,
  timeoutMs: number = 30000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new RpcError('TimeoutError', `Request ${requestId} timed out`));
    }, timeoutMs);

    const handler: PendingRequest = {
      resolve: resolve as (value: unknown) => void,
      reject,
      timeout,
    };
    pendingRequests.set(requestId, handler);
  });
}

/**
 * Close the RPC client connection
 */
export async function closeRpcClient(): Promise<void> {
  if (ipcClient) {
    // Reject all pending requests
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('RPC client closed'));
    }
    pendingRequests.clear();

    await ipcClient.close();
    ipcClient = null;
  }
}

/**
 * Check if RPC client is initialized
 */
export function isRpcClientInitialized(): boolean {
  return ipcClient !== null;
}

/**
 * Get current RPC client instance (for advanced usage)
 */
export function getRpcClient(): IpcClient | null {
  return ipcClient;
}
