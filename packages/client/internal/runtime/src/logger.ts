/**
 * Structured JSON Logger for ZapJS
 *
 * Provides consistent JSON logging with request context.
 * Used across the TypeScript runtime for observability.
 */

export interface LogContext {
  request_id?: string;
  handler_id?: string;
  method?: string;
  path?: string;
  duration_ms?: number;
  status?: number;
  [key: string]: unknown;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

class Logger {
  private jsonFormat: boolean;
  private minLevel: LogLevel;

  constructor() {
    this.jsonFormat = process.env.ZAP_JSON_LOGS === 'true';
    this.minLevel = (process.env.ZAP_LOG_LEVEL as LogLevel) || 'info';
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private formatEntry(entry: LogEntry): string {
    if (this.jsonFormat) {
      return JSON.stringify(entry);
    }

    // Human-readable format for development
    const ctx = entry.context;
    const timestamp = entry.timestamp.split('T')[1].split('.')[0]; // HH:MM:SS
    const level = entry.level.toUpperCase().padEnd(5);
    const requestIdStr = ctx?.request_id ? `[${ctx.request_id.slice(0, 8)}]` : '';

    const contextParts: string[] = [];
    if (ctx) {
      if (ctx.method) contextParts.push(`${ctx.method}`);
      if (ctx.path) contextParts.push(`${ctx.path}`);
      if (ctx.handler_id) contextParts.push(`handler=${ctx.handler_id}`);
      if (ctx.duration_ms !== undefined) contextParts.push(`${ctx.duration_ms.toFixed(2)}ms`);
      if (ctx.status) contextParts.push(`status=${ctx.status}`);
    }

    const contextStr = contextParts.length > 0 ? ` ${contextParts.join(' ')}` : '';

    let result = `${timestamp} ${level} ${requestIdStr} ${entry.message}${contextStr}`;

    if (entry.error) {
      result += `\n  Error: ${entry.error.name}: ${entry.error.message}`;
      if (entry.error.stack && process.env.NODE_ENV !== 'production') {
        result += `\n${entry.error.stack}`;
      }
    }

    return result.trim();
  }

  private log(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: Error
  ): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    const output = this.formatEntry(entry);

    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  trace(message: string, context?: LogContext): void {
    this.log('trace', message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    this.log('error', message, context, error);
  }

  /**
   * Create a child logger with pre-set context
   */
  child(baseContext: LogContext): ChildLogger {
    return new ChildLogger(this, baseContext);
  }

  /**
   * Set JSON format mode
   */
  setJsonFormat(enabled: boolean): void {
    this.jsonFormat = enabled;
  }

  /**
   * Set minimum log level
   */
  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /**
   * Get current configuration
   */
  getConfig(): { jsonFormat: boolean; minLevel: LogLevel } {
    return {
      jsonFormat: this.jsonFormat,
      minLevel: this.minLevel,
    };
  }
}

/**
 * Child logger with inherited base context
 */
class ChildLogger {
  constructor(
    private parent: Logger,
    private baseContext: LogContext
  ) {}

  private mergeContext(context?: LogContext): LogContext {
    return { ...this.baseContext, ...context };
  }

  trace(message: string, context?: LogContext): void {
    this.parent.trace(message, this.mergeContext(context));
  }

  debug(message: string, context?: LogContext): void {
    this.parent.debug(message, this.mergeContext(context));
  }

  info(message: string, context?: LogContext): void {
    this.parent.info(message, this.mergeContext(context));
  }

  warn(message: string, context?: LogContext): void {
    this.parent.warn(message, this.mergeContext(context));
  }

  error(message: string, context?: LogContext, error?: Error): void {
    this.parent.error(message, this.mergeContext(context), error);
  }

  /**
   * Create a further nested child logger
   */
  child(additionalContext: LogContext): ChildLogger {
    return new ChildLogger(this.parent, {
      ...this.baseContext,
      ...additionalContext,
    });
  }
}

/**
 * Global logger instance
 */
export const logger = new Logger();

export { Logger, ChildLogger };
