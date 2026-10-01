//! React/TSX bundling without a JavaScript tooling process.
//!
//! React packages are source inputs. Compilation, resolution, tree shaking and
//! minification run inside this Rust process through Rolldown and Oxc.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use rolldown::{
    Bundler, BundlerOptions, BundlerTransformOptions, CodeSplittingMode, Either, JsxOptions,
    OutputFormat, Platform, RawMinifyOptions, ResolveOptions,
};

#[derive(Clone, Debug)]
pub enum Target {
    /// Browser ES modules, with hashed lazy chunks when the graph requires them.
    Browser,
    /// A single script containing its dependencies, loaded by the Rust JS host.
    Server { global: String },
}

#[derive(Clone, Debug)]
pub struct BundleOptions {
    pub root: PathBuf,
    pub entry: PathBuf,
    pub output: PathBuf,
    pub target: Target,
    /// Exact module specifiers or prefixes understood by the module resolver.
    pub aliases: Vec<(String, String)>,
    /// Extra package export conditions, e.g. `react-server` for a Flight graph.
    pub conditions: Vec<String>,
    pub minify: bool,
}

impl BundleOptions {
    pub fn new(root: &Path, entry: &Path, output: &Path, target: Target) -> Self {
        Self {
            root: root.to_owned(),
            entry: entry.to_owned(),
            output: output.to_owned(),
            target,
            aliases: Vec::new(),
            conditions: Vec::new(),
            minify: true,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BundleOutput {
    pub files: Vec<PathBuf>,
    pub bytes: usize,
    pub warnings: Vec<String>,
}

/// Compile an entry and its complete dependency graph. Unresolved dependencies
/// fail before any output is written; no unavailable platform modules are externalized as a
/// fallback. Server output is an IIFE with all dynamic imports inlined.
pub async fn bundle(options: &BundleOptions) -> Result<BundleOutput> {
    let root = options.root.canonicalize().context("resolve bundle root")?;
    let entry = absolute(&root, &options.entry);
    let output = absolute(&root, &options.output);
    let directory = output
        .parent()
        .context("bundle output needs a parent directory")?;
    let filename = output
        .file_name()
        .and_then(|v| v.to_str())
        .context("bundle output must have a UTF-8 filename")?;
    let server = matches!(options.target, Target::Server { .. });
    let global = match &options.target {
        Target::Server { global } => {
            if global.is_empty()
                || !global.chars().enumerate().all(|(i, c)| {
                    c == '_' || c == '$' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                })
            {
                bail!("server bundle global must be a JavaScript identifier");
            }
            Some(global.clone())
        }
        Target::Browser => None,
    };
    let mut conditions = options.conditions.clone();
    conditions.extend(["browser".into(), "production".into()]);
    let mut bundler = Bundler::new(BundlerOptions {
        cwd: Some(root),
        input: Some(vec![entry.to_string_lossy().into_owned().into()]),
        dir: Some(directory.to_string_lossy().into_owned()),
        entry_filenames: Some(filename.to_owned().into()),
        chunk_filenames: Some("chunks/[name]-[hash].js".to_owned().into()),
        asset_filenames: Some("assets/[name]-[hash][extname]".to_owned().into()),
        platform: Some(Platform::Browser),
        format: Some(if server {
            OutputFormat::Iife
        } else {
            OutputFormat::Esm
        }),
        name: global,
        code_splitting: Some(CodeSplittingMode::Bool(!server)),
        define: None,
        resolve: Some(ResolveOptions {
            condition_names: Some(conditions),
            alias: Some(
                options
                    .aliases
                    .iter()
                    .map(|(name, path)| (name.clone(), vec![Some(path.clone())]))
                    .collect(),
            ),
            ..Default::default()
        }),
        transform: Some(BundlerTransformOptions {
            target: Some(Either::Left("es2022".into())),
            jsx: Some(Either::Right(JsxOptions {
                runtime: Some("automatic".into()),
                development: Some(false),
                ..Default::default()
            })),
            ..Default::default()
        }),
        minify: Some(RawMinifyOptions::from(options.minify)),
        ..Default::default()
    })
    .map_err(|err| anyhow::anyhow!("configure React bundle: {err}"))?;
    let generated = bundler
        .generate()
        .await
        .map_err(|err| anyhow::anyhow!("compile {}: {err}", entry.display()))?;
    let mut warnings = Vec::new();
    for warning in &generated.warnings {
        let kind = warning.kind().to_string();
        if matches!(
            kind.as_str(),
            "UNRESOLVED_IMPORT"
                | "UNRESOLVED_ENTRY"
                | "MISSING_GLOBAL_NAME"
                | "IMPORT_IS_UNDEFINED"
        ) {
            bail!("bundle cannot depend on unavailable modules: {warning}");
        }
        warnings.push(warning.to_diagnostic().convert_to_string(false));
    }
    let mut files = Vec::new();
    let mut bytes = 0;
    for asset in &generated.assets {
        let path = directory.join(asset.filename());
        let parent = path
            .parent()
            .context("generated asset needs a parent directory")?;
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        std::fs::write(&path, asset.content_as_bytes())
            .with_context(|| format!("write {}", path.display()))?;
        bytes += asset.content_as_bytes().len();
        files.push(path);
    }
    bundler
        .close()
        .await
        .map_err(|err| anyhow::anyhow!("close React bundle: {err}"))?;
    Ok(BundleOutput {
        files,
        bytes,
        warnings,
    })
}

fn absolute(root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    }
}

use zap_runtime::{
    manifest::{
        ActionRef, ApplicationManifest, AssetRef, CachePolicy, CompiledManifest, DynamicPolicy,
        LayoutRef, ModuleKind, ModuleRef, RouteEntry, RouteKind,
    },
    routing::Route,
};

pub type ApplicationGraph = ApplicationManifest;

#[derive(Clone, Debug)]
pub struct GraphOptions {
    pub root: PathBuf,
    pub app_dir: PathBuf,
    pub public_dir: Option<PathBuf>,
    pub out_dir: PathBuf,
}

impl GraphOptions {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
            app_dir: PathBuf::from("app"),
            public_dir: Some(PathBuf::from("public")),
            out_dir: PathBuf::from(".zap"),
        }
    }

