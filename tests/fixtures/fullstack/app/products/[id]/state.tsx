'use client';
import { useState } from 'react';
export default function ProductState() {
  const [count, setCount] = useState(0);
  return <button id="product-count" onClick={() => setCount(value => value + 1)}>Product count: {count}</button>;
}
