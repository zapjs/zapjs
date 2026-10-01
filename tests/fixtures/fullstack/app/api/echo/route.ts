import { cookies, headers } from '@zap-js/client/server';
export function GET(request: Request) {
  return Response.json({ query: new URL(request.url).searchParams.get('q'), marker: headers().get('x-test-request'), name: cookies().get('zap-name') ?? null });
}
export async function POST(request: Request) {
  cookies().set('one', 'first'); cookies().set('two', 'second');
  return new Response(await request.arrayBuffer(), { status: 201, headers: { 'content-type': 'application/octet-stream' } });
}
