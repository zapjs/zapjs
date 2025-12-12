// Single post endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

// GET /api/posts/:id - Get a specific post by ID or slug
export const GET = async ({ params }: { params: { id: string } }) => {
  const result = await rpc.call('get_post', { id: params.id });

  // Handle not found from Rust backend
  if (result && typeof result === 'object' && 'error' in result) {
    return new Response(
      JSON.stringify(result),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return result;
};
