// Benchmarks endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

// GET /api/benchmarks - Returns performance benchmark data
export const GET = async () => {
  return await rpc.call('get_benchmarks', {});
};