    pub fn manifest_path(&self) -> PathBuf {
        self.out_dir.join("manifest.json")
    }
}

#[derive(Clone, Debug)]
pub struct ApplicationBuildOptions {
    pub graph: GraphOptions,
    pub aliases: Vec<(String, String)>,
    pub server_conditions: Vec<String>,
    pub browser_conditions: Vec<String>,
    pub minify: bool,
}

impl ApplicationBuildOptions {
    pub fn new(root: &Path) -> Self {
        Self {
            graph: GraphOptions::new(root),
            aliases: Vec::new(),
            server_conditions: Vec::new(),
            browser_conditions: Vec::new(),
            minify: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BuiltBundleTarget {
    Server,
    Browser,
}

#[derive(Clone, Debug)]
pub struct BuiltBundle {
    pub module: String,
    pub target: BuiltBundleTarget,
    pub output: PathBuf,
    pub files: Vec<PathBuf>,
    pub bytes: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ApplicationBuildOutput {
    pub graph: ApplicationGraph,
    pub manifest: PathBuf,
    pub bundles: Vec<BuiltBundle>,
}

pub async fn build_application(
    options: &ApplicationBuildOptions,
) -> Result<ApplicationBuildOutput> {
    let graph = build_application_graph(&options.graph)?;
    let root = options
        .graph
        .root
        .canonicalize()
        .context("resolve application root")?;
    let app_root = absolute(&root, &options.graph.app_dir);
    let mut bundles = Vec::new();
    let page_modules = graph
        .routes
        .iter()
        .filter(|route| route.kind == RouteKind::Page)
        .map(|route| route.module.clone())
        .collect::<BTreeSet<_>>();
    let handler_methods = graph
        .routes
        .iter()
        .filter(|route| route.kind == RouteKind::Handler)
        .map(|route| (route.module.clone(), route.methods.clone()))
        .collect::<BTreeMap<_, _>>();
    let action_exports = graph.actions.iter().fold(
        BTreeMap::<String, Vec<String>>::new(),
        |mut exports, action| {
            exports
                .entry(action.module.clone())
                .or_default()
                .push(action.export.clone());
            exports
        },
    );

    for module in &graph.modules {
        let source_entry = app_root.join(&module.path);
        if let Some(server_bundle) = &module.server_bundle {
            let (server_entry, global) = if page_modules.contains(&module.id) {
                (
                    write_page_server_entry(&root, &options.graph.out_dir, module, &source_entry)?,
                    "ZapRender".into(),
                )
            } else if let Some(methods) = handler_methods.get(&module.id) {
                (
                    write_route_handler_server_entry(
                        &root,
                        &options.graph.out_dir,
                        module,
                        &source_entry,
                        methods,
                    )?,
                    "ZapRoute".into(),
                )
            } else if let Some(exports) = action_exports.get(&module.id) {
                (
                    write_server_action_entry(
                        &root,
                        &options.graph.out_dir,
                        module,
                        &source_entry,
                        exports,
                    )?,
                    "ZapAction".into(),
                )
            } else {
                (source_entry.clone(), bundle_global(&module.id))
            };
            let output = absolute(&root, server_bundle);
            let mut bundle_options =
                BundleOptions::new(&root, &server_entry, &output, Target::Server { global });
            bundle_options.aliases = options.aliases.clone();
            bundle_options.conditions = options.server_conditions.clone();
            bundle_options.minify = options.minify;
            let built = bundle(&bundle_options).await.with_context(|| {
                format!("build server bundle for module {}", module.path.display())
            })?;
            bundles.push(BuiltBundle {
                module: module.id.clone(),
                target: BuiltBundleTarget::Server,
                output,
                files: built.files,
                bytes: built.bytes,
                warnings: built.warnings,
            });
        }

        if let Some(browser_chunk) = &module.browser_chunk {
            let output = absolute(&root, browser_chunk);
            let mut bundle_options =
                BundleOptions::new(&root, &source_entry, &output, Target::Browser);
            bundle_options.aliases = options.aliases.clone();
            bundle_options.conditions = options.browser_conditions.clone();
            bundle_options.minify = options.minify;
            let built = bundle(&bundle_options).await.with_context(|| {
                format!("build browser bundle for module {}", module.path.display())
            })?;
            bundles.push(BuiltBundle {
                module: module.id.clone(),
                target: BuiltBundleTarget::Browser,
                output,
                files: built.files,
                bytes: built.bytes,
                warnings: built.warnings,
            });
        }
    }

    let manifest = absolute(&root, &options.graph.manifest_path());
    write_manifest_atomically(&graph, &manifest)?;
    Ok(ApplicationBuildOutput {
        graph,
        manifest,
        bundles,
    })
}

fn write_page_server_entry(
    root: &Path,
    out_dir: &Path,
    module: &ModuleRef,
    source_entry: &Path,
) -> Result<PathBuf> {
    let entry = absolute(root, out_dir)
        .join("entries/server")
        .join(format!("{}.js", module.id));
    let parent = entry
        .parent()
        .context("generated page server entry needs a parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let source = js_string(&source_entry.to_string_lossy());
    let body = format!(
        r#"import renderPage from "{source}";

function normalizeZapOutput(value) {{
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new TypeError("Zap page output must be text or a ReadableStream until the React SSR adapter is installed");
}}

export async function render(request) {{
  if (typeof renderPage !== "function") {{
    throw new TypeError("Zap page module must export a default function");
  }}
  return normalizeZapOutput(await renderPage(request));
}}
"#
    );
    fs::write(&entry, body).with_context(|| format!("write {}", entry.display()))?;
    Ok(entry)
}

fn write_route_handler_server_entry(
    root: &Path,
    out_dir: &Path,
    module: &ModuleRef,
    source_entry: &Path,
    methods: &[String],
) -> Result<PathBuf> {
    let entry = absolute(root, out_dir)
        .join("entries/server")
        .join(format!("{}.js", module.id));
    let parent = entry
        .parent()
        .context("generated route handler server entry needs a parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let source = js_string(&source_entry.to_string_lossy());
    let allowed = methods
        .iter()
        .map(|method| format!("\"{}\"", js_string(method)))
        .collect::<Vec<_>>()
        .join(", ");
    let body = format!(
        r#"import * as routeModule from "{source}";

const allowedMethods = [{allowed}];

function normalizeZapOutput(value) {{
  if (value == null) return "";
  if (typeof Response !== "undefined" && value instanceof Response) return value;
  if (typeof value === "string") return value;
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new TypeError("Zap route output must be text, a Response or a ReadableStream");
}}

export async function handle(request) {{
  const method = String(request && request.method || "").toUpperCase();
  if (!allowedMethods.includes(method)) {{
    throw new TypeError(`Zap route handler does not export ${{method || "a request method"}}`);
  }}
  const routeExport = (name) => routeModule[name];
  const explicitHead = routeExport("HEAD");
  const getHandler = routeExport("GET");
  const exportName = method === "HEAD" && typeof explicitHead !== "function" && typeof getHandler === "function" ? "GET" : method;
  const handler = routeExport(exportName);
  if (typeof handler !== "function") {{
    throw new TypeError(`Zap route handler export ${{exportName}} must be a function`);
  }}
  return normalizeZapOutput(await handler(request));
}}
"#
    );
    fs::write(&entry, body).with_context(|| format!("write {}", entry.display()))?;
    Ok(entry)
}

fn write_server_action_entry(
    root: &Path,
    out_dir: &Path,
    module: &ModuleRef,
    source_entry: &Path,
    exports: &[String],
) -> Result<PathBuf> {
    let entry = absolute(root, out_dir)
        .join("entries/server")
        .join(format!("{}.js", module.id));
    let parent = entry
        .parent()
        .context("generated server action entry needs a parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let source = js_string(&source_entry.to_string_lossy());
    let allowed = exports
        .iter()
        .map(|export| format!("\"{}\"", js_string(export)))
        .collect::<Vec<_>>()
        .join(", ");
    let body = format!(
        r#"import * as actionModule from "{source}";

const allowedExports = [{allowed}];

function normalizeZapOutput(value) {{
  if (value == null) return "";
  if (typeof Response !== "undefined" && value instanceof Response) return value;
  if (typeof value === "string") return value;
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return new Response(JSON.stringify(value), {{headers: {{'content-type': 'application/json'}}}});
}}

export async function invoke(invocation) {{
  const exportName = String(invocation && invocation.export || "");
  if (!allowedExports.includes(exportName)) {{
    throw new TypeError(`Zap action module does not export ${{exportName || "the requested action"}}`);
  }}
  const action = actionModule[exportName];
  if (typeof action !== "function") {{
    throw new TypeError(`Zap action export ${{exportName}} must be a function`);
  }}
  const args = Array.isArray(invocation && invocation.args) ? invocation.args : [];
  return normalizeZapOutput(await action(...args));
}}
"#
    );
    fs::write(&entry, body).with_context(|| format!("write {}", entry.display()))?;
    Ok(entry)
}

fn js_string(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

pub fn write_manifest_atomically(graph: &ApplicationGraph, path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("application manifest needs a parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let temporary = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&temporary)
            .with_context(|| format!("create {}", temporary.display()))?;
        file.write_all(graph.to_manifest_json()?.as_bytes())
            .with_context(|| format!("write {}", temporary.display()))?;
        file.write_all(b"\n")
            .with_context(|| format!("finish {}", temporary.display()))?;
        file.sync_all()
            .with_context(|| format!("sync {}", temporary.display()))?;
    }
    fs::rename(&temporary, path)
        .with_context(|| format!("replace {} with {}", path.display(), temporary.display()))?;
    Ok(())
}

#[derive(Clone, Debug)]
struct SourceModule {
    id: String,
    relative_path: PathBuf,
    kind: ModuleKind,
    cache: CachePolicy,
}

pub fn build_application_graph(options: &GraphOptions) -> Result<ApplicationGraph> {
    let root = options
        .root
        .canonicalize()
        .context("resolve application root")?;
    let app_root = absolute(&root, &options.app_dir);
    if !app_root.is_dir() {
        bail!(
            "application graph requires an app directory: {}",
            app_root.display()
        );
    }
    let public_root = options
        .public_dir
        .as_ref()
        .map(|path| absolute(&root, path));
    let out_dir = options.out_dir.clone();

    let mut files = Vec::new();
    collect_files(&app_root, &mut files)?;
    files.sort();

    let mut modules = BTreeMap::<String, SourceModule>::new();
    let mut route_sources = Vec::<(String, RouteKind, Vec<String>)>::new();
    let mut layouts_by_dir = BTreeMap::<PathBuf, LayoutRef>::new();
    let mut action_ids = BTreeSet::<String>::new();
    let mut actions = Vec::<ActionRef>::new();

    for absolute_path in files {
        let relative_path = absolute_path
            .strip_prefix(&app_root)
            .with_context(|| {
                format!(
                    "collected app file {} outside {}",
                    absolute_path.display(),
                    app_root.display()
                )
            })?
            .to_owned();
        let Some(file_name) = relative_path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_source_file(file_name) {
            continue;
        }
        let text = fs::read_to_string(&absolute_path)
            .with_context(|| format!("read {}", absolute_path.display()))?;
        let kind = classify_module(&text);
        let id = module_id(&relative_path);
        let cache = parse_cache_policy(&text)?;

        if file_name == "layout.tsx" {
            let directory = relative_path
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .to_owned();
            let depth = relative_path.components().count().saturating_sub(1);
            layouts_by_dir.insert(
                directory,
                LayoutRef {
                    id: id.clone(),
                    path: relative_path.clone(),
                    depth,
                },
            );
        }
        if kind == ModuleKind::ServerActions {
            let exports = server_action_exports(&text).with_context(|| {
                format!("discover server actions in {}", relative_path.display())
            })?;
            if exports.is_empty() {
                bail!(
                    "server action module must export at least one function or const: {}",
                    relative_path.display()
                );
            }
            for export in exports {
                let action_id = stable_action_id(&relative_path, &export);
                if !action_ids.insert(action_id.clone()) {
                    bail!("duplicate server action id: {action_id}");
                }
                actions.push(ActionRef {
                    id: action_id,
                    module: id.clone(),
                    export,
                    path: relative_path.clone(),
                });
            }
        }
        let route_kind = match file_name {
            "page.tsx" => Some(RouteKind::Page),
            "route.ts" | "route.tsx" => Some(RouteKind::Handler),
            _ => None,
        };
        if let Some(route_kind) = route_kind {
            let methods = match route_kind {
                RouteKind::Page => vec!["GET".into(), "HEAD".into()],
                RouteKind::Handler => route_handler_methods(&text).with_context(|| {
                    format!(
                        "discover route handler methods in {}",
                        relative_path.display()
                    )
                })?,
            };
            if methods.is_empty() {
                bail!(
                    "route handler must export at least one HTTP method: {}",
                    relative_path.display()
                );
            }
            route_sources.push((id.clone(), route_kind, methods));
        }
        if let Some(existing) = modules.insert(
            id.clone(),
            SourceModule {
                id: id.clone(),
                relative_path: relative_path.clone(),
                kind,
                cache,
            },
        ) {
            bail!(
                "duplicate module id {id}: {} and {}",
                existing.relative_path.display(),
                relative_path.display()
            );
        }
    }

    let mut routes = Vec::new();
    for (id, route_kind, methods) in route_sources {
        let module = modules
            .get(&id)
            .with_context(|| format!("missing module for route {id}"))?;
        let pattern = route_pattern_for(&module.relative_path);
        Route::parse(id.clone(), &pattern).map_err(|error| {
            anyhow::anyhow!(
                "invalid route pattern for {}: {error}",
                module.relative_path.display()
            )
        })?;
        let layouts = layout_chain(
            module
                .relative_path
                .parent()
                .unwrap_or_else(|| Path::new("")),
            &layouts_by_dir,
        );
        routes.push(RouteEntry {
            id: id.clone(),
            pattern,
            kind: route_kind,
            source: module.relative_path.clone(),
            layouts,
            module: id,
            methods,
            cache: module.cache.clone(),
        });
    }

    routes.sort_by(|a, b| a.pattern.cmp(&b.pattern).then(a.id.cmp(&b.id)));
    let mut module_refs = Vec::new();
    for module in modules.values() {
        let server_bundle = (module.kind != ModuleKind::Client)
            .then(|| out_dir.join("server").join(format!("{}.js", module.id)));
        let browser_chunk = (module.kind == ModuleKind::Client)
            .then(|| out_dir.join("browser").join(format!("{}.js", module.id)));
        module_refs.push(ModuleRef {
            id: module.id.clone(),
            path: module.relative_path.clone(),
            kind: module.kind.clone(),
            browser_chunk,
            server_bundle,
        });
    }
    module_refs.sort_by(|a, b| a.id.cmp(&b.id));
    actions.sort_by(|a, b| a.id.cmp(&b.id));
    let mut layouts: Vec<_> = layouts_by_dir.into_values().collect();
    layouts.sort_by(|a, b| a.depth.cmp(&b.depth).then(a.id.cmp(&b.id)));

    let assets = if let Some(public_root) = public_root.filter(|path| path.is_dir()) {
        discover_assets(&public_root)?
    } else {
        Vec::new()
    };

    let graph = ApplicationGraph {
        routes,
        layouts,
        modules: module_refs,
        actions,
        assets,
    };
    CompiledManifest::new(graph.clone())?;
    Ok(graph)
}

fn collect_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("read directory {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_files(&path, files)?;
        } else if kind.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn is_source_file(name: &str) -> bool {
    matches!(name, "page.tsx" | "layout.tsx" | "route.ts" | "route.tsx")
        || name.ends_with(".tsx")
        || name.ends_with(".ts")
}

fn classify_module(text: &str) -> ModuleKind {
    match first_directive(text).as_deref() {
        Some("use client") => ModuleKind::Client,
        Some("use server") => ModuleKind::ServerActions,
        _ => ModuleKind::Server,
    }
}

fn first_directive(text: &str) -> Option<String> {
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        let line = line.strip_suffix(';').unwrap_or(line).trim();
        if let Some(value) = line.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
            return Some(value.to_owned());
        }
        if let Some(value) = line.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
            return Some(value.to_owned());
        }
        return None;
    }
    None
}

fn module_id(path: &Path) -> String {
    let mut id = String::new();
    for component in path.components() {
        if !id.is_empty() {
            id.push('/');
        }
        id.push_str(&component.as_os_str().to_string_lossy());
    }
    id.trim_end_matches(".tsx")
        .trim_end_matches(".ts")
        .replace(['[', ']'], "_")
        .replace("...", "all")
}

fn route_pattern_for(path: &Path) -> String {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let mut parts = Vec::new();
    for component in parent.components() {
        let value = component.as_os_str().to_string_lossy();
        if value.starts_with('(') && value.ends_with(')') {
            continue;
        }
        parts.push(value.to_string());
    }
    if parts.is_empty() {
        "/".into()
    } else {
        format!("/{}", parts.join("/"))
    }
}

fn layout_chain(dir: &Path, layouts: &BTreeMap<PathBuf, LayoutRef>) -> Vec<String> {
    let mut result = Vec::new();
    let mut cursor = PathBuf::new();
    if let Some(layout) = layouts.get(Path::new("")) {
        result.push(layout.id.clone());
    }
    for component in dir.components() {
        cursor.push(component.as_os_str());
        if let Some(layout) = layouts.get(&cursor) {
            result.push(layout.id.clone());
        }
    }
    result
}

fn parse_cache_policy(text: &str) -> Result<CachePolicy> {
    let mut policy = CachePolicy::default();
    for line in text.lines().map(str::trim) {
        if let Some(value) = line.strip_prefix("export const dynamic") {
            let Some(value) = export_literal(value) else {
                continue;
            };
            policy.dynamic = match value {
                "auto" => DynamicPolicy::Auto,
                "force-static" => DynamicPolicy::ForceStatic,
                "force-dynamic" => DynamicPolicy::ForceDynamic,
                other => bail!("invalid dynamic value: {other}"),
            };
        }
        if let Some(value) = line.strip_prefix("export const revalidate") {
            let Some((_, rhs)) = value.split_once('=') else {
                continue;
            };
            let rhs = rhs.trim().trim_end_matches(';').trim();
            if rhs == "false" {
                policy.revalidate_seconds = None;
            } else {
                policy.revalidate_seconds = Some(
                    rhs.parse::<u64>()
                        .with_context(|| format!("invalid revalidate value: {rhs}"))?,
                );
            }
        }
    }
    Ok(policy)
}

fn export_literal(value: &str) -> Option<&str> {
    let (_, rhs) = value.split_once('=')?;
    let rhs = rhs.trim().trim_end_matches(';').trim();
    rhs.strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .or_else(|| {
            rhs.strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
        })
}

fn route_handler_methods(text: &str) -> Result<Vec<String>> {
    const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
    let mut found = BTreeSet::new();
    for line in text.lines().map(str::trim) {
        let Some(line) = line.strip_prefix("export ").map(str::trim_start) else {
            continue;
        };
        let candidate = if let Some(rest) = line.strip_prefix("async function ") {
            rest
        } else if let Some(rest) = line.strip_prefix("function ") {
            rest
        } else if let Some(rest) = line.strip_prefix("const ") {
            rest
        } else {
            continue;
        };
        let name = candidate
            .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
            .next()
            .unwrap_or_default();
        if METHODS.contains(&name) {
            found.insert(name.to_owned());
        }
    }
    if found.contains("GET") {
        found.insert("HEAD".into());
    }
    Ok(found.into_iter().collect())
}

fn server_action_exports(text: &str) -> Result<Vec<String>> {
    let mut names = BTreeSet::new();
    for line in text.lines().map(str::trim) {
        let Some(line) = line.strip_prefix("export ").map(str::trim_start) else {
            continue;
        };
        let candidate = if let Some(rest) = line.strip_prefix("async function ") {
            rest
        } else if let Some(rest) = line.strip_prefix("function ") {
            rest
        } else if let Some(rest) = line.strip_prefix("const ") {
            rest
        } else {
            continue;
        };
        let name = candidate
            .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
            .next()
            .unwrap_or_default();
        if name.is_empty() || name.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            bail!("invalid server action export name: {name}");
        }
        names.insert(name.to_owned());
    }
    Ok(names.into_iter().collect())
}

fn stable_action_id(path: &Path, export: &str) -> String {
    format!("action:{}#{}", module_id(path), export)
}

fn bundle_global(module_id: &str) -> String {
    let mut global = String::from("ZapModule_");
    for value in module_id.bytes() {
        let character = value as char;
        if character.is_ascii_alphanumeric() || character == '_' {
            global.push(character);
        } else {
            global.push('_');
        }
    }
    global
}

fn discover_assets(public_root: &Path) -> Result<Vec<AssetRef>> {
    let mut files = Vec::new();
    collect_files(public_root, &mut files)?;
    files.sort();
    let mut assets = Vec::new();
    for absolute_path in files {
        let relative = absolute_path
            .strip_prefix(public_root)
            .with_context(|| {
                format!(
                    "collected public asset {} outside {}",
                    absolute_path.display(),
                    public_root.display()
                )
            })?
            .to_owned();
        let mut url_path = String::from("/");
        url_path.push_str(
            &relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
        );
        assets.push(AssetRef {
            source: relative,
            url_path,
        });
    }
    Ok(assets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use zap_render::Renderer;

    fn write_fixture(root: &Path) -> Vec<(String, String)> {
        let runtime = root.join("third_party/react");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(
            runtime.join("jsx-runtime.js"),
            r#"
            export function jsx(type, props) {
                return { type, props };
            }
            export const jsxs = jsx;
            export const Fragment = Symbol.for("react.fragment");
            "#,
        )
        .unwrap();
        fs::write(
            root.join("entry.tsx"),
            r#"
            const name: string = "Zap";
            export const view = <main data-framework={name}>Hello {name}</main>;
            "#,
        )
        .unwrap();
        vec![("react".into(), runtime.to_string_lossy().into_owned())]
    }

    #[test]
    fn application_graph_discovers_routes_modules_actions_layouts_and_assets() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        fs::create_dir_all(app.join("dashboard/[id]")).unwrap();
        fs::create_dir_all(app.join("api/echo")).unwrap();
        fs::create_dir_all(temp.path().join("public/images")).unwrap();
        fs::write(
            app.join("layout.tsx"),
            "export default function Layout(){}\n",
        )
        .unwrap();
        fs::write(
            app.join("dashboard/layout.tsx"),
            "export default function DashboardLayout(){}\n",
        )
        .unwrap();
        fs::write(
            app.join("dashboard/[id]/page.tsx"),
            "export const dynamic = 'force-static';\nexport const revalidate = 60;\nexport default function Page(){}\n",
        )
        .unwrap();
        fs::write(app.join("api/echo/route.ts"), "export function POST(){}\n").unwrap();
        fs::write(
            app.join("counter.tsx"),
            "'use client';\nexport function Counter(){}\n",
        )
        .unwrap();
        fs::write(
            app.join("actions.ts"),
            "'use server';\nexport async function save(){}\nexport const remove = async () => {};\n",
        )
        .unwrap();
        fs::write(temp.path().join("public/images/logo.svg"), "<svg/>\n").unwrap();

        let graph = build_application_graph(&GraphOptions::new(temp.path())).unwrap();
        assert_eq!(graph.routes.len(), 2);
        let page = graph
            .routes
            .iter()
            .find(|route| route.pattern == "/dashboard/[id]")
            .unwrap();
        assert_eq!(page.kind, RouteKind::Page);
        assert_eq!(page.layouts, vec!["layout", "dashboard/layout"]);
        assert_eq!(page.methods, vec!["GET", "HEAD"]);
        assert_eq!(page.cache.dynamic, DynamicPolicy::ForceStatic);
        assert_eq!(page.cache.revalidate_seconds, Some(60));

        let handler = graph
            .routes
            .iter()
            .find(|route| route.pattern == "/api/echo")
            .unwrap();
        assert_eq!(handler.kind, RouteKind::Handler);
        assert_eq!(handler.methods, vec!["POST"]);

        let client = graph
            .modules
            .iter()
            .find(|module| module.id == "counter")
            .unwrap();
        assert_eq!(client.kind, ModuleKind::Client);
        assert_eq!(
            client.browser_chunk.as_deref(),
            Some(Path::new(".zap/browser/counter.js"))
        );
        assert_eq!(client.server_bundle, None);

        assert_eq!(graph.actions.len(), 2);
        assert_eq!(graph.actions[0].id, "action:actions#remove");
        assert_eq!(graph.actions[0].export, "remove");
        assert_eq!(graph.actions[1].id, "action:actions#save");
        assert_eq!(graph.actions[1].export, "save");
        assert_eq!(graph.assets[0].url_path, "/images/logo.svg");
        graph.to_manifest_json().unwrap();
    }

    #[test]
    fn application_graph_rejects_invalid_cache_exports() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        fs::create_dir_all(&app).unwrap();
        fs::write(
            app.join("page.tsx"),
            "export const dynamic = 'force-staticity';
export default function Page(){}
",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("invalid dynamic value"), "{error}");
    }

    #[test]
    fn application_graph_rejects_ambiguous_route_groups() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        fs::create_dir_all(app.join("(public)/shop")).unwrap();
        fs::create_dir_all(app.join("(admin)/shop")).unwrap();
        fs::write(
            app.join("(public)/shop/page.tsx"),
            "export default function Page(){}\n",
        )
        .unwrap();
        fs::write(
            app.join("(admin)/shop/page.tsx"),
            "export default function Page(){}\n",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("ambiguous route patterns"), "{error}");
    }

    #[test]
    fn application_graph_rejects_duplicate_module_ids() {
        let temp = tempfile::tempdir().unwrap();
        let route = temp.path().join("app/api/echo");
        fs::create_dir_all(&route).unwrap();
        fs::write(
            route.join("route.ts"),
            "export function GET(){}
",
        )
        .unwrap();
        fs::write(
            route.join("route.tsx"),
            "export function POST(){}
",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("duplicate module id"), "{error}");
    }

    #[test]
    fn route_handlers_must_export_http_methods() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app/api/empty");
        fs::create_dir_all(&app).unwrap();
        fs::write(
            app.join("route.ts"),
            "export function helper(){}
",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("must export at least one HTTP method"),
            "{error}"
        );
    }

    #[test]
    fn route_handlers_add_head_for_get_exports() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app/api/ping");
        fs::create_dir_all(&app).unwrap();
        fs::write(
            app.join("route.ts"),
            "export function GET(){}
",
        )
        .unwrap();

        let graph = build_application_graph(&GraphOptions::new(temp.path())).unwrap();
        let route = graph
            .routes
            .iter()
            .find(|route| route.pattern == "/api/ping")
            .unwrap();
        assert_eq!(route.methods, vec!["GET", "HEAD"]);
    }

    #[test]
    fn server_action_modules_must_export_named_actions() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        fs::create_dir_all(&app).unwrap();
        fs::write(
            app.join("page.tsx"),
            "export default function Page(){}
",
        )
        .unwrap();
        fs::write(
            app.join("actions.ts"),
            "'use server';
const hidden = 1;
",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("must export at least one"), "{error}");
    }

    #[tokio::test]
    async fn build_application_writes_manifest_and_bundles_graph_outputs() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(app.join("api/echo")).unwrap();
        fs::create_dir_all(app.join("api/ping")).unwrap();
        fs::write(
            app.join("page.tsx"),
            "export const dynamic = 'force-dynamic';
export default function Page(request){ return `home:${request.path}`; }
",
        )
        .unwrap();
        fs::write(
            app.join("client.tsx"),
            "'use client';
export function Counter(){ return '1'; }
",
        )
        .unwrap();
        fs::write(
            app.join("api/echo/route.ts"),
            "export function POST(request){ return new Response(`echo:${request.method}:${request.path}`, {status: 202, headers: {'x-zap-route': 'echo'}}); }
",
        )
        .unwrap();
        fs::write(
            app.join("api/ping/route.ts"),
            "export function GET(request){ return new Response(`ping:${request.method}:${request.path}`, {status: 200, headers: {'x-zap-route': 'ping'}}); }
",
        )
        .unwrap();
        fs::write(
            app.join("actions.ts"),
            "'use server';
export async function save(input){ return new Response(`saved:${input.id}`, {status: 203, headers: {'x-zap-action': 'save'}}); }
",
        )
        .unwrap();

        let mut options = ApplicationBuildOptions::new(temp.path());
        options.minify = false;
        let output = build_application(&options).await.unwrap();

        assert!(output.manifest.ends_with(Path::new(".zap/manifest.json")));
        assert!(output.manifest.is_file());
        let manifest = fs::read_to_string(&output.manifest).unwrap();
        assert!(manifest.contains("ForceDynamic"));
        assert!(manifest.contains(".zap/server/page.js"));
        let compiled = CompiledManifest::load(&output.manifest).unwrap();
        let matched = compiled.resolve("/").unwrap().unwrap();
        assert_eq!(matched.route.module, "page");
        let handler = compiled.resolve("/api/echo").unwrap().unwrap();
        assert_eq!(handler.route.module, "api/echo/route");
        let get_handler = compiled.resolve("/api/ping").unwrap().unwrap();
        assert_eq!(get_handler.route.methods, vec!["GET", "HEAD"]);

        let server_outputs = output
            .bundles
            .iter()
            .filter(|bundle| bundle.target == BuiltBundleTarget::Server)
            .count();
        let browser_outputs = output
            .bundles
            .iter()
            .filter(|bundle| bundle.target == BuiltBundleTarget::Browser)
            .count();
        assert_eq!(server_outputs, 4);
        assert_eq!(browser_outputs, 1);
        let page_bundle = temp.path().join(".zap/server/page.js");
        let route_bundle = temp.path().join(".zap/server/api/echo/route.js");
        let get_route_bundle = temp.path().join(".zap/server/api/ping/route.js");
        let action_bundle = temp.path().join(".zap/server/actions.js");
        assert!(page_bundle.is_file());
        assert!(route_bundle.is_file());
        assert!(get_route_bundle.is_file());
        assert!(action_bundle.is_file());
        assert!(!temp.path().join(".zap/server/client.js").exists());
        assert!(temp.path().join(".zap/browser/client.js").is_file());
        assert!(temp.path().join(".zap/entries/server/page.js").is_file());
        assert!(
            temp.path()
                .join(".zap/entries/server/api/echo/route.js")
                .is_file()
        );
        assert!(temp.path().join(".zap/entries/server/actions.js").is_file());
        let rendered = Renderer::new(fs::read_to_string(page_bundle).unwrap())
            .render(r#"{"path":"/"}"#)
            .unwrap();
        assert_eq!(rendered, "home:/");
        let handled = Renderer::new(fs::read_to_string(route_bundle).unwrap())
            .handle_route_response(r#"{"method":"POST","path":"/api/echo"}"#)
            .unwrap();
        assert_eq!(handled.status, 202);
        assert_eq!(handled.headers, vec![("x-zap-route".into(), "echo".into())]);
        assert_eq!(handled.body, "echo:POST:/api/echo");
        let head = Renderer::new(fs::read_to_string(get_route_bundle).unwrap())
            .handle_route_response(r#"{"method":"HEAD","path":"/api/ping"}"#)
            .unwrap();
        assert_eq!(head.status, 200);
        assert_eq!(head.headers, vec![("x-zap-route".into(), "ping".into())]);
        assert_eq!(head.body, "ping:HEAD:/api/ping");
        let action = Renderer::new(fs::read_to_string(action_bundle).unwrap())
            .invoke_action_response(r#"{"export":"save","args":[{"id":7}]}"#)
            .unwrap();
        assert_eq!(action.status, 203);
        assert_eq!(action.headers, vec![("x-zap-action".into(), "save".into())]);
        assert_eq!(action.body, "saved:7");
    }

    #[tokio::test]
    async fn bundles_tsx_server_iife_from_rust_fixture() {
        let temp = tempfile::tempdir().unwrap();
        let aliases = write_fixture(temp.path());
        let output = temp.path().join("dist/server.js");
        let mut options = BundleOptions::new(
            temp.path(),
            Path::new("entry.tsx"),
            &output,
            Target::Server {
                global: "ZapRender".into(),
            },
        );
        options.aliases = aliases;
        let result = bundle(&options).await.unwrap();

        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.files, vec![output.clone()]);
        let code = fs::read_to_string(output).unwrap();
        assert!(code.contains("ZapRender"));
        assert!(code.contains("Zap"));
    }

    #[tokio::test]
    async fn bundles_tsx_browser_module_from_rust_fixture() {
        let temp = tempfile::tempdir().unwrap();
        let aliases = write_fixture(temp.path());
        let output = temp.path().join("dist/client.js");
        let mut options = BundleOptions::new(
            temp.path(),
            Path::new("entry.tsx"),
            &output,
            Target::Browser,
        );
        options.aliases = aliases;
        let result = bundle(&options).await.unwrap();

        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.files, vec![output.clone()]);
        let code = fs::read_to_string(output).unwrap();
        assert!(code.contains("Zap"));
        assert!(code.contains("export"));
    }

    #[tokio::test]
    async fn rejects_unavailable_platform_modules() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("entry.ts"),
            "import fs from 'node:fs'; export const value = fs.readFileSync;",
        )
        .unwrap();
        let output = temp.path().join("dist/client.js");
        let error = bundle(&BundleOptions::new(
            temp.path(),
            Path::new("entry.ts"),
            &output,
            Target::Browser,
        ))
        .await
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("bundle cannot depend on unavailable modules"),
            "{error:?}"
        );
        assert!(!output.exists());
    }
}
