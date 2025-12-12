// Features endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

// GET /api/features - Returns all ZapJS features
export const GET = async () => {
  return await rpc.call('get_features', {});
};
