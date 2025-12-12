// Request echo endpoint - calls Rust backend via RPC
import { rpc } from '@zap-js/server';

interface ZapRequest {
  method: string;
  path: string;
  path_only: string;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  cookies: Record<string, string>;
}

// Filter sensitive headers before sending to backend
function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const sensitiveHeaders = ['authorization', 'cookie', 'set-cookie'];
  const safeHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (!sensitiveHeaders.includes(key.toLowerCase())) {
      safeHeaders[key] = value;
    }
  }

  return safeHeaders;
}

// Parse body safely
function parseBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

// GET /api/echo - Echo GET request details
export const GET = async (req: ZapRequest) => {
  return await rpc.call('echo_request', {
    method: 'GET',
    url: req.path_only,
    query: req.query,
    headers: filterHeaders(req.headers),
    body: null,
  });
};

// POST /api/echo - Echo POST request with body
export const POST = async (req: ZapRequest) => {
  return await rpc.call('echo_request', {
    method: 'POST',
    url: req.path_only,
    query: req.query,
    headers: filterHeaders(req.headers),
    body: parseBody(req.body),
  });
};

// PUT /api/echo - Echo PUT request with body
export const PUT = async (req: ZapRequest) => {
  return await rpc.call('echo_request', {
    method: 'PUT',
    url: req.path_only,
    query: req.query,
    headers: filterHeaders(req.headers),
    body: parseBody(req.body),
  });
};

// DELETE /api/echo - Echo DELETE request
export const DELETE = async (req: ZapRequest) => {
  return await rpc.call('echo_request', {
    method: 'DELETE',
    url: req.path_only,
    query: req.query,
    headers: filterHeaders(req.headers),
    body: null,
  });
};
