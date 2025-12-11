/**
 * @zap-js/server/rpc
 * 
 * RPC client for server communication
 */

import { rpcCall } from '../../client/internal/runtime/src/rpc-client.js';

// RPC object with call method
const rpc = {
  call: rpcCall,
};

export default rpc;