import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import http from 'http';

export interface HotReloadConfig {
  port?: number;
  host?: string;
}

export type ReloadType = 'full' | 'partial' | 'rust' | 'typescript' | 'config' | 'routes';

export interface ReloadMessage {
  type: 'reload' | 'update' | 'error' | 'connected';
  target?: ReloadType;
  files?: string[];
  message?: string;
  timestamp: number;
}

/**
 * HotReloadServer - WebSocket server for hot reload signaling
 *
 * Broadcasts reload signals to connected clients:
 * - Full page reload for Rust changes
 * - Partial reload for TypeScript changes (Vite HMR handles this)
 * - Config reload notifications
 */
export class HotReloadServer extends EventEmitter {
  private config: HotReloadConfig;
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private clients: Set<WebSocket> = new Set();

  constructor(config: HotReloadConfig = {}) {
    super();
    this.config = {
      port: 3001,
      host: '127.0.0.1',
      ...config,
    };
  }

  /**
   * Start the hot reload WebSocket server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        // Simple health check endpoint
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
          return;
        }

        // Serve a simple client script
        if (req.url === '/client.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(this.getClientScript());
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws, req) => {
        this.clients.add(ws);
        this.emit('client-connected', req.socket.remoteAddress);

        // Send welcome message
        this.send(ws, {
          type: 'connected',
          message: 'Connected to ZapRS hot reload server',
          timestamp: Date.now(),
        });

        ws.on('close', () => {
          this.clients.delete(ws);
          this.emit('client-disconnected');
        });

        ws.on('error', (err) => {
          this.emit('client-error', err);
          this.clients.delete(ws);
        });
      });

      this.wss.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.emit('ready', this.config.port);
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    // Close all client connections
    for (const client of this.clients) {
      client.close(1000, 'Server shutting down');
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  /**
   * Broadcast a reload signal to all clients
   */
  reload(target: ReloadType, files?: string[]): void {
    const message: ReloadMessage = {
      type: 'reload',
      target,
      files,
      timestamp: Date.now(),
    };

    this.broadcast(message);
  }

  /**
   * Broadcast an update signal (partial reload)
   */
  update(files: string[]): void {
    const message: ReloadMessage = {
      type: 'update',
      files,
      timestamp: Date.now(),
    };

    this.broadcast(message);
  }

  /**
   * Broadcast an error message
   */
  notifyError(errorMessage: string): void {
    const message: ReloadMessage = {
      type: 'error',
      message: errorMessage,
      timestamp: Date.now(),
    };

    this.broadcast(message);
  }

  /**
   * Broadcast a message to all connected clients
   */
  private broadcast(message: ReloadMessage): void {
    const json = JSON.stringify(message);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }

    this.emit('broadcast', message);
  }

  /**
   * Send a message to a specific client
   */
  private send(ws: WebSocket, message: ReloadMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Get the number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get the hot reload server URL
   */
  getUrl(): string {
    return `ws://${this.config.host}:${this.config.port}`;
  }

  /**
   * Get the client script for browser injection
   */
  getClientScript(): string {
    return `
(function() {
  const WS_URL = 'ws://${this.config.host}:${this.config.port}';
  let ws;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = function() {
      console.log('[ZapRS] Hot reload connected');
      reconnectAttempts = 0;
    };

    ws.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (e) {
        console.error('[ZapRS] Failed to parse message:', e);
      }
    };

    ws.onclose = function() {
      console.log('[ZapRS] Hot reload disconnected');
      attemptReconnect();
    };

    ws.onerror = function(err) {
      console.error('[ZapRS] WebSocket error:', err);
    };
  }

  function handleMessage(data) {
    switch (data.type) {
      case 'connected':
        console.log('[ZapRS]', data.message);
        break;
      case 'reload':
        console.log('[ZapRS] Reloading:', data.target);
        if (data.target === 'rust' || data.target === 'full') {
          window.location.reload();
        }
        break;
      case 'update':
        console.log('[ZapRS] Files updated:', data.files);
        // Vite HMR handles partial updates
        break;
      case 'error':
        console.error('[ZapRS] Build error:', data.message);
        showErrorOverlay(data.message);
        break;
    }
  }

  function showErrorOverlay(message) {
    const existing = document.getElementById('zap-error-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'zap-error-overlay';
    overlay.style.cssText = \`
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.9);
      color: #ff6b6b;
      font-family: monospace;
      padding: 20px;
      z-index: 99999;
      overflow: auto;
      white-space: pre-wrap;
    \`;
    overlay.innerHTML = \`
      <div style="max-width: 800px; margin: 0 auto;">
        <h2 style="color: #ff6b6b;">Build Error</h2>
        <pre style="background: #1a1a1a; padding: 15px; border-radius: 4px;">\${escapeHtml(message)}</pre>
        <button onclick="this.parentElement.parentElement.remove()" style="margin-top: 10px; padding: 8px 16px; cursor: pointer;">
          Dismiss
        </button>
      </div>
    \`;
    document.body.appendChild(overlay);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function attemptReconnect() {
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      setTimeout(connect, 1000 * reconnectAttempts);
    }
  }

  connect();
})();
`;
  }

  /**
   * Get an HTML script tag for the client
   */
  getScriptTag(): string {
    return `<script src="http://${this.config.host}:${this.config.port}/client.js"></script>`;
  }
}
