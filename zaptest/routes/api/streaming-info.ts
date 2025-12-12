// Streaming info endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

// GET /api/streaming-info - Returns streaming endpoint metadata
export const GET = async () => {
  return await rpc.call('get_streaming_info', {});
};
