import { createServer, Server, Socket, createConnection } from "net";
import { unlinkSync, existsSync } from "fs";
import { EventEmitter } from "events";
import { encode, decode } from "@msgpack/msgpack";
import type {
  ZapRequest,
  ZapHandlerResponse,
  IpcMessage,
  InvokeHandlerMessage,
  StreamChunk,
  WsHandler,
  WsConnection,
} from "./types.js";
import { isAsyncIterable } from "./types.js";

// Re-export types for backward compatibility
export type { ZapRequest as IpcRequest } from "./types.js";

/**
 * IPC encoding format
 */
export type IpcEncoding = "msgpack" | "json";

/**
 * Handler function type for IPC server (supports regular and streaming responses)
 */
export type HandlerFunction = (
  req: ZapRequest
) => Promise<ZapHandlerResponse> | AsyncIterable<StreamChunk>;

/**
 * Streaming handler function type
 */
export type StreamingHandlerFunction = (
  req: ZapRequest
) => AsyncIterable<StreamChunk>;

/**
 * WebSocket handler function type
 */
export type WsHandlerFunction = WsHandler;

/**
 * Serialize an IPC message to bytes
 */
function serializeMessage(msg: IpcMessage, encoding: IpcEncoding): Buffer {
  if (encoding === "msgpack") {
    return Buffer.from(encode(msg));
  }
  return Buffer.from(JSON.stringify(msg));
}

/**
 * Deserialize an IPC message from bytes (auto-detects encoding)
 */
function deserializeMessage(data: Buffer): IpcMessage {
  if (data.length === 0) {
    throw new Error("Empty message");
  }

  // Auto-detect: JSON starts with '{' (0x7B), MessagePack maps start with 0x80-0xBF
  const firstByte = data[0];
  if (firstByte === 0x7b) {
    // '{' character = JSON
    return JSON.parse(data.toString("utf-8")) as IpcMessage;
  }
  // MessagePack
  return decode(data) as IpcMessage;
}

/**
 * Write a length-prefixed message to a socket
 */
function writeFramedMessage(socket: Socket, msg: IpcMessage, encoding: IpcEncoding): void {
  const payload = serializeMessage(msg, encoding);
  const length = payload.length;

  // 4-byte big-endian length prefix
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(length, 0);

  // ATOMIC: Single write with combined buffer to prevent frame corruption
  const frame = Buffer.concat([lengthBuf, payload]);
  socket.write(frame);
}

/**
 * FrameReader - reads length-prefixed frames from a socket
 */
class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private onFrame: (frame: Buffer) => void;

  constructor(onFrame: (frame: Buffer) => void) {
    this.onFrame = onFrame;
  }

  /**
   * Process incoming data chunks
   */
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Process complete frames
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);

      // Check for unreasonably large messages (100MB limit)
      if (length > 100 * 1024 * 1024) {
        throw new Error(`Message too large: ${length} bytes`);
      }

      // Wait for complete frame
      if (this.buffer.length < 4 + length) {
        break;
      }

      // Extract frame
      const frame = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      // Emit frame
      this.onFrame(frame);
    }
  }

  /**
   * Reset the buffer
   */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * WebSocket connection implementation for TypeScript handlers
 */
class WsConnectionImpl implements WsConnection {
  id: string;
  path: string;
  headers: Record<string, string>;
  handlerId: string;
  private server: IpcServer;

  constructor(
    id: string,
    path: string,
    headers: Record<string, string>,
    handlerId: string,
    server: IpcServer
  ) {
    this.id = id;
    this.path = path;
    this.headers = headers;
    this.handlerId = handlerId;
    this.server = server;
  }

  /**
   * Send a text message to the client
   */
  send(data: string): void {
    this.server.sendWsMessage(this.id, data, false);
  }

  /**
   * Send binary data to the client
   */
  sendBinary(data: Uint8Array): void {
    // Base64 encode binary data for IPC transport
    const encoded = Buffer.from(data).toString("base64");
    this.server.sendWsMessage(this.id, encoded, true);
  }

  /**
   * Close the connection
   */
  close(code?: number, reason?: string): void {
    this.server.closeWsConnection(this.id, code, reason);
  }
}

/**
 * IpcServer
 *
 * Listens on a Unix socket for IPC messages from the Rust backend.
 * The Rust server sends handler invocation requests, which we dispatch
 * to the registered TypeScript handlers and send responses back.
 *
 * Protocol: Length-prefixed MessagePack (default) with JSON fallback
 * Frame format: [4-byte big-endian length][payload]
 */
