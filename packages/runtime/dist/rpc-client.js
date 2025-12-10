/**
 * RPC Client for calling Rust server functions from TypeScript
 */
import { IpcClient } from './ipc-client.js';
let ipcClient = null;
let requestCounter = 0;
const pendingRequests = new Map();
/**
 * Custom error class for RPC errors
 */
export class RpcError extends Error {
    constructor(errorType, message) {
        super(message);
        this.errorType = errorType;
        this.name = 'RpcError';
        // Restore prototype chain for proper instanceof checks
        Object.setPrototypeOf(this, RpcError.prototype);
    }
}
/**
 * Initialize the RPC client with a socket path
 */
export function initRpcClient(socketPath) {
    if (ipcClient) {
        throw new Error('RPC client already initialized');
    }
    ipcClient = new IpcClient(socketPath);
    // Setup response handler
    ipcClient.on('message', (message) => {
        if (message.type === 'rpc_response' && message.request_id) {
            const pending = pendingRequests.get(message.request_id);
            if (pending) {
                clearTimeout(pending.timeout);
                pending.resolve(message.result);
                pendingRequests.delete(message.request_id);
            }
        }
        else if (message.type === 'rpc_error' && message.request_id) {
            const pending = pendingRequests.get(message.request_id);
            if (pending) {
                clearTimeout(pending.timeout);
                const error = new RpcError(message.error_type || 'UnknownError', message.error || 'Unknown error');
                pending.reject(error);
                pendingRequests.delete(message.request_id);
            }
        }
    });
    ipcClient.on('error', (error) => {
        // Reject all pending requests on connection error
        for (const [_, pending] of pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        pendingRequests.clear();
    });
}
/**
 * Call a Rust server function via RPC
 */
export async function rpcCall(functionName, params = {}, timeoutMs = 30000) {
    if (!ipcClient) {
        throw new Error('RPC client not initialized. Call initRpcClient() first.');
    }
    const requestId = `req_${Date.now()}_${requestCounter++}`;
    const message = {
        type: 'rpc_call',
        function_name: functionName,
        params,
        request_id: requestId,
    };
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new RpcError('TimeoutError', `RPC call to ${functionName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pendingRequests.set(requestId, { resolve, reject, timeout });
        try {
            ipcClient.send(message);
        }
        catch (error) {
            clearTimeout(timeout);
            pendingRequests.delete(requestId);
            reject(error);
        }
    });
}
/**
 * Wait for a response from a specific request
 */
export async function waitForResponse(requestId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new RpcError('TimeoutError', `Request ${requestId} timed out`));
        }, timeoutMs);
        const handler = { resolve, reject, timeout };
        pendingRequests.set(requestId, handler);
    });
}
/**
 * Close the RPC client connection
 */
export async function closeRpcClient() {
    if (ipcClient) {
        // Reject all pending requests
        for (const [_, pending] of pendingRequests) {
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
export function isRpcClientInitialized() {
    return ipcClient !== null;
}
/**
 * Get current RPC client instance (for advanced usage)
 */
export function getRpcClient() {
    return ipcClient;
}
//# sourceMappingURL=rpc-client.js.map