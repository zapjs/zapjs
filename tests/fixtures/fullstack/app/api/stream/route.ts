export function GET(request: Request) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout>;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('first\n'));
      timer = setTimeout(() => { controller.enqueue(encoder.encode('last\n')); controller.close(); }, 120);
    },
    cancel() { clearTimeout(timer); },
  }), { headers: { 'content-type': 'text/plain' } });
}