export class IpcServer {
  private server: Server | null = null;
  private socketPath: string;
  private handlers: Map<string, HandlerFunction> = new Map();
  private wsHandlers: Map<string, WsHandlerFunction> = new Map();
  private wsConnections: Map<string, WsConnectionImpl> = new Map();
  private encoding: IpcEncoding;
  private currentSocket: Socket | null = null;

  constructor(socketPath: string, encoding: IpcEncoding = "msgpack") {
    this.socketPath = socketPath;
    this.encoding = encoding;
  }

  /**
   * Register a handler function for a specific handler ID
   */
  registerHandler(handlerId: string, handler: HandlerFunction): void {
    this.handlers.set(handlerId, handler);
  }

  /**
   * Register a WebSocket handler for a specific handler ID
   */
  registerWsHandler(handlerId: string, handler: WsHandlerFunction): void {
    this.wsHandlers.set(handlerId, handler);
  }

  /**
   * Start the IPC server listening on the Unix socket
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Clean up old socket file if it exists
        if (existsSync(this.socketPath)) {
          try {
            unlinkSync(this.socketPath);
          } catch {
            // Ignore if we can't delete it
          }
        }

        // Create Unix domain socket server
        this.server = createServer((socket) => {
          this.handleConnection(socket);
        });

        this.server.on("error", (err) => {
          console.error(`[IPC] Server error:`, err);
          reject(err);
        });

        this.server.listen(this.socketPath, () => {
          console.log(`[IPC] IPC server listening on ${this.socketPath} (${this.encoding})`);
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle a new IPC connection from the Rust server
   */
  private handleConnection(socket: Socket): void {
    console.log(`[IPC] Client connected`);
    this.currentSocket = socket;

    const frameReader = new FrameReader((frame) => {
      void this.handleFrame(frame, socket);
    });

    socket.on("data", (chunk) => {
      try {
        frameReader.push(chunk);
      } catch (error) {
        console.error(`[IPC] Frame error:`, error);
        socket.destroy();
      }
    });

    socket.on("close", () => {
      console.log(`[IPC] Client disconnected`);
      if (this.currentSocket === socket) {
        this.currentSocket = null;
      }
      // Clean up any WebSocket connections for this socket
      this.wsConnections.clear();
    });

    socket.on("error", (error) => {
      console.error(`[IPC] Connection error:`, error);
    });
  }

