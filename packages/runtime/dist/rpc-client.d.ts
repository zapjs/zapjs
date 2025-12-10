/**
 * RPC Client for calling Rust server functions from TypeScript
 */
import { IpcClient } from './ipc-client.js';
/**
 * Custom error class for RPC errors
 */
export declare class RpcError extends Error {
    readonly errorType: string;
    constructor(errorType: string, message: string);
}
/**
 * Initialize the RPC client with a socket path
 */
export declare function initRpcClient(socketPath: string): void;
/**
 * Call a Rust server function via RPC
 */
export declare function rpcCall<T = any>(functionName: string, params?: Record<string, any>, timeoutMs?: number): Promise<T>;
/**
 * Wait for a response from a specific request
 */
export declare function waitForResponse(requestId: string, timeoutMs?: number): Promise<any>;
/**
 * Close the RPC client connection
 */
export declare function closeRpcClient(): Promise<void>;
/**
 * Check if RPC client is initialized
 */
export declare function isRpcClientInitialized(): boolean;
/**
 * Get current RPC client instance (for advanced usage)
 */
export declare function getRpcClient(): IpcClient | null;
//# sourceMappingURL=rpc-client.d.ts.map