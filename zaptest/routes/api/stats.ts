// Stats endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

// GET /api/stats - Returns site statistics
export const GET = async () => {
  return await rpc.call('get_stats', {});
};
