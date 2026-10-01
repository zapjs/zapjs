import { summarize } from 'zap:native';
export async function GET(request:Request) {
  try {
    const values=new URL(request.url).searchParams.has('fail') ? [Infinity] : [19,23];
    const result=await summarize(values, {requestId:request.headers.get('x-request-id') ?? 'none', authorization:request.headers.get('authorization') ?? undefined});
    return Response.json(result);
  } catch(error) { return Response.json({error:(error as Error).message}, {status:422}); }
}
