#!/usr/bin/env python3
"""Run the ZapJS live-browser navigation/action matrix with Aegis.

This creates a temporary React-shaped fixture with local package-export stubs,
builds and serves it through the Rust ZapJS CLI, drives the page through Aegis,
and writes a JSON evidence report. No JavaScript runtime or package manager is
invoked by this runner; React packages are source inputs for Zap's Rust bundler.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
AEGIS = Path(os.environ.get("AEGIS", "/Users/deepsaint/.local/bin/aegis"))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_react_package_stubs(root: Path) -> None:
    write(root / "node_modules/react/package.json", '{"name":"react","exports":{"./jsx-runtime":{"react-server":"./jsx-runtime.react-server.js","browser":"./jsx-runtime.browser.js","default":"./jsx-runtime.default.js"}}}')
    jsx_runtime = "export function jsx(type, props){ return { type, props: props || {} }; }\nexport const jsxs = jsx; export const Fragment = Symbol.for('react.fragment');\n"
    write(root / "node_modules/react/jsx-runtime.default.js", jsx_runtime)
    write(root / "node_modules/react/jsx-runtime.browser.js", jsx_runtime)
    write(root / "node_modules/react/jsx-runtime.react-server.js", jsx_runtime)

    write(root / "node_modules/react-dom/package.json", '{"name":"react-dom","exports":{"./server.browser":{"browser":"./server.browser.js","default":"./server.default.js"},"./client":{"browser":"./client.browser.js","default":"./client.default.js"}}}')
    server = r"""
function renderTree(tree){
  if (tree == null || tree === false || tree === true) return '';
  if (typeof tree === 'string' || typeof tree === 'number' || typeof tree === 'bigint') return String(tree);
  if (Array.isArray(tree)) return tree.map(renderTree).join('');
  if (typeof tree.type === 'function') return renderTree(tree.type(tree.props || {}));
  const props = tree.props || {};
  const attrs = Object.entries(props)
    .filter(([k]) => k !== 'children')
    .map(([k,v]) => ` ${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}="${String(v)}"`)
    .join('');
  return `<${tree.type}${attrs}>${renderTree(props.children)}</${tree.type}>`;
}
export async function renderToReadableStream(tree){ return new Response(renderTree(tree)).body; }
""".lstrip()
    write(root / "node_modules/react-dom/server.browser.js", server)
    write(root / "node_modules/react-dom/server.default.js", server)
    write(root / "node_modules/react-dom/client.default.js", "export function hydrateRoot(){ return { unmount(){} }; }\n")
    write(root / "node_modules/react-dom/client.browser.js", "export function hydrateRoot(container, model){ globalThis.__zap_hydrate_count = (globalThis.__zap_hydrate_count || 0) + 1; container.__zapHydratedModel = model; return { unmount(){} }; }\n")

    write(root / "node_modules/react-server-dom-webpack/package.json", '{"name":"react-server-dom-webpack","exports":{"./server.edge":"./server.edge.js","./client.edge":"./client.edge.js"}}')
    write(root / "node_modules/react-server-dom-webpack/client.edge.js", "export async function createFromReadableStream(stream){ const text = await new Response(stream).text(); return { type: 'flight-model', text }; }\n")
    write(root / "node_modules/react-server-dom-webpack/server.edge.js", r"""
const CLIENT_REFERENCE = Symbol.for('react.client.reference');
function isClientReference(value){ return value && value.$$typeof === CLIENT_REFERENCE; }
function renderTree(tree){
  if (tree == null || tree === false || tree === true) return '';
  if (typeof tree === 'string' || typeof tree === 'number' || typeof tree === 'bigint') return String(tree);
  if (Array.isArray(tree)) return tree.map(renderTree).join('');
  if (isClientReference(tree.type)) return `<client-reference id="${tree.type.$$id}">${renderTree((tree.props || {}).children)}</client-reference>`;
  if (typeof tree.type === 'function') return renderTree(tree.type(tree.props || {}));
  const props = tree.props || {};
  const attrs = Object.entries(props)
    .filter(([k]) => k !== 'children')
    .map(([k,v]) => ` ${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}="${String(v)}"`)
    .join('');
  return `<${tree.type}${attrs}>${renderTree(props.children)}</${tree.type}>`;
}
export async function renderToReadableStream(tree, metadata){ const prefix = Object.keys(metadata && metadata.clientReferences || {}).join(','); return new Response(`RSC:${prefix}:${renderTree(tree)}`).body; }
export function createClientModuleProxy(id){ return new Proxy({}, { get(_target, prop){ return { $$typeof: CLIENT_REFERENCE, $$id: `${id}#${String(prop)}` }; } }); }
""".lstrip())



def create_matrix_fixture(root: Path) -> None:
    write_react_package_stubs(root)
    write(root / "app/actions.ts", "'use server';\nexport async function save(input){ return new Response(`saved:${input.label}:${input.value}`, { status: 201, headers: { 'x-zap-action': 'save' } }); }\n")
    write(root / "app/client.tsx", r"""
