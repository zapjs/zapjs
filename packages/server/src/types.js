/**
 * @zap-js/server/types
 * 
 * TypeScript types for server-side features
 */

// RPC types
export type {
  RpcMessage,
  RpcCallMessage,
  RpcResponseMessage,
  RpcErrorMessage,
} from '../../client/internal/runtime/src/types.js';

// IPC types
export type {
  IpcMessage,
  InvokeHandlerMessage,
  HandlerResponseMessage,
  ErrorMessage,
} from '../../client/internal/runtime/src/types.js';