// WebSocket info endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

// GET /api/websocket-info - Returns WebSocket endpoint metadata
export const GET = async () => {
  return await rpc.call('get_websocket_info', {});
};
