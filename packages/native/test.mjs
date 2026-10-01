import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { buildNative } from "../client/src/native/build.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/addon");
const built = await buildNative(fixture, {
  release: process.env.ZAP_NATIVE_RELEASE === "1",
});
assert.ok(built);
const native = await import(pathToFileURL(built.loaderPath).href);

test("real addon exchanges typed records, optional fields, buffers, bigint, and errors", async () => {
  assert.deepEqual(
    await native.summarize([1, 2, 3], {
      requestId: "req-7",
      authorization: "test",
    }),
    {
      sum: 6,
      count: 3,
      requestId: "req-7",
      authenticated: true,
    },
  );
  assert.equal(
    (await native.summarize([], { requestId: "anonymous" })).authenticated,
    false,
  );
  await assert.rejects(
    native.summarize([Infinity], { requestId: "invalid" }),
    /finite/,
  );
  const input = Buffer.from([1, 2, 3]);
  const pending = native.reverseBytes(input);
  input.fill(99); // Work must see the snapshot taken on the JS thread.
  assert.deepEqual(await pending, Buffer.from([3, 2, 1]));
  assert.equal(
    native.exactInteger(900719925474099312345n),
    900719925474099312345n,
  );
  assert.throws(() => native.exactInteger("not a bigint"), /BigInt|bigint/);
});

test("heavy work leaves JS responsive and overload is bounded", async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => new native.Work(2000).run(100)),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      2,
    );
    assert.ok(
      results
        .filter((result) => result.status === "rejected")
        .every((result) => /ZAP_NATIVE_OVERLOADED/.test(result.reason.message)),
    );
    assert.ok(
      ticks >= 2,
      "JavaScript event loop must continue while native work runs",
    );
  } finally {
    clearInterval(timer);
  }
});

test("explicit cancellation and deadlines reject promises and release capacity", async () => {
  const work = new native.Work(1000);
  const pending = work.run(500);
  setTimeout(() => work.cancel(), 20);
  await assert.rejects(pending, /ZAP_NATIVE_CANCELLED/);
  await assert.rejects(new native.Work(10).run(100), /ZAP_NATIVE_DEADLINE/);
  assert.equal(await new native.Work(1000).run(1), 1);
});

test("Rust-generated declarations typecheck zap:native without a parallel schema", async () => {
  const declarations = await readFile(built.bindingsPath, "utf8");
  assert.match(declarations, /reverseBytes\(input: Buffer\): Promise<Buffer>/);
  assert.match(declarations, /exactInteger\(value: bigint\): bigint/);
  const source = join(fixture, ".zap/types/check.ts");
  await writeFile(
    source,
    `import { summarize, exactInteger, reverseBytes, Work } from 'zap:native';
const result: Promise<{sum:number,count:number,requestId:string,authenticated:boolean}> = summarize([1], {requestId:'x'});
const bytes: Promise<Buffer> = reverseBytes(Buffer.alloc(1));
const exact: bigint = exactInteger(10n);
const task: Promise<number> = new Work(100).run(1);
// @ts-expect-error wrong native parameter type must be rejected
summarize(['wrong'], {requestId:'x'});
// @ts-expect-error BigInt precision boundary is explicit
exactInteger(9007199254740991);
`,
  );
  const program = ts.createProgram([source, built.ambientPath], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ["node"],
    skipLibCheck: false,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((item) =>
      ts.flattenDiagnosticMessageText(item.messageText, "\n"),
    ),
    [],
  );
});

test("JS-only apps need no Rust, incomplete native projects and unsupported targets fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-native-build-"));
  try {
    assert.equal(await buildNative(root), null);
    await mkdir(join(root, "native"));
    await assert.rejects(buildNative(root), /without Cargo.toml/);
    await assert.rejects(
      buildNative(fixture, { target: "wasm32-wasip1" }),
      /edge isolates/,
    );
    await assert.rejects(
      buildNative(fixture, {
        target: built.target.includes("darwin")
          ? "x86_64-unknown-linux-gnu"
          : "aarch64-apple-darwin",
      }),
      /differs from this build host/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