'use client';
async function call(actions, label, value, selector){
  const el = document.querySelector(selector);
  const res = await actions.invokeAction('action:actions#save', [{ label, value }], { throwOnError: false });
  el.textContent = await res.text();
}
export const RootButton = { hydrate({ actions }) { const el = document.querySelector('[data-root-action]'); if (el) el.addEventListener('click', () => call(actions, 'root', el.dataset.rootAction, '[data-root-action]')); } };
export const ShopButton = { hydrate({ actions }) { const el = document.querySelector('[data-shop-action]'); if (el) el.addEventListener('click', () => call(actions, 'shop', el.dataset.shopAction, '[data-shop-action]')); } };
export const ProductButton = { hydrate({ actions }) { const el = document.querySelector('[data-product-action]'); if (el) el.addEventListener('click', () => call(actions, 'product', el.dataset.productAction, '[data-product-action]')); } };
""".lstrip())
    write(root / "app/layout.tsx", "import { RootButton } from './client';\nexport default function RootLayout({ children }){ return <section data-layout=\"root\"><button data-root-action=\"10\"><RootButton />root</button><a id=\"to-shop\" href=\"/shop/cafe?color=blue\">shop</a><a id=\"to-docs\" href=\"/docs/a/b/c?view=full\">docs</a><a id=\"to-broken\" href=\"/broken\">broken</a><span data-zap-pending>idle</span><span data-zap-error>ok</span>{children}</section>; }\n")
    write(root / "app/page.tsx", "export default function Page({ request }){ return <main data-page=\"home\">home:{request.path}</main>; }\n")
    write(root / "app/shop/layout.tsx", "import { ShopButton } from '../client';\nexport default function ShopLayout({ children }){ return <article data-layout=\"shop\"><button data-shop-action=\"20\"><ShopButton />shop</button>{children}</article>; }\n")
    write(root / "app/shop/[id]/page.tsx", "import { ProductButton } from '../../client';\nexport default function Product({ params, searchParams }){ return <main data-page=\"product\"><h1>Product {params.id}</h1><p data-color={searchParams.color}>Color {searchParams.color}</p><button data-product-action=\"30\"><ProductButton />product</button></main>; }\n")
    write(root / "app/docs/[...slug]/page.tsx", "export default function Docs({ params, searchParams }){ return <main data-page=\"docs\">docs:{params.slug.join('/')}:view:{searchParams.view}</main>; }\n")
    write(root / "app/broken/page.tsx", "export default function Broken(){ throw new Error('matrix broken route'); }\n")
    write(root / "public/matrix.txt", "zap-aegis-matrix")



def create_commerce_fixture(root: Path) -> None:
    write_react_package_stubs(root)
    write(root / "app/actions.ts", "'use server';\nexport async function addCart(input){ return new Response(`cart:${input.sku}:${input.qty}`, { status: 202, headers: { 'x-zap-action': 'cart' } }); }\nexport async function remember(input){ return `remember:${input.label}:${input.value}`; }\n")
    write(root / "app/client.tsx", r"""
