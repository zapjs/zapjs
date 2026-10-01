import { summarize } from 'zap:native';
export default async function Page() { const result=await summarize([19,23], {requestId:'server-component'}); return <main><h1>ZapJS managed native proof</h1><p id="native-total">Native total: {result.sum}</p><p id="native-request">{result.requestId}</p></main>; }