  /**
   * Handle a complete frame
   */
  private async handleFrame(frame: Buffer, socket: Socket): Promise<void> {
    try {
      const message = deserializeMessage(frame);
      await this.processMessage(message, socket);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Error processing message:`, errorMessage);
      const errorResponse: IpcMessage = {
        type: "error",
        code: "HANDLER_ERROR",
        message: errorMessage,
        status: 500,
        digest: crypto.randomUUID(),
      };
      writeFramedMessage(socket, errorResponse, this.encoding);
    }
  }

  /**
   * Process an incoming IPC message
   */
  private async processMessage(message: IpcMessage, socket: Socket): Promise<void> {
    console.log(`[IPC] Received message type: ${message.type}`);

    if (message.type === "invoke_handler") {
      const invokeMsg = message as InvokeHandlerMessage;
      const { handler_id, request } = invokeMsg;
      console.log(`[IPC] Looking for handler: ${handler_id}`);
      console.log(`[IPC] Available handlers: ${Array.from(this.handlers.keys()).join(', ')}`);

      const handler = this.handlers.get(handler_id);

      if (!handler) {
        console.error(`[IPC] Handler NOT FOUND: ${handler_id}`);
        writeFramedMessage(socket, {
          type: "error",
          code: "HANDLER_NOT_FOUND",
          message: `Handler ${handler_id} not found`,
          status: 404,
          digest: crypto.randomUUID(),
        }, this.encoding);
        return;
      }

      try {
        console.log(`[IPC] Invoking handler: ${handler_id} for ${request.method} ${request.path}`);
        const result = handler(request);

        // Check if this is a streaming response (async iterable)
        if (isAsyncIterable<StreamChunk>(result)) {
          await this.handleStreamingResponse(result, handler_id, socket);
        } else {
          // Regular response - await the promise
          const response = await result;
          console.log(`[IPC] Handler result:`, JSON.stringify(response, null, 2));

          writeFramedMessage(socket, {
            type: "handler_response",
            handler_id,
            status: response.status || 200,
            headers: response.headers || { "content-type": "application/json" },
            body: response.body || "{}",
          }, this.encoding);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[IPC] Error executing handler ${handler_id}:`, errorMessage);
        writeFramedMessage(socket, {
          type: "error",
          code: "HANDLER_EXECUTION_ERROR",
          message: errorMessage,
          status: 500,
          digest: crypto.randomUUID(),
        }, this.encoding);
      }
      return;
    }

    // Health check message
    if (message.type === "health_check") {
      console.log(`[IPC] Health check received`);
      writeFramedMessage(socket, { type: "health_check_response" }, this.encoding);
      return;
    }

    // WebSocket connect message - new client connected
    if (message.type === "ws_connect") {
      const { connection_id, handler_id, path, headers } = message as {
        connection_id: string;
        handler_id: string;
        path: string;
        headers: Record<string, string>;
      };

      console.log(`[IPC] WebSocket connect: ${connection_id} for handler ${handler_id}`);

      const wsHandler = this.wsHandlers.get(handler_id);
      if (!wsHandler) {
        console.error(`[IPC] WebSocket handler NOT FOUND: ${handler_id}`);
        writeFramedMessage(socket, {
          type: "error",
          code: "WS_HANDLER_NOT_FOUND",
          message: `WebSocket handler ${handler_id} not found`,
          status: 404,
          digest: crypto.randomUUID(),
        }, this.encoding);
        return;
      }

      // Create connection object and store it
      const connection = new WsConnectionImpl(connection_id, path, headers, handler_id, this);
      this.wsConnections.set(connection_id, connection);

      // Call onConnect if defined
      try {
        if (wsHandler.onConnect) {
          await wsHandler.onConnect(connection);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[IPC] WebSocket onConnect error:`, errorMessage);
        // Close the connection on error
        this.closeWsConnection(connection_id, 1011, errorMessage);
      }
      return;
    }

    // WebSocket message - message from client
    if (message.type === "ws_message") {
      const { connection_id, data, binary } = message as {
        connection_id: string;
        handler_id: string;
        data: string;
        binary: boolean;
      };

      console.log(`[IPC] WebSocket message from ${connection_id}: ${data.length} bytes (binary: ${binary})`);

      const connection = this.wsConnections.get(connection_id);
      if (!connection) {
        console.error(`[IPC] WebSocket connection NOT FOUND: ${connection_id}`);
        return;
      }

      // Use handler_id from the connection (set during connect)
      const wsHandler = this.wsHandlers.get(connection.handlerId);
      if (!wsHandler || !wsHandler.onMessage) {
        return;
      }

      try {
        let messageData: string | Uint8Array;
        if (binary) {
          // Decode base64 binary data
          messageData = Buffer.from(data, "base64");
        } else {
          messageData = data;
        }
        await wsHandler.onMessage(connection, messageData);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[IPC] WebSocket onMessage error:`, errorMessage);
        if (wsHandler.onError) {
          try {
            await wsHandler.onError(connection, error instanceof Error ? error : new Error(errorMessage));
          } catch {
            // Ignore errors in error handler
          }
        }
      }
      return;
    }

    // WebSocket close - client disconnected
    if (message.type === "ws_close") {
      const { connection_id, code, reason } = message as {
        connection_id: string;
        handler_id: string;
        code?: number;
        reason?: string;
      };

      console.log(`[IPC] WebSocket close: ${connection_id} (code: ${code}, reason: ${reason})`);

      const connection = this.wsConnections.get(connection_id);
      if (!connection) {
        return;
      }

      // Use handler_id from the connection (set during connect)
      const wsHandler = this.wsHandlers.get(connection.handlerId);
      if (wsHandler && wsHandler.onClose) {
        try {
          await wsHandler.onClose(connection, code, reason);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[IPC] WebSocket onClose error:`, errorMessage);
        }
      }

      // Remove from connections map
      this.wsConnections.delete(connection_id);
      return;
    }

    console.error(`[IPC] Unknown message type: ${message.type}`);
    writeFramedMessage(socket, {
      type: "error",
      code: "UNKNOWN_MESSAGE_TYPE",
      message: `Unknown message type: ${message.type}`,
      status: 400,
      digest: crypto.randomUUID(),
    }, this.encoding);
  }

  /**
   * Handle a streaming response from a handler
   */
  private async handleStreamingResponse(
    stream: AsyncIterable<StreamChunk>,
    handlerId: string,
    socket: Socket
  ): Promise<void> {
    const streamId = `stream_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    console.log(`[IPC] Starting streaming response: ${streamId}`);

    // Send stream start message
    writeFramedMessage(socket, {
      type: "stream_start",
      stream_id: streamId,
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }, this.encoding);

    try {
      // Stream chunks
      for await (const chunk of stream) {
        let data: string;

        if (chunk.bytes) {
          // Binary data - base64 encode
          data = Buffer.from(chunk.bytes).toString("base64");
        } else if (chunk.data) {
          // String data - base64 encode for consistency
          data = Buffer.from(chunk.data, "utf-8").toString("base64");
        } else {
          continue; // Skip empty chunks
        }

        writeFramedMessage(socket, {
          type: "stream_chunk",
          stream_id: streamId,
          data,
        }, this.encoding);
      }

      // Send stream end message
      writeFramedMessage(socket, {
        type: "stream_end",
        stream_id: streamId,
      }, this.encoding);

      console.log(`[IPC] Streaming response completed: ${streamId}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Streaming error for ${handlerId}:`, errorMessage);

      // Send error message
      writeFramedMessage(socket, {
        type: "error",
        code: "STREAM_ERROR",
        message: errorMessage,
        status: 500,
        digest: crypto.randomUUID(),
      }, this.encoding);
    }
  }

  /**
   * Send a message to a WebSocket client via the Rust server
   */
  sendWsMessage(connectionId: string, data: string, binary: boolean): void {
    if (!this.currentSocket) {
      console.error(`[IPC] Cannot send WebSocket message: no active socket`);
      return;
    }

    writeFramedMessage(this.currentSocket, {
      type: "ws_send",
      connection_id: connectionId,
      data,
      binary,
    }, this.encoding);
  }

  /**
   * Close a WebSocket connection via the Rust server
   */
  closeWsConnection(connectionId: string, code?: number, reason?: string): void {
    // Remove from connections map
    const connection = this.wsConnections.get(connectionId);
    const handlerId = connection?.handlerId || "";
    if (connection) {
      this.wsConnections.delete(connectionId);
    }

    if (!this.currentSocket) {
      console.error(`[IPC] Cannot close WebSocket connection: no active socket`);
      return;
    }

    writeFramedMessage(this.currentSocket, {
      type: "ws_close",
      connection_id: connectionId,
      handler_id: handlerId,
      code,
      reason,
    }, this.encoding);
  }

  /**
   * Stop the IPC server
   */
  async stop(): Promise<void> {
    // Close all WebSocket connections
    for (const [connectionId] of this.wsConnections) {
      this.closeWsConnection(connectionId, 1001, "Server shutting down");
    }
    this.wsConnections.clear();

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          // Clean up socket file
          if (existsSync(this.socketPath)) {
            try {
              unlinkSync(this.socketPath);
            } catch {
              // Ignore
            }
          }
          resolve();
        });
      });
    }
  }
}

