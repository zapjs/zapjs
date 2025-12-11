/**
 * @zap-js/server
 * 
 * ZapJS server communication utilities
 */

// RPC client
import rpc from './src/rpc.js';

// IPC client
import ipc from './src/ipc.js';

// Types
import * as types from './src/types.js';

// Export everything
export {
  rpc,
  ipc,
  types
};