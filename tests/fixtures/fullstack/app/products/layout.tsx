import type { ReactNode } from 'react';
export default function Layout({ children }: { children: ReactNode }) { return <section id="products-layout"><h2>Product catalog</h2>{children}</section>; }
