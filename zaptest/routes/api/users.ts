// Users CRUD endpoint - calls Rust backend via RPC
import { rpc, types } from '@zap-js/server';

// Use the Request type from our server package
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

// GET /api/users - List all users with pagination
export const GET = async (req: ZapRequest) => {
  const limit = parseInt(req.query.limit || '10');
  const offset = parseInt(req.query.offset || '0');

  return await rpc.call('list_users', { limit, offset });
};

// POST /api/users - Create a new user
export const POST = async (req: ZapRequest) => {
  try {
    const body = req.body ? JSON.parse(req.body) : {};
    const { name, email, role = 'user' } = body;

    if (!name || !email) {
      return {
        status: 400,
        error: 'Name and email are required',
        code: 'VALIDATION_ERROR',
      };
    }

    return await rpc.call('create_user', { name, email, role });
  } catch {
    return {
      status: 400,
      error: 'Invalid JSON body',
      code: 'INVALID_JSON',
    };
  }
};

// PUT /api/users - Bulk update not supported
export const PUT = async () => {
  return {
    status: 405,
    error: 'Use PUT /api/users/:id to update a specific user',
    hint: 'This endpoint does not support bulk updates',
  };
};

// DELETE /api/users - Bulk delete not supported
export const DELETE = async () => {
  return {
    status: 405,
    error: 'Use DELETE /api/users/:id to delete a specific user',
    hint: 'Bulk delete is not supported for safety',
  };
};
