// SSG info endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

// GET /api/ssg-info - Returns SSG (Static Site Generation) metadata
export const GET = async () => {
  return await rpc.call('get_ssg_info', {});
};
