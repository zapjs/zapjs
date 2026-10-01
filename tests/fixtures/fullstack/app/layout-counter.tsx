'use client';
import { useState } from 'react';
import { usePathname, useRouter } from '@zap-js/client';
export default function LayoutCounter() {
  const [count, setCount] = useState(0);
  const pathname = usePathname();
  const { pending } = useRouter();
  return <><button id="layout-count" onClick={() => setCount(value => value + 1)}>Layout count: {count}</button><span id="current-path">{pathname}</span><span id="navigation-pending">{pending ? 'Navigating' : 'Ready'}</span></>;
}
