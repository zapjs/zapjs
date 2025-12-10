import { createServer, Server, Socket, createConnection } from "net";
import { createInterface, Interface } from "readline";
import { unlinkSync, existsSync } from "fs";
import { EventEmitter } from "events";
import type {
  ZapRequest,
  ZapHandlerResponse,
  IpcMessage,
  InvokeHandlerMessage,
  isInvokeHandlerMessage,
  isHealthCheckMessage,
} from "./types.js";

// Re-export types for backward compatibility
export type { ZapRequest as IpcRequest } from "./types.js";

/**
 * Handler function type for IPC server
 */
export type HandlerFunction = (
  req: ZapRequest
) => Promise<ZapHandlerResponse>;

/**
 * IpcServer
 *
 * Listens on a Unix socket for IPC messages from the Rust backend.
 * The Rust server sends handler invocation requests, which we dispatch
 * to the registered TypeScript handlers and send responses back.
 *
 * Protocol: Newline-delimited JSON over Unix domain socket
 */
export class IpcServer {
  private server: Server | null = null;
  private socketPath: string;
  private handlers: Map<string, HandlerFunction> = new Map();

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Register a handler function for a specific handler ID
   */
  registerHandler(handlerId: string, handler: HandlerFunction): void {
    this.handlers.set(handlerId, handler);
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
          console.log(`[IPC] IPC server listening on ${this.socketPath}`);
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

    const readline = createInterface({
      input: socket,
      crlfDelay: Infinity,
    });

    // Handle incoming messages (newline-delimited JSON)
    readline.on("line", (line: string) => {
      void this.handleLine(line, socket);
    });

    readline.on("close", () => {
      console.log(`[IPC] Client disconnected`);
    });

    readline.on("error", (error) => {
      console.error(`[IPC] Connection error:`, error);
    });
  }

  /**
   * Handle a single line of input (async wrapper)
   */
  private async handleLine(line: string, socket: Socket): Promise<void> {
    try {
      const message = JSON.parse(line) as IpcMessage;
      const response = await this.processMessage(message);
      // Send response as newline-delimited JSON
      socket.write(JSON.stringify(response) + "\n");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Error processing message:`, errorMessage);
      const errorResponse: IpcMessage = {
        type: "error",
        code: "HANDLER_ERROR",
        message: errorMessage,
      };
      socket.write(JSON.stringify(errorResponse) + "\n");
    }
  }

  /**
   * Process an incoming IPC message
   */
  private async processMessage(message: IpcMessage): Promise<IpcMessage> {
    console.log(`[IPC] Received message type: ${message.type}`);

    if (message.type === "invoke_handler") {
      const invokeMsg = message as InvokeHandlerMessage;
      const { handler_id, request } = invokeMsg;
      console.log(`[IPC] Looking for handler: ${handler_id}`);
      console.log(`[IPC] Available handlers: ${Array.from(this.handlers.keys()).join(', ')}`);

      const handler = this.handlers.get(handler_id);

      if (!handler) {
        console.error(`[IPC] Handler NOT FOUND: ${handler_id}`);
        return {
          type: "error",
          code: "HANDLER_NOT_FOUND",
          message: `Handler ${handler_id} not found`,
        };
      }

      try {
        console.log(`[IPC] Invoking handler: ${handler_id} for ${request.method} ${request.path}`);
        const result = await handler(request);
        console.log(`[IPC] Handler result:`, JSON.stringify(result, null, 2));

        return {
          type: "handler_response",
          handler_id,
          status: result.status || 200,
          headers: result.headers || { "content-type": "application/json" },
          body: result.body || "{}",
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[IPC] Error executing handler ${handler_id}:`, errorMessage);
        return {
          type: "error",
          code: "HANDLER_EXECUTION_ERROR",
          message: errorMessage,
        };
      }
    }

    // Health check message
    if (message.type === "health_check") {
      console.log(`[IPC] Health check received`);
      return { type: "health_check_response" };
    }

    console.error(`[IPC] Unknown message type: ${message.type}`);
    return {
      type: "error",
      code: "UNKNOWN_MESSAGE_TYPE",
      message: `Unknown message type: ${message.type}`,
    };
  }

  /**
   * Stop the IPC server
   */
  async stop(): Promise<void> {
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
 */
export class IpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private connected: boolean = false;
  private readline: Interface | null = null;

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
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

      // Set up readline for newline-delimited JSON
      this.readline = createInterface({
        input: this.socket!,
        crlfDelay: Infinity,
      });

      this.readline.on("line", (line: string) => {
        try {
          const message: unknown = JSON.parse(line);
          this.emit("message", message);
        } catch {
          this.emit("error", new Error(`Failed to parse message: ${line}`));
        }
      });
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
  send(message: object): void {
    if (!this.socket || !this.connected) {
      throw new Error("IPC client not connected");
    }
    this.socket.write(JSON.stringify(message) + "\n");
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

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
}
