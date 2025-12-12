// Blog posts endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

type ZapRequest = {
  method: string;
  path: string;
  path_only: string;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  cookies: Record<string, string>;
};

// GET /api/posts - List posts with pagination and filtering
export const GET = async (req: ZapRequest) => {
  const page = Math.max(1, parseInt(req.query.page || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10')));
  const tag = req.query.tag || null;
  const author = req.query.author || null;

  return await rpc.call('list_posts', { page, limit, tag, author });
};

// POST /api/posts - Create a new post
export const POST = async (req: ZapRequest) => {
  try {
    const body = req.body ? JSON.parse(req.body) : {};
    const { title, content, author, tags = [] } = body;

    if (!title || !content || !author) {
      return {
        status: 400,
        error: 'Title, content, and author are required',
        code: 'VALIDATION_ERROR',
      };
    }

    // For now, POST creates in-memory only since Rust doesn't have create_post
    // This could be extended to call a Rust function when available
    return {
      status: 501,
      error: 'Post creation not yet implemented in Rust backend',
      code: 'NOT_IMPLEMENTED',
    };
  } catch {
    return {
      status: 400,
      error: 'Invalid JSON body',
      code: 'INVALID_JSON',
    };
  }
};
