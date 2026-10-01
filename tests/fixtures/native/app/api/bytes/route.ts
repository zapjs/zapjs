import { reverseBytes } from 'zap:native';
export async function POST(request:Request) { const result=await reverseBytes(Buffer.from(await request.arrayBuffer())); return new Response(result,{headers:{'content-type':'application/octet-stream'}}); }
