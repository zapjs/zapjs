'use client';
import { useEffect, useState } from 'react';

// This module belongs only to the acceptance fixture, never the framework runtime.
// It drives visible DOM controls; it does not call internal router/action methods.
export default function BrowserProbe() {
  const [result, setResult] = useState('Browser verification idle');
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('__verify')) return;
    let active = true;
    const checks: string[] = [];
    const text = (selector: string) => document.querySelector(selector)?.textContent ?? '';
    const wait = async (description: string, condition: () => boolean) => {
      const deadline = Date.now() + 15000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`${description}: timed out at ${location.pathname}`);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      checks.push(description);
      if (active) setResult(JSON.stringify({ status: 'running', checks }));
    };
    const click = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing control ${selector}`);
      element.click();
    };
    async function run() {
      await wait('streamed RSC reached browser', () => text('#streamed').includes('complete'));
      click('#counter');
      await wait('client component hydrated', () => text('#counter') === 'Count: 1');
      click('#layout-count');
      await wait('shared layout state changed', () => text('#layout-count') === 'Layout count: 1');
      click('a[href="/products/42"]');
      await wait('client navigation reached nested dynamic route', () => text('#current-path') === '/products/42');
      if (text('#layout-count') !== 'Layout count: 1') throw new Error('Shared layout remounted on navigation');
      click('#product-count');
      await wait('dynamic page state changed', () => text('#product-count').includes('1'));
      click('a[href="/products/43"]');
      await wait('dynamic sibling navigation', () => text('#current-path') === '/products/43');
      await wait('dynamic segment state resets', () => text('#product-count').includes('0'));
      history.back();
      await wait('browser history restores route', () => text('#current-path') === '/products/42');
      click('a[href="/"]');
      await wait('home navigation', () => text('#current-path') === '/' && !!document.querySelector('#save'));
      click('#save');
      await wait('server action updates hydrated form', () => text('#saved') === 'Saved Ada');
      const echo = await (await fetch('/api/echo')).json();
      if (echo.name !== 'Ada' || document.cookie.includes('zap-name=')) throw new Error('Action cookie missing or HttpOnly leaked');
      checks.push('server action sets private HttpOnly cookie');
      click('a[href="/broken"]');
      await wait('route error boundary renders', () => document.body.textContent?.includes('Handled page error') ?? false);
      click('a[href="/"]');
      await wait('navigation recovers from route error', () => text('#current-path') === '/' && !!document.querySelector('#counter'));
      if (text('#layout-count') !== 'Layout count: 1') throw new Error('Shared layout state lost');
      checks.push('shared layout retained through mutations and errors');
      if (active) setResult(JSON.stringify({ status: 'passed', checks }));
    }
    void run().catch(error => { if (active) setResult(JSON.stringify({ status: 'failed', message: String(error), checks })); });
    return () => { active = false; };
  }, []);
  return <pre id="browser-results" aria-live="polite">{result}</pre>;
}