'use client';
async function callResponse(actions, actionId, payload, selector){
  const el = document.querySelector(selector);
  const res = await actions.invokeAction(actionId, [payload], { throwOnError: false });
  el.textContent = await res.text();
}
async function callText(actions, actionId, payload, selector){
  const el = document.querySelector(selector);
  const value = await actions.invokeAction(actionId, [payload], { throwOnError: false });
  el.textContent = value && typeof value.text === 'function' ? await value.text() : String(value);
}
export const ShellAction = { hydrate({ actions }) { const el = document.querySelector('[data-shell-action]'); if (el) el.addEventListener('click', () => callText(actions, 'action:actions#remember', { label: 'shell', value: el.dataset.shellAction }, '[data-shell-action]')); } };
export const ProductAction = { hydrate({ actions }) { const el = document.querySelector('[data-product-action]'); if (el) el.addEventListener('click', () => callResponse(actions, 'action:actions#addCart', { sku: el.dataset.productAction, qty: 2 }, '[data-product-action]')); } };
export const FilesAction = { hydrate({ actions }) { const el = document.querySelector('[data-files-action]'); if (el) el.addEventListener('click', () => callText(actions, 'action:actions#remember', { label: 'files', value: el.dataset.filesAction }, '[data-files-action]')); } };
""".lstrip())
    write(root / "app/layout.tsx", "import { ShellAction } from './client';\nexport default function RootLayout({ children }){ return <section data-layout=\"root-shell\"><nav><a id=\"to-dashboard\" href=\"/dashboard\">dashboard</a><a id=\"to-product\" href=\"/products/books/abc?ref=nav&tag=one&tag=two\">product</a><a id=\"to-files-root\" href=\"/files?mode=root\">files-root</a><a id=\"to-files-deep\" href=\"/files/a/b?mode=deep\">files-deep</a></nav><button data-shell-action=\"ready\"><ShellAction />shell</button><span data-zap-pending>idle</span><span data-zap-error>ok</span>{children}</section>; }\n")
    write(root / "app/(marketing)/page.tsx", "export const revalidate = 30;\nexport default function Marketing(){ return <main data-page=\"marketing\">marketing-home</main>; }\n")
    write(root / "app/dashboard/layout.tsx", "export default function DashboardLayout({ children }){ return <article data-layout=\"dashboard\"><h1>dash-layout</h1>{children}</article>; }\n")
    write(root / "app/dashboard/page.tsx", "export default function Dashboard({ request }){ return <main data-page=\"dashboard\">dashboard:{request.path}</main>; }\n")
    write(root / "app/products/[category]/[id]/page.tsx", "import { ProductAction } from '../../../client';\nexport default function Product({ params, searchParams }){ const tag = Array.isArray(searchParams.tag) ? searchParams.tag.join('|') : searchParams.tag; return <main data-page=\"product\"><h1>{params.category}:{params.id}</h1><p data-ref={searchParams.ref}>ref:{searchParams.ref}</p><p data-tags={tag}>tags:{tag}</p><button data-product-action={params.id}><ProductAction />cart</button></main>; }\n")
    write(root / "app/files/[[...path]]/page.tsx", "import { FilesAction } from '../../client';\nexport default function Files({ params, searchParams }){ const path = params.path.length ? params.path.join('/') : '(root)'; return <main data-page=\"files\">files:{path}:mode:{searchParams.mode}<button data-files-action={path}><FilesAction />files</button></main>; }\n")
    write(root / "app/api/status/route.ts", "export function GET(request){ return new Response(`status:${request.method}:${request.path}:${request.searchParams.check}`, { status: 200, headers: { 'x-zap-status': 'ok' } }); }\n")
    write(root / "app/api/cart/route.ts", "export async function POST(request){ const body = await request.text(); return new Response(`api-cart:${request.method}:${body}`, { status: 201, headers: { 'x-zap-cart': 'ok' } }); }\n")
    write(root / "public/shape.txt", "zap-commerce-shape")


def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(cmd, text=True, capture_output=True, **kwargs)
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return result


def api(addr: str, method: str, path: str, body: Any | None = None) -> Any:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://{addr}{path}", data=data, method=method)
    if body is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
    if not raw:
        return None
    return json.loads(raw)


def execute(addr: str, code: str) -> Any:
    return api(addr, "POST", "/execute", {"commands": [{"type": "eval", "code": code}]})


def report_ok(report: Any) -> bool:
    return isinstance(report, dict) and all(result.get("ok") is True for result in report.get("results", []))


def assert_eval(addr: str, code: str, label: str) -> Any:
    report = execute(addr, code)
    if not report_ok(report):
        raise AssertionError(f"{label} failed: {json.dumps(report, indent=2)}")
    return report


def wait_eval(addr: str, code: str, label: str, timeout: float = 8.0) -> Any:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = execute(addr, code)
        if report_ok(last):
            return last
        time.sleep(0.2)
    raise AssertionError(f"{label} did not pass before timeout. Last report: {json.dumps(last, indent=2)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=None, help="report path; defaults to the selected profile's latest report")
    parser.add_argument(
        "--profile",
        choices=["smoke", "soak", "commerce"],
        default="smoke",
        help="smoke runs a quick matrix; soak runs a longer matrix; commerce runs a broader app-shape matrix",
    )
    parser.add_argument("--cycles", type=int, default=None, help="navigation/action cycles to run before the final profile-specific assertion")
    parser.add_argument("--keep-temp", action="store_true")
    args = parser.parse_args()
    if args.cycles is None:
        args.cycles = {"smoke": 3, "soak": 50, "commerce": 6}[args.profile]
    if args.cycles < 1:
        raise SystemExit("--cycles must be at least 1")
    if args.out is None:
        args.out = {
            "smoke": "artifacts/verification/aegis-matrix-latest.json",
            "soak": "artifacts/verification/aegis-soak-latest.json",
            "commerce": "artifacts/verification/aegis-commerce-latest.json",
        }[args.profile]

    if not AEGIS.exists():
        raise SystemExit(f"Aegis CLI not found at {AEGIS}")

    work = Path(tempfile.mkdtemp(prefix="zapjs-aegis-matrix-"))
    started_at = time.time()
    zap_proc: subprocess.Popen[str] | None = None
    aegis_pid: int | None = None
    try:
        if args.profile == "commerce":
            create_commerce_fixture(work)
        else:
            create_matrix_fixture(work)
        cargo = os.environ.get("CARGO", "cargo")
        run([cargo, "+1.96.0", "run", "--quiet", "-p", "zap-cli", "--", "build", "--root", str(work), "--no-minify"], cwd=ROOT)

        zap_port = free_port()
        zap_proc = subprocess.Popen(
            [cargo, "+1.96.0", "run", "--quiet", "-p", "zap-cli", "--", "serve", "--root", str(work), "--addr", f"127.0.0.1:{zap_port}"],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert zap_proc.stdout is not None
        line = zap_proc.stdout.readline().strip()
        if not line.startswith("listening=http://"):
            raise RuntimeError(f"zap serve did not print listening address: {line}")
        serve_url = line.removeprefix("listening=")

        aegis_port = free_port()
        aegis_addr = f"127.0.0.1:{aegis_port}"
        log_path = Path(tempfile.gettempdir()) / f"zapjs-aegis-{aegis_port}.log"
        detach = run([str(AEGIS), "--mode", "headless", "serve", "--detach", "--addr", aegis_addr, "--log-path", str(log_path)])
        detach_json = json.loads(detach.stdout)
        aegis_pid = int(detach_json.get("pid", 0)) or None

        api(aegis_addr, "POST", "/navigate", {"url": serve_url})
        if args.profile == "commerce":
            wait_eval(aegis_addr, "if (!document.body.innerText.includes('marketing-home')) throw new Error(document.body.innerText);", "commerce home loaded")
            assert_eval(aegis_addr, "window.__zap_states=[]; document.addEventListener('zap:navigation-state', e => window.__zap_states.push(e.detail)); '__ZAP_ASSERT_OK__';", "commerce install navigation listener")
            wait_eval(aegis_addr, "if (!(globalThis.__zap_hydrate_count >= 1)) throw new Error(String(globalThis.__zap_hydrate_count));", "commerce initial hydrate")
            assert_eval(aegis_addr, "document.querySelector('[data-shell-action]').click(); '__ZAP_ASSERT_OK__';", "commerce click shell action")
            wait_eval(aegis_addr, "if (!document.body.innerText.includes('remember:shell:ready')) throw new Error(document.body.innerText);", "commerce shell action response")
            for cycle in range(1, args.cycles + 1):
                assert_eval(aegis_addr, "document.querySelector('#to-dashboard').click();", f"commerce cycle {cycle}: click dashboard")
                wait_eval(aegis_addr, "if (!(location.pathname === '/dashboard' && document.body.innerText.includes('dash-layout') && document.body.innerText.includes('dashboard:/dashboard'))) throw new Error(location.href + ' :: ' + document.body.innerText);", f"commerce cycle {cycle}: dashboard route")
                assert_eval(aegis_addr, "document.querySelector('#to-product').click();", f"commerce cycle {cycle}: click product")
                wait_eval(aegis_addr, "if (!(location.pathname === '/products/books/abc' && document.body.innerText.includes('books:abc') && document.body.innerText.includes('ref:nav') && document.body.innerText.includes('tags:one|two'))) throw new Error(location.href + ' :: ' + document.body.innerText);", f"commerce cycle {cycle}: product route")
                wait_eval(aegis_addr, "document.querySelector('[data-product-action]').click(); if (!document.body.innerText.includes('cart:abc:2')) throw new Error(document.body.innerText);", f"commerce cycle {cycle}: product action response")
                assert_eval(aegis_addr, "document.querySelector('#to-files-root').click();", f"commerce cycle {cycle}: click files root")
                wait_eval(aegis_addr, "if (!(location.pathname === '/files' && document.body.innerText.includes('files:(root):mode:root'))) throw new Error(location.href + ' :: ' + document.body.innerText);", f"commerce cycle {cycle}: files root route")
                wait_eval(aegis_addr, "document.querySelector('[data-files-action]').click(); if (!document.body.innerText.includes('remember:files:(root)')) throw new Error(document.body.innerText);", f"commerce cycle {cycle}: files root action response")
                assert_eval(aegis_addr, "document.querySelector('#to-files-deep').click();", f"commerce cycle {cycle}: click files deep")
                wait_eval(aegis_addr, "if (!(location.pathname === '/files/a/b' && document.body.innerText.includes('files:a/b:mode:deep'))) throw new Error(location.href + ' :: ' + document.body.innerText);", f"commerce cycle {cycle}: files deep route")
            assert_eval(aegis_addr, "fetch('/api/status?check=browser').then(async r => { window.__zap_status = [r.status, r.headers.get('x-zap-status'), await r.text()]; }); '__ZAP_ASSERT_OK__';", "commerce fetch status route")
            wait_eval(aegis_addr, "if (!(window.__zap_status && window.__zap_status[0] === 200 && window.__zap_status[1] === 'ok' && window.__zap_status[2].includes('status:GET:/api/status:browser'))) throw new Error(JSON.stringify(window.__zap_status));", "commerce status route response")
            assert_eval(aegis_addr, "fetch('/api/cart', { method: 'POST', body: 'sku=abc' }).then(async r => { window.__zap_cart = [r.status, r.headers.get('x-zap-cart'), await r.text()]; }); '__ZAP_ASSERT_OK__';", "commerce fetch cart route")
            wait_eval(aegis_addr, "if (!(window.__zap_cart && window.__zap_cart[0] === 201 && window.__zap_cart[1] === 'ok' && window.__zap_cart[2].includes('api-cart:POST:sku=abc'))) throw new Error(JSON.stringify(window.__zap_cart));", "commerce cart route response")
            assert_eval(aegis_addr, "fetch('/shape.txt').then(async r => { window.__zap_asset = [r.status, await r.text()]; }); '__ZAP_ASSERT_OK__';", "commerce fetch public asset")
            wait_eval(aegis_addr, "if (!(window.__zap_asset && window.__zap_asset[0] === 200 && window.__zap_asset[1] === 'zap-commerce-shape')) throw new Error(JSON.stringify(window.__zap_asset));", "commerce public asset response")
        else:
            wait_eval(aegis_addr, "if (!document.body.innerText.includes('home:/')) throw new Error(document.body.innerText);", "home page loaded")
            assert_eval(aegis_addr, "window.__zap_states=[]; document.addEventListener('zap:navigation-state', e => window.__zap_states.push(e.detail)); '__ZAP_ASSERT_OK__';", "install navigation listener")
            wait_eval(aegis_addr, "if (!(globalThis.__zap_hydrate_count >= 1)) throw new Error(String(globalThis.__zap_hydrate_count));", "initial hydrate")

            assert_eval(aegis_addr, "document.querySelector('[data-root-action]').click(); '__ZAP_ASSERT_OK__';", "click root action")
            wait_eval(aegis_addr, "if (!document.body.innerText.includes('saved:root:10')) throw new Error(document.body.innerText);", "root action response")

            for cycle in range(1, args.cycles + 1):
                assert_eval(aegis_addr, "document.querySelector('#to-shop').click();", f"cycle {cycle}: click shop link")
                wait_eval(aegis_addr, "if (!(location.pathname === '/shop/cafe' && document.body.innerText.includes('Product cafe') && document.body.innerText.includes('Color blue'))) throw new Error(location.href + ' :: ' + document.body.innerText);", f"cycle {cycle}: shop navigation")
                wait_eval(aegis_addr, "if (!(document.querySelector('[data-shop-action]') && document.querySelector('[data-product-action]'))) throw new Error(document.body.innerHTML);", f"cycle {cycle}: shop hydrated controls present")
                assert_eval(aegis_addr, "document.querySelector('[data-shop-action]').click(); document.querySelector('[data-product-action]').click();", f"cycle {cycle}: click nested actions")
                wait_eval(aegis_addr, "if (!(document.body.innerText.includes('saved:shop:20') && document.body.innerText.includes('saved:product:30'))) throw new Error(document.body.innerText);", f"cycle {cycle}: nested action responses")

                assert_eval(aegis_addr, "document.querySelector('#to-docs').click();", f"cycle {cycle}: click docs link")
                wait_eval(aegis_addr, "if (!(location.pathname === '/docs/a/b/c' && document.body.innerText.includes('docs:a/b/c:view:full'))) throw new Error(location.href + ' :: ' + document.body.innerText);", f"cycle {cycle}: docs catch-all navigation")

            assert_eval(aegis_addr, "document.querySelector('#to-broken').click();", "click broken link")
            wait_eval(aegis_addr, "if (!(window.__zap_states || []).some(s => s && s.state === 'error')) throw new Error(JSON.stringify(window.__zap_states || []));", "error navigation state")

        snapshot = api(aegis_addr, "GET", "/page")
        events = api(aegis_addr, "GET", "/events")
        elapsed_seconds = round(time.time() - started_at, 3)
        report = {
            "schema": "zap.aegis_matrix.v1",
            "ok": True,
            "date": time.strftime("%Y-%m-%d"),
            "profile": args.profile,
            "fixture_root": str(work),
            "serve_url": serve_url,
            "cycles": args.cycles,
            "elapsed_seconds": elapsed_seconds,
            "cycles_per_second": round(args.cycles / elapsed_seconds, 3) if elapsed_seconds > 0 else None,
            "aegis": detach_json,
            "validated": (
                [
                    "Rust zap build emitted a React graph fixture without invoking a JavaScript runtime",
                    "Aegis loaded the app through zap serve",
                    "initial page hydration ran through the generated hydrateRoot bundle",
                    "browser action proxy posted a root action to /_zap/action and rendered the response",
                    f"same-origin navigation reached a nested dynamic route with decoded query data across {args.cycles} cycle(s)",
                    f"layout and page client references hydrated after navigation and invoked server actions across {args.cycles} cycle(s)",
                    f"catch-all navigation rendered decoded params and query data across {args.cycles} cycle(s)",
                    "failed navigation emitted an error navigation state through the Rust-generated bootstrap",
                ]
                if args.profile != "commerce"
                else [
                    "Rust zap build emitted a broader commerce app-shape fixture without invoking a JavaScript runtime",
                    "Aegis loaded the commerce app through zap serve",
                    "route-group home page rendered at the root URL",
                    "root, dashboard, product and files layouts hydrated through generated hydrateRoot bundles",
                    f"same-origin navigation crossed dashboard, dynamic product, optional catch-all root and optional catch-all nested routes across {args.cycles} cycle(s)",
                    f"browser action proxy invoked string-returning and Response-returning server actions across {args.cycles} cycle(s)",
                    "browser fetch reached GET and POST route handlers through Rust admission and generated Web Request adapters",
                    "browser fetch served a public static asset through the Rust artifact executor",
                ]
            ),
            "page_snapshot": snapshot,
            "events_count": len(events) if isinstance(events, list) else None,
        }
        out = ROOT / args.out
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps({"ok": True, "report": str(out), "serve_url": serve_url}, indent=2))
        return 0
    finally:
        if zap_proc is not None:
            zap_proc.kill()
            try:
                zap_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if aegis_pid is not None:
            try:
                subprocess.run(["kill", str(aegis_pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            except Exception:
                pass
        if not args.keep_temp:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
