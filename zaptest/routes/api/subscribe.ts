// Newsletter subscription endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

// POST /api/subscribe - Subscribe to newsletter
export const POST = async ({ request }: { request: Request }) => {
  try {
    const body = await request.json();
    const { email } = body;

    if (!email) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Email is required',
          code: 'MISSING_EMAIL',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const result = await rpc.call('subscribe', { email });

    // Handle error responses from Rust
    if (result && typeof result === 'object' && 'success' in result && !result.success) {
      const status = (result as { code?: string }).code === 'ALREADY_SUBSCRIBED' ? 409 : 400;
      return new Response(
        JSON.stringify(result),
        { status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return result;
  } catch {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Invalid JSON body',
        code: 'INVALID_JSON',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// GET /api/subscribe - Returns endpoint documentation
export const GET = async () => {
  return {
    endpoint: '/api/subscribe',
    method: 'POST',
    description: 'Subscribe to the ZapJS newsletter',
    body: {
      email: 'string (required)',
    },
    responses: {
      200: { success: true, message: 'string', email: 'string', subscribedAt: 'string' },
      400: { success: false, error: 'string', code: 'MISSING_EMAIL | INVALID_EMAIL | INVALID_JSON' },
      409: { success: false, error: 'string', code: 'ALREADY_SUBSCRIBED' },
    },
  };
};