/**
 * IpcClient
 *
 * Connects to a Unix socket to communicate with the Rust server.
 * Used for RPC calls from TypeScript to Rust.
 *
 * Protocol: Length-prefixed MessagePack (default) with JSON fallback
 */
export class IpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private connected: boolean = false;
  private frameReader: FrameReader | null = null;
  private encoding: IpcEncoding;

  constructor(socketPath: string, encoding: IpcEncoding = "msgpack") {
    super();
    this.socketPath = socketPath;
    this.encoding = encoding;
    this.connect();
  }

  /**
   * Connect to the Unix socket
   */
  private connect(): void {
    this.socket = createConnection(this.socketPath);

    this.socket.on("connect", () => {
      this.connected = true;
      this.emit("connect");

      // Set up frame reader for length-prefixed messages
      this.frameReader = new FrameReader((frame) => {
        try {
          const message = deserializeMessage(frame);
          this.emit("message", message);
        } catch (error) {
          this.emit("error", new Error(`Failed to deserialize message: ${error}`));
        }
      });
    });

    this.socket.on("data", (chunk) => {
      if (this.frameReader) {
        try {
          this.frameReader.push(chunk);
        } catch (error) {
          this.emit("error", error);
        }
      }
    });

    this.socket.on("error", (err) => {
      this.connected = false;
      this.emit("error", err);
    });

    this.socket.on("close", () => {
      this.connected = false;
      this.emit("close");
    });
  }

  /**
   * Send a message to the server
   */
  send(message: IpcMessage): void {
    if (!this.socket || !this.connected) {
      throw new Error("IPC client not connected");
    }
    writeFramedMessage(this.socket, message, this.encoding);
  }

  /**
   * Send a message and wait for response
   */
  async sendRecv(message: IpcMessage): Promise<IpcMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("IPC request timeout"));
      }, 30000);

      const handler = (response: IpcMessage) => {
        clearTimeout(timeout);
        this.removeListener("message", handler);
        resolve(response);
      };

      this.on("message", handler);
      this.send(message);
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    this.frameReader = null;

    if (this.socket) {
      return new Promise((resolve) => {
        this.socket!.once("close", resolve);
        this.socket!.end();
      });
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the encoding being used
   */
  getEncoding(): IpcEncoding {
    return this.encoding;
  }
}

// Export serialization utilities for testing
export { serializeMessage, deserializeMessage, FrameReader };
