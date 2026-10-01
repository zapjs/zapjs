import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const supportedTargets = new Map([
  ["aarch64-apple-darwin", { platform: "darwin", arch: "arm64", libc: null }],
  ["x86_64-apple-darwin", { platform: "darwin", arch: "x64", libc: null }],
  [
    "aarch64-unknown-linux-gnu",
    { platform: "linux", arch: "arm64", libc: "glibc" },
  ],
  [
    "x86_64-unknown-linux-gnu",
    { platform: "linux", arch: "x64", libc: "glibc" },
  ],
]);

export interface NativeBuildOptions {
  release?: boolean;
  target?: string;
  outDir?: string;
  signal?: AbortSignal;
}

export interface NativeBuild {
  artifactPath: string;
  bindingsPath: string;
  loaderPath: string;
  ambientPath: string;
  target: string;
  napiVersion: 8;
  exports: string[];
  digest: string;
}

/** No Rust compiler or native dependency is loaded for JavaScript-only projects. */
export async function buildNative(
  root: string,
  options: NativeBuildOptions = {},
): Promise<NativeBuild | null> {
  options.signal?.throwIfAborted();
  root = resolve(root);
  const source = join(root, "native");
  const manifestPath = join(source, "Cargo.toml");
  if (!existsSync(manifestPath)) {
    if (existsSync(source)) {
      throw new Error(
        `Native source directory exists without Cargo.toml: ${source}`,
      );
    }
    return null;
  }
  const { stdout: version } = await exec("rustc", ["-vV"], {
    cwd: root,
    signal: options.signal,
  });
  const hostTarget = /^host: (.+)$/m.exec(version)?.[1];
  if (!hostTarget) throw new Error("rustc did not report a host target");
  const target = options.target ?? hostTarget;
  const targetInfo = supportedTargets.get(target);
  if (!targetInfo) {
    throw new Error(
      `Unsupported native target ${target}. Supported Node targets: ${[...supportedTargets.keys()].join(", ")}. Native modules cannot run in edge isolates.`,
    );
  }
  if (
    target !== hostTarget ||
    targetInfo.platform !== process.platform ||
    targetInfo.arch !== process.arch
  ) {
    throw new Error(
      `Native build target ${target} differs from this build host (${hostTarget}, Node ${process.platform}-${process.arch}). Build on the deployment OS/architecture; cross-compilation is not supported yet.`,
    );
  }
  if (
    targetInfo.libc === "glibc" &&
    !(
      process.report?.getReport() as
        | { header?: { glibcVersionRuntime?: string } }
        | undefined
    )?.header?.glibcVersionRuntime
  ) {
    throw new Error("GNU native builds require a Linux glibc build host");
  }
  const { stdout: metadataJson } = await exec(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--manifest-path",
      manifestPath,
    ],
    { cwd: source, maxBuffer: 8 * 1024 * 1024, signal: options.signal },
  );
  const metadata = JSON.parse(metadataJson) as {
    workspace_root: string;
    packages: Array<{
      manifest_path: string;
      name: string;
      targets: Array<{ crate_types: string[] }>;
      dependencies: Array<{ name: string; features: string[] }>;
    }>;
  };
  const crate = metadata.packages.find(
    (item) => resolve(item.manifest_path) === manifestPath,
  );
  if (!crate?.targets.some((item) => item.crate_types.includes("cdylib"))) {
    throw new Error(
      'native/Cargo.toml must declare [lib] crate-type = ["cdylib"]',
    );
  }
  if (
    options.release &&
    !existsSync(join(metadata.workspace_root, "Cargo.lock"))
  ) {
    throw new Error(
      "Release native builds require a committed Cargo.lock. Run a development native build first.",
    );
  }
  const napi = crate.dependencies.find((item) => item.name === "napi");
  if (
    !napi?.features.includes("napi8") ||
    !napi.features.includes("tokio_rt") ||
    napi.features.some((feature) => /^napi(?:9|\d{2,})$/.test(feature))
  ) {
    throw new Error(
      'Native modules must explicitly select napi features ["napi8", "tokio_rt"] and must not require a newer Node-API version',
    );
  }
  const outDir = resolve(options.outDir ?? join(root, ".zap", "native"));
  await mkdir(outDir, { recursive: true });
  // napi-rs derives the declarations and export identifiers from the exact Rust
  // signatures compiled into this artifact; Zap does not infer a parallel schema.
  const { NapiCli } = await import("@napi-rs/cli");
  const build = await new NapiCli().build({
    cwd: source,
    manifestPath,
    packageJsonPath: join(root, "package.json"),
    target,
    targetDir: join(root, ".zap", "native-target"),
    outputDir: outDir,
    platform: true,
    esm: true,
    jsBinding: "bindings.mjs",
    dts: "bindings.d.ts",
    release: options.release ?? false,
    cargoOptions: options.release ? ["--locked"] : [],
  });
  const abort = () => build.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const outputs = await build.task.finally(() =>
    options.signal?.removeEventListener("abort", abort),
  );
  options.signal?.throwIfAborted();
  const artifact = outputs.find((output) => output.kind === "node");
  const declarations = outputs.find((output) => output.kind === "dts");
  const generatedLoader = outputs.find(
    (output) => output.kind === "js" && output.path.endsWith("bindings.mjs"),
  );
  if (!artifact || !declarations || !generatedLoader) {
    throw new Error(
      "Native build did not emit an addon, declarations, and named exports. Export functions with #[napi] and enable napi-derive type generation.",
    );
  }
  const generatedSource = await readFile(generatedLoader.path, "utf8");
  const { parse } = await import("@babel/parser");
  const generatedModule = parse(generatedSource, { sourceType: "module" });
  const names = generatedModule.program.body.flatMap((statement) => {
    if (statement.type !== "ExportNamedDeclaration") return [];
    return statement.specifiers.flatMap((specifier) =>
      specifier.type === "ExportSpecifier" &&
      specifier.exported.type === "Identifier"
        ? [specifier.exported.name]
        : [],
    );
  });
  if (names.length === 0)
    throw new Error("Native module has no generated JavaScript exports");
  const digest = createHash("sha256")
    .update(await readFile(artifact.path))
    .digest("hex");
  const artifactPath = join(outDir, `addon-${digest.slice(0, 16)}.node`);
  if (artifact.path !== artifactPath) await rename(artifact.path, artifactPath);
  const loaderPath = join(outDir, "index.mjs");
  const loader = [
    "// Generated by Zap. This module is server-only and loads in the function process.",
    "import { createRequire } from 'node:module';",
    `if (process.platform !== ${JSON.stringify(targetInfo.platform)} || process.arch !== ${JSON.stringify(targetInfo.arch)}) throw new Error('Native addon target mismatch: expected ${target}');`,
    "if (Number(process.versions.napi ?? 0) < 8) throw new Error('Native addon requires Node-API 8 or newer');",
    ...(targetInfo.libc === "glibc"
      ? [
          "if (!process.report?.getReport().header.glibcVersionRuntime) throw new Error('Native addon requires Linux glibc');",
        ]
      : []),
    `const binding = createRequire(import.meta.url)('./${basename(artifactPath)}');`,
    ...names.map((name) => `export const ${name} = binding.${name};`),
    "",
  ].join("\n");
  await writeFile(loaderPath, loader);
  await rm(generatedLoader.path);
  // Stable declaration path for server source imports such as `zap:native`.
  const bindingsPath = join(outDir, "bindings.d.ts");
  const ambientPath = join(root, ".zap", "types", "native.d.ts");
  await mkdir(dirname(ambientPath), { recursive: true });
  const types = (await readFile(declarations.path, "utf8")).replace(
    /\/\*\*[\s\S]*?\*\/\s*export declare const __napiBindingTarget:[^\n]*\n/,
    "",
  );
  await writeFile(bindingsPath, types);
  await writeFile(join(outDir, "index.d.mts"), types);
  await writeFile(
    ambientPath,
    `// Generated from Rust declarations. Include .zap/types in tsconfig.\ndeclare module 'zap:native' {\n${types.replace(/\bexport declare /g, "export ")}\n}\n`,
  );
  await writeFile(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        target,
        napiVersion: 8,
        digest,
        exports: names,
        artifact: basename(artifactPath),
        loader: "index.mjs",
        bindings: "bindings.d.ts",
      },
      null,
      2,
    ),
  );
  // Only remove previous Zap-owned binaries after the new addon is complete.
  for (const name of await readdir(outDir)) {
    if (
      /^addon-[0-9a-f]{16}\.node$/.test(name) &&
      name !== basename(artifactPath)
    )
      await rm(join(outDir, name));
  }
  return {
    artifactPath,
    bindingsPath,
    loaderPath,
    ambientPath,
    target,
    napiVersion: 8,
    exports: names,
    digest,
  };
}
