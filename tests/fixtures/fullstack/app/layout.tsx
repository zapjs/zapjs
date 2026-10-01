import BrowserProbe from './browser-probe';
import type { ReactNode } from 'react';
import { Link } from '@zap-js/client';
import './style.css';
import LayoutCounter from './layout-counter';
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><head><title>Zap production verification</title></head><body><header>ZapJS application <LayoutCounter /></header><nav><Link href="/">Home</Link> <Link href="/products/42">Product 42</Link> <Link href="/products/43">Product 43</Link> <Link href="/broken">Error boundary</Link></nav>{children}<BrowserProbe /></body></html>;
}
