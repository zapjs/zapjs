import { EventEmitter } from "events";
export interface IpcRequest {
    method: string;
    path: string;
    path_only: string;
    query: Record<string, string>;
    params: Record<string, string>;
    headers: Record<string, string>;
    body: string;
    cookies: Record<string, string>;
}
export interface IpcMessage {
    type: string;
    [key: string]: any;
}
export type HandlerFunction = (req: IpcRequest) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
}>;
/**
 * IpcServer
 *
 * Listens on a Unix socket for IPC messages from the Rust backend.
 * The Rust server sends handler invocation requests, which we dispatch
 * to the registered TypeScript handlers and send responses back.
 *
 * Protocol: Newline-delimited JSON over Unix domain socket
 */
export declare class IpcServer {
    private server;
    private socketPath;
    private handlers;
    constructor(socketPath: string);
    /**
     * Register a handler function for a specific handler ID
     */
    registerHandler(handlerId: string, handler: HandlerFunction): void;
    /**
     * Start the IPC server listening on the Unix socket
     */
    start(): Promise<void>;
    /**
     * Handle a new IPC connection from the Rust server
     */
    private handleConnection;
    /**
     * Process an incoming IPC message
     */
    private processMessage;
    /**
     * Stop the IPC server
     */
    stop(): Promise<void>;
}
/**
 * IpcClient
 *
 * Connects to a Unix socket to communicate with the Rust server.
 * Used for RPC calls from TypeScript to Rust.
 */
export declare class IpcClient extends EventEmitter {
    private socket;
    private socketPath;
    private connected;
    private readline;
    constructor(socketPath: string);
    /**
     * Connect to the Unix socket
     */
    private connect;
    /**
     * Send a message to the server
     */
    send(message: object): void;
    /**
     * Close the connection
     */
    close(): Promise<void>;
    /**
     * Check if connected
     */
    isConnected(): boolean;
}
//# sourceMappingURL=ipc-client.d.ts.map