import ProductState from './state';
import { headers } from '@zap-js/client/server';
export default function Product({ params }: { params: { id: string } }) { return <article><h1>Product {params.id}</h1><ProductState /><p id="request-marker">{headers().get('x-test-request') ?? 'browser'}</p></article>; }
