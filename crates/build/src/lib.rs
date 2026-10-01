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
    validate_local_module_graph(&root, &entry)?;
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

const DISALLOWED_PLATFORM_MODULES: &[&str] = &[
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
];

fn validate_local_module_graph(root: &Path, entry: &Path) -> Result<()> {
    let mut visited = BTreeSet::new();
    validate_local_module(root, entry, &mut visited)
}

fn validate_local_module(root: &Path, path: &Path, visited: &mut BTreeSet<PathBuf>) -> Result<()> {
    let path = path
        .canonicalize()
        .with_context(|| format!("resolve source module {}", path.display()))?;
    if !path.starts_with(root) {
        bail!(
            "source module {} escapes bundle root {}",
            path.display(),
            root.display()
        );
    }
    if !visited.insert(path.clone()) {
        return Ok(());
    }
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    if let Some(global) = unavailable_platform_global(&text) {
        bail!(
            "bundle cannot depend on unavailable platform global {global:?} in {}",
            path.display()
        );
    }
    if has_non_static_dynamic_import(&text) {
        bail!(
            "bundle cannot depend on non-static dynamic import in {}",
            path.display()
        );
    }
    for specifier in module_specifiers(&text) {
        if is_unavailable_platform_specifier(&specifier.value) {
            bail!(
                "bundle cannot depend on unavailable platform module {:?} in {}",
                specifier.value,
                path.display()
            );
        }
        if specifier.type_only {
            continue;
        }
        if specifier.value.starts_with('.') || specifier.value.starts_with('/') {
            let resolved = resolve_local_specifier(&path, &specifier.value).with_context(|| {
                format!(
                    "resolve local module {:?} from {}",
                    specifier.value,
                    path.display()
                )
            })?;
            validate_local_module(root, &resolved, visited)?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum JsToken {
    Ident(String),
    Number(String),
    String(String),
    Punct(char),
}

fn has_non_static_dynamic_import(text: &str) -> bool {
    let tokens = js_tokens(text);
    tokens.iter().enumerate().any(|(index, token)| {
        if !matches!(token, JsToken::Ident(value) if value == "import")
            || !matches!(tokens.get(index + 1), Some(JsToken::Punct('(')))
        {
            return false;
        }
        match tokens.get(index + 2) {
            Some(JsToken::String(_)) => !matches!(
                tokens.get(index + 3),
                Some(JsToken::Punct(')') | JsToken::Punct(','))
            ),
            _ => true,
        }
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ModuleSpecifier {
    value: String,
    type_only: bool,
}

fn module_specifiers(text: &str) -> Vec<ModuleSpecifier> {
    let tokens = js_tokens(text);
    let mut specifiers = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        match token {
            JsToken::Ident(value) if value == "import" => match tokens.get(index + 1) {
                Some(JsToken::String(specifier)) => specifiers.push(ModuleSpecifier {
                    value: specifier.clone(),
                    type_only: false,
                }),
                Some(JsToken::Ident(kind)) if kind == "type" => {
                    if let Some((specifier, _)) = following_from_specifier(&tokens, index + 2) {
                        specifiers.push(ModuleSpecifier {
                            value: specifier,
                            type_only: true,
                        });
                    }
                }
                Some(JsToken::Punct('(')) => {
                    if let Some(JsToken::String(specifier)) = tokens.get(index + 2) {
                        specifiers.push(ModuleSpecifier {
                            value: specifier.clone(),
                            type_only: false,
                        });
                    }
                }
                _ => {
                    if let Some((specifier, _)) = following_from_specifier(&tokens, index + 1) {
                        let type_only = named_list_is_type_only(&tokens, index + 1);
                        specifiers.push(ModuleSpecifier {
                            value: specifier,
                            type_only,
                        });
                    }
                }
            },
            JsToken::Ident(value) if value == "require" => {
                if matches!(tokens.get(index + 1), Some(JsToken::Punct('('))) {
                    if let Some(JsToken::String(specifier)) = tokens.get(index + 2) {
                        specifiers.push(ModuleSpecifier {
                            value: specifier.clone(),
                            type_only: false,
                        });
                    }
                }
            }
            JsToken::Ident(value) if value == "export" => {
                let type_only = matches!(tokens.get(index + 1), Some(JsToken::Ident(kind)) if kind == "type")
                    || named_list_is_type_only(&tokens, index + 1);
                if let Some((specifier, _)) = following_from_specifier(&tokens, index + 1) {
                    specifiers.push(ModuleSpecifier {
                        value: specifier,
                        type_only,
                    });
                }
            }
            JsToken::Ident(value) if value == "from" => {
                if !preceded_by_import_or_export(&tokens, index) {
                    if let Some(JsToken::String(specifier)) = tokens.get(index + 1) {
                        specifiers.push(ModuleSpecifier {
                            value: specifier.clone(),
                            type_only: false,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    specifiers
}

fn named_list_is_type_only(tokens: &[JsToken], start: usize) -> bool {
    let Some(open) = (start..tokens.len())
        .take_while(
            |index| !matches!(tokens.get(*index), Some(JsToken::Ident(value)) if value == "from"),
        )
        .find(|index| matches!(tokens.get(*index), Some(JsToken::Punct('{'))))
    else {
        return false;
    };
    let mut saw_specifier = false;
    let mut expect_specifier = true;
    let mut depth = 0usize;
    let mut index = open;
    while index < tokens.len() {
        match tokens.get(index) {
            Some(JsToken::Punct('{')) => {
                depth += 1;
                index += 1;
            }
            Some(JsToken::Punct('}')) => {
                depth = depth.saturating_sub(1);
                return depth == 0 && saw_specifier;
            }
            Some(JsToken::Ident(value)) if depth == 1 && expect_specifier => {
                if value != "type" {
                    return false;
                }
                saw_specifier = true;
                expect_specifier = false;
                index += 1;
            }
            Some(JsToken::Punct(',')) if depth == 1 => {
                expect_specifier = true;
                index += 1;
            }
            Some(JsToken::Ident(value)) if depth == 1 && value == "from" => return false,
            _ => index += 1,
        }
    }
    false
}

fn following_from_specifier(tokens: &[JsToken], start: usize) -> Option<(String, usize)> {
    let mut depth = 0usize;
    for index in start..tokens.len() {
        match tokens.get(index) {
            Some(JsToken::Punct('{' | '(' | '[')) => depth += 1,
            Some(JsToken::Punct('}' | ')' | ']')) => depth = depth.saturating_sub(1),
            Some(JsToken::Ident(value)) if value == "from" && depth == 0 => {
                if let Some(JsToken::String(specifier)) = tokens.get(index + 1) {
                    return Some((specifier.clone(), index + 1));
                }
                return None;
            }
            Some(JsToken::Punct(';')) if depth == 0 => return None,
            _ => {}
        }
    }
    None
}

fn preceded_by_import_or_export(tokens: &[JsToken], from_index: usize) -> bool {
    let mut cursor = from_index;
    while cursor > 0 {
        cursor -= 1;
        match tokens.get(cursor) {
            Some(JsToken::Ident(value)) if value == "import" || value == "export" => return true,
            Some(JsToken::Punct(';')) => return false,
            _ => {}
        }
    }
    false
}

fn js_tokens(text: &str) -> Vec<JsToken> {
    let mut tokens = Vec::new();
    let mut previous = None::<JsToken>;
    let mut chars = text.char_indices().peekable();
    while let Some((_, ch)) = chars.next() {
        if ch.is_whitespace() {
            continue;
        }
        if ch == '/' {
            match chars.peek().copied() {
                Some((_, '/')) => {
                    chars.next();
                    for (_, ch) in chars.by_ref() {
                        if ch == '\n' {
                            break;
                        }
                    }
                    continue;
                }
                Some((_, '*')) => {
                    chars.next();
                    let mut previous_comment = '\0';
                    for (_, ch) in chars.by_ref() {
                        if previous_comment == '*' && ch == '/' {
                            break;
                        }
                        previous_comment = ch;
                    }
                    continue;
                }
                _ if slash_can_start_regex(previous.as_ref()) => {
                    skip_regex_literal(&mut chars);
                    continue;
                }
                _ => {}
            }
        }
        if ch == '\'' || ch == '"' {
            let token = JsToken::String(read_js_string(ch, &mut chars));
            previous = Some(token.clone());
            tokens.push(token);
            continue;
        }
        if ch.is_ascii_digit() {
            let mut number = String::from(ch);
            while let Some((_, next)) = chars.peek().copied() {
                if !next.is_ascii_digit() {
                    break;
                }
                number.push(next);
                chars.next();
            }
            let token = JsToken::Number(number);
            previous = Some(token.clone());
            tokens.push(token);
            continue;
        }
        if ch == '`' {
            if let Some(value) = read_static_template_literal(&mut chars) {
                let token = JsToken::String(value);
                previous = Some(token.clone());
                tokens.push(token);
            }
            continue;
        }
        if is_ident_start(ch) {
            let mut ident = String::from(ch);
            while let Some((_, next)) = chars.peek().copied() {
                if !is_ident_continue(next) {
                    break;
                }
                ident.push(next);
                chars.next();
            }
            let token = JsToken::Ident(ident);
            previous = Some(token.clone());
            tokens.push(token);
            continue;
        }
        let token = JsToken::Punct(ch);
        previous = Some(token.clone());
        tokens.push(token);
    }
    tokens
}

fn slash_can_start_regex(previous: Option<&JsToken>) -> bool {
    match previous {
        None => true,
        Some(JsToken::Ident(value)) => matches!(
            value.as_str(),
            "return"
                | "throw"
                | "case"
                | "delete"
                | "typeof"
                | "void"
                | "yield"
                | "await"
                | "in"
                | "instanceof"
        ),
        Some(JsToken::Punct(value)) => matches!(
            value,
            '(' | '['
                | '{'
                | ','
                | ';'
                | ':'
                | '='
                | '!'
                | '?'
                | '&'
                | '|'
                | '+'
                | '-'
                | '*'
                | '%'
                | '^'
                | '~'
                | '<'
                | '>'
        ),
        Some(JsToken::Number(_) | JsToken::String(_)) => false,
    }
}

fn read_js_string(
    quote: char,
    chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>,
) -> String {
    let mut value = String::new();
    let mut escaped = false;
    for (_, ch) in chars.by_ref() {
        if escaped {
            value.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            break;
        }
        value.push(ch);
    }
    value
}

fn skip_regex_literal(chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>) {
    let mut escaped = false;
    let mut in_class = false;
    while let Some((_, ch)) = chars.next() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '[' {
            in_class = true;
            continue;
        }
        if ch == ']' {
            in_class = false;
            continue;
        }
        if ch == '/' && !in_class {
            while let Some((_, flag)) = chars.peek().copied() {
                if !is_ident_continue(flag) {
                    break;
                }
                chars.next();
            }
            break;
        }
        if ch == '\n' || ch == '\r' {
            break;
        }
    }
}

fn read_static_template_literal(
    chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>,
) -> Option<String> {
    let mut value = String::new();
    let mut escaped = false;
    while let Some((_, ch)) = chars.next() {
        if escaped {
            value.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '$' && matches!(chars.peek().copied(), Some((_, '{'))) {
            chars.next();
            skip_template_expression(chars);
            skip_template_tail(chars);
            return None;
        }
        if ch == '`' {
            return Some(value);
        }
        value.push(ch);
    }
    None
}

fn skip_template_tail(chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>) {
    let mut escaped = false;
    while let Some((_, ch)) = chars.next() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '$' && matches!(chars.peek().copied(), Some((_, '{'))) {
            chars.next();
            skip_template_expression(chars);
            continue;
        }
        if ch == '`' {
            break;
        }
    }
}

fn skip_template_expression(chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>) {
    let mut depth = 1usize;
    let mut string_quote = None;
    let mut escaped = false;
    for (_, ch) in chars.by_ref() {
        if let Some(quote) = string_quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                string_quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' | '`' => string_quote = Some(ch),
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
    }
}

fn is_ident_start(ch: char) -> bool {
    ch == '_' || ch == '$' || ch.is_ascii_alphabetic()
}

fn is_ident_continue(ch: char) -> bool {
    is_ident_start(ch) || ch.is_ascii_digit()
}

fn unavailable_platform_global(text: &str) -> Option<String> {
    let tokens = js_tokens(text);
    tokens.iter().enumerate().find_map(|(index, token)| {
        if let Some(value) = ambient_platform_global_string_member(&tokens, index) {
            return Some(value);
        }
        if let Some(value) = ambient_platform_global_probe(&tokens, index) {
            return Some(value);
        }
        if let Some(value) = destructured_platform_global_from_global_object(&tokens, index) {
            return Some(value);
        }
        let JsToken::Ident(value) = token else {
            return None;
        };
        is_ambient_platform_global_reference(&tokens, index).then(|| value.clone())
    })
}

fn ambient_platform_global_string_member(tokens: &[JsToken], index: usize) -> Option<String> {
    let Some(JsToken::Ident(root)) = tokens.get(index) else {
        return None;
    };
    if !is_global_object_name(root) {
        return None;
    }
    let member_start = optional_chain_member_start(tokens, index + 1)?;
    let (value, close_bracket) = static_string_expression(tokens, member_start + 1)?;
    if !is_unavailable_platform_global_name(&value)
        || !matches!(tokens.get(close_bracket), Some(JsToken::Punct(']')))
    {
        return None;
    }
    Some(value)
}

fn static_string_expression(tokens: &[JsToken], index: usize) -> Option<(String, usize)> {
    let Some(JsToken::String(first)) = tokens.get(index) else {
        return None;
    };
    let mut value = first.clone();
    let mut cursor = index + 1;
    while matches!(tokens.get(cursor), Some(JsToken::Punct('+'))) {
        let Some(JsToken::String(part)) = tokens.get(cursor + 1) else {
            return None;
        };
        value.push_str(part);
        cursor += 2;
    }
    Some((value, cursor))
}

fn optional_chain_member_start(tokens: &[JsToken], index: usize) -> Option<usize> {
    if matches!(tokens.get(index), Some(JsToken::Punct('['))) {
        return Some(index);
    }
    if matches!(tokens.get(index), Some(JsToken::Punct('?')))
        && matches!(tokens.get(index + 1), Some(JsToken::Punct('.')))
        && matches!(tokens.get(index + 2), Some(JsToken::Punct('[')))
    {
        return Some(index + 2);
    }
    None
}

fn ambient_platform_global_probe(tokens: &[JsToken], index: usize) -> Option<String> {
    let Some(JsToken::String(value)) = tokens.get(index) else {
        return None;
    };
    if !is_unavailable_platform_global_name(value)
        || !matches!(tokens.get(index + 1), Some(JsToken::Ident(operator)) if operator == "in")
        || !matches!(tokens.get(index + 2), Some(JsToken::Ident(root)) if is_global_object_name(root))
    {
        return None;
    }
    Some(value.clone())
}

fn destructured_platform_global_from_global_object(
    tokens: &[JsToken],
    index: usize,
) -> Option<String> {
    if !matches!(tokens.get(index), Some(JsToken::Punct('{'))) {
        return None;
    }
    let mut depth = 0usize;
    let mut candidate = None::<String>;
    for cursor in index..tokens.len() {
        match tokens.get(cursor) {
            Some(JsToken::Punct('{')) => depth += 1,
            Some(JsToken::Punct('}')) => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return if matches!(tokens.get(cursor + 1), Some(JsToken::Punct('=')))
                        && matches!(tokens.get(cursor + 2), Some(JsToken::Ident(root)) if is_global_object_name(root))
                    {
                        candidate
                    } else {
                        None
                    };
                }
            }
            Some(JsToken::Ident(value)) | Some(JsToken::String(value)) if depth == 1 => {
                if is_unavailable_platform_global_name(value) {
                    candidate = Some(value.clone());
                }
            }
            _ => {}
        }
    }
    None
}

fn is_ambient_platform_global_reference(tokens: &[JsToken], index: usize) -> bool {
    let Some(JsToken::Ident(value)) = tokens.get(index) else {
        return false;
    };
    if !is_unavailable_platform_global_name(value) {
        return false;
    }
    if is_non_reference_identifier(tokens, index) {
        return false;
    }
    if matches!(tokens.get(index.wrapping_sub(1)), Some(JsToken::Punct('.'))) {
        return matches!(tokens.get(index.wrapping_sub(2)), Some(JsToken::Ident(root)) if is_global_object_name(root))
            || (matches!(tokens.get(index.wrapping_sub(2)), Some(JsToken::Punct('?')))
                && matches!(tokens.get(index.wrapping_sub(3)), Some(JsToken::Ident(root)) if is_global_object_name(root)));
    }
    true
}

fn is_global_object_name(value: &str) -> bool {
    matches!(value, "globalThis" | "global" | "window" | "self")
}

fn is_unavailable_platform_global_name(value: &str) -> bool {
    matches!(
        value,
        "process" | "Buffer" | "require" | "module" | "exports" | "__dirname" | "__filename"
    )
}

fn is_non_reference_identifier(tokens: &[JsToken], index: usize) -> bool {
    if matches!(tokens.get(index + 1), Some(JsToken::Punct(':')))
        && is_object_member_prefix(tokens, index)
    {
        return true;
    }
    if matches!(tokens.get(index + 1), Some(JsToken::Punct('?')))
        && matches!(tokens.get(index + 2), Some(JsToken::Punct(':')))
        && is_object_member_prefix(tokens, index)
    {
        return true;
    }
    if matches!(
        tokens.get(index.wrapping_sub(1)),
        Some(JsToken::Ident(previous))
            if matches!(previous.as_str(), "function" | "class" | "type" | "interface" | "as")
    ) {
        return true;
    }
    if matches!(
        tokens.get(index.wrapping_sub(1)),
        Some(JsToken::Ident(previous)) if matches!(previous.as_str(), "const" | "let" | "var")
    ) {
        return true;
    }
    if is_object_member_prefix(tokens, index)
        && matches!(tokens.get(index + 1), Some(JsToken::Punct('(')))
        && method_body_starts_after_parameters(tokens, index + 1)
    {
        return true;
    }
    false
}

fn is_object_member_prefix(tokens: &[JsToken], index: usize) -> bool {
    matches!(
        tokens.get(index.wrapping_sub(1)),
        Some(JsToken::Punct('{') | JsToken::Punct(','))
    )
}

fn method_body_starts_after_parameters(tokens: &[JsToken], open: usize) -> bool {
    let mut depth = 0usize;
    for (index, token) in tokens.iter().enumerate().skip(open) {
        match token {
            JsToken::Punct('(') => depth += 1,
            JsToken::Punct(')') => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return matches!(tokens.get(index + 1), Some(JsToken::Punct('{')));
                }
            }
            _ => {}
        }
    }
    false
}

fn is_unavailable_platform_specifier(specifier: &str) -> bool {
    let specifier = specifier
        .strip_prefix(concat!("no", "de:"))
        .unwrap_or(specifier);
    let Some((head, _)) = specifier.split_once('/') else {
        return DISALLOWED_PLATFORM_MODULES.contains(&specifier);
    };
    DISALLOWED_PLATFORM_MODULES.contains(&head)
}

fn resolve_local_specifier(importer: &Path, specifier: &str) -> Result<PathBuf> {
    let base = if specifier.starts_with('/') {
        PathBuf::from(specifier)
    } else {
        importer
            .parent()
            .context("source module needs a parent directory")?
            .join(specifier)
    };
    for candidate in local_module_candidates(&base) {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    bail!("local module not found: {}", base.display())
}

fn local_module_candidates(base: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![base.to_owned()];
    for extension in ["ts", "tsx", "js", "jsx"] {
        candidates.push(base.with_extension(extension));
    }
    for extension in ["ts", "tsx", "js", "jsx"] {
        candidates.push(base.join(format!("index.{extension}")));
    }
    candidates
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
        ActionRef, ApplicationManifest, AssetRef, CachePolicy, ClientReference, CompiledManifest,
        DynamicPolicy, LayoutRef, ModuleKind, ModuleRef, RouteEntry, RouteKind,
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
    pub action_proxy: Option<PathBuf>,
    pub bundles: Vec<BuiltBundle>,
}

pub async fn build_application(
    options: &ApplicationBuildOptions,
) -> Result<ApplicationBuildOutput> {
    let mut graph = build_application_graph(&options.graph)?;
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

    let action_proxy = write_action_proxy(&root, &options.graph.out_dir, &graph.actions)?;
    graph.action_proxy = action_proxy
        .as_ref()
        .map(|_| options.graph.out_dir.join("browser/actions.js"));
    let manifest = absolute(&root, &options.graph.manifest_path());
    write_manifest_atomically(&graph, &manifest)?;
    Ok(ApplicationBuildOutput {
        graph,
        manifest,
        action_proxy,
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
import {{ renderToReadableStream }} from "react-dom/server.browser";

async function normalizeZapOutput(value) {{
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "object") {{
    if (typeof renderToReadableStream !== "function") {{
      throw new TypeError("Zap page React SSR adapter must export renderToReadableStream");
    }}
    return renderToReadableStream(value);
  }}
  throw new TypeError("Zap page output must be text, a Web ReadableStream, or a React render tree");
}}

export async function render(request) {{
  if (typeof renderPage !== "function") {{
    throw new TypeError("Zap page module must export a default function");
  }}
  return await normalizeZapOutput(await renderPage(request));
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

fn write_action_proxy(
    root: &Path,
    out_dir: &Path,
    actions: &[ActionRef],
) -> Result<Option<PathBuf>> {
    if actions.is_empty() {
        return Ok(None);
    }

    let proxy = absolute(root, out_dir).join("browser/actions.js");
    let parent = proxy
        .parent()
        .context("generated action proxy needs a parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;

    let mut entries = Vec::with_capacity(actions.len());
    for action in actions {
        entries.push(format!(
            "  \"{}\": Object.freeze({{ id: \"{}\", module: \"{}\", export: \"{}\" }})",
            js_string(&action.id),
            js_string(&action.id),
            js_string(&action.module),
            js_string(&action.export),
        ));
    }
    let entries = entries.join(",\n");
    let body = format!(
        r#"const actionRegistry = Object.freeze({{
{entries}
}});

function hasOwn(value, key) {{
  return Object.prototype.hasOwnProperty.call(value, key);
}}

function resolveAction(action) {{
  const id = typeof action === "string" ? action : action && action.id;
  if (typeof id !== "string" || id.length === 0) {{
    throw new TypeError("Zap action calls require an action id");
  }}
  if (!hasOwn(actionRegistry, id)) {{
    throw new TypeError(`Unknown Zap action: ${{id}}`);
  }}
  return actionRegistry[id];
}}

export const actions = actionRegistry;

export function actionId(module, exportName) {{
  for (const action of Object.values(actionRegistry)) {{
    if (action.module === module && action.export === exportName) {{
      return action.id;
    }}
  }}
  throw new TypeError(`Unknown Zap action export: ${{module}}#${{exportName}}`);
}}

export function bindAction(action, options = {{}}) {{
  const resolved = resolveAction(action);
  return (...args) => invokeAction(resolved.id, args, options);
}}

export async function invokeAction(action, args = [], options = {{}}) {{
  const resolved = resolveAction(action);
  if (!Array.isArray(args)) {{
    throw new TypeError("Zap action args must be an array");
  }}

  const endpoint = typeof options.endpoint === "string" && options.endpoint.length > 0
    ? options.endpoint
    : "/_zap/action";
  const headers = Object.assign({{ "content-type": "application/json" }}, options.headers || {{}});
  const response = await fetch(endpoint, {{
    method: "POST",
    credentials: options.credentials || "same-origin",
    headers,
    body: JSON.stringify({{ action_id: resolved.id, args }})
  }});

  if (!response.ok && options.throwOnError !== false) {{
    throw new Error(`Zap action failed: ${{response.status}}`);
  }}
  return response;
}}
"#
    );
    fs::write(&proxy, body).with_context(|| format!("write {}", proxy.display()))?;
    Ok(Some(proxy))
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
    text: String,
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
    let mut client_reference_ids = BTreeSet::<String>::new();
    let mut client_references = Vec::<ClientReference>::new();

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
        let route_kind = match file_name {
            "page.tsx" => Some(RouteKind::Page),
            "route.ts" | "route.tsx" => Some(RouteKind::Handler),
            _ => None,
        };
        let graph_entry = file_name == "layout.tsx"
            || route_kind.is_some()
            || matches!(kind, ModuleKind::Client | ModuleKind::ServerActions);
        if !graph_entry {
            continue;
        }
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
                    "server action module must export at least one callable action: {}",
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
        if kind == ModuleKind::Client {
            let exports = client_reference_exports(&text).with_context(|| {
                format!("discover client references in {}", relative_path.display())
            })?;
            if exports.is_empty() {
                bail!(
                    "client module must export at least one component or value: {}",
                    relative_path.display()
                );
            }
            let browser_chunk = out_dir.join("browser").join(format!("{}.js", id));
            for export in exports {
                let reference_id = stable_client_reference_id(&relative_path, &export);
                if !client_reference_ids.insert(reference_id.clone()) {
                    bail!("duplicate client reference id: {reference_id}");
                }
                client_references.push(ClientReference {
                    id: reference_id,
                    module: id.clone(),
                    export,
                    path: relative_path.clone(),
                    browser_chunk: browser_chunk.clone(),
                });
            }
        }
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
                text,
            },
        ) {
            bail!(
                "duplicate module id {id}: {} and {}",
                existing.relative_path.display(),
                relative_path.display()
            );
        }
    }

    let modules_by_path = modules
        .values()
        .map(|module| (module.relative_path.clone(), module))
        .collect::<BTreeMap<_, _>>();
    let client_reference_ids_by_module = client_references.iter().fold(
        BTreeMap::<String, BTreeMap<String, String>>::new(),
        |mut by_module, reference| {
            by_module
                .entry(reference.module.clone())
                .or_default()
                .insert(reference.export.clone(), reference.id.clone());
            by_module
        },
    );
    let layout_by_id = layouts_by_dir
        .values()
        .map(|layout| (layout.id.clone(), layout))
        .collect::<BTreeMap<_, _>>();

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
        let client_references = route_client_references(
            module,
            &layouts,
            &layout_by_id,
            &modules_by_path,
            &client_reference_ids_by_module,
            &app_root,
        )?;
        routes.push(RouteEntry {
            id: id.clone(),
            pattern,
            kind: route_kind,
            source: module.relative_path.clone(),
            layouts,
            module: id,
            methods,
            cache: module.cache.clone(),
            client_references,
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
    client_references.sort_by(|a, b| a.id.cmp(&b.id));
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
        action_proxy: None,
        client_references,
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
    if name.ends_with(".d.ts") || name.ends_with(".d.tsx") {
        return false;
    }
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
    match js_tokens(text).first() {
        Some(JsToken::String(value)) => Some(value.clone()),
        _ => None,
    }
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

fn route_client_references(
    route_module: &SourceModule,
    layout_ids: &[String],
    layout_by_id: &BTreeMap<String, &LayoutRef>,
    modules_by_path: &BTreeMap<PathBuf, &SourceModule>,
    client_reference_ids_by_module: &BTreeMap<String, BTreeMap<String, String>>,
    app_root: &Path,
) -> Result<Vec<String>> {
    let mut references = BTreeSet::new();
    for layout_id in layout_ids {
        let layout = layout_by_id
            .get(layout_id)
            .with_context(|| format!("missing layout {layout_id}"))?;
        if let Some(module) = modules_by_path.get(&layout.path) {
            collect_imported_client_references(
                module,
                modules_by_path,
                client_reference_ids_by_module,
                app_root,
                &mut references,
            )?;
        }
    }
    collect_imported_client_references(
        route_module,
        modules_by_path,
        client_reference_ids_by_module,
        app_root,
        &mut references,
    )?;
    Ok(references.into_iter().collect())
}

fn collect_imported_client_references(
    module: &SourceModule,
    modules_by_path: &BTreeMap<PathBuf, &SourceModule>,
    client_reference_ids_by_module: &BTreeMap<String, BTreeMap<String, String>>,
    app_root: &Path,
    references: &mut BTreeSet<String>,
) -> Result<()> {
    for import in static_imports(&module.text) {
        if !(import.specifier.starts_with('.') || import.specifier.starts_with('/')) {
            continue;
        }
        let importer = app_root.join(&module.relative_path);
        let imported_path =
            resolve_local_specifier(&importer, &import.specifier).with_context(|| {
                format!(
                    "resolve client import {:?} from {}",
                    import.specifier,
                    module.relative_path.display()
                )
            })?;
        let imported_path = imported_path
            .canonicalize()
            .with_context(|| format!("canonicalize {}", imported_path.display()))?;
        let relative_imported_path = imported_path.strip_prefix(app_root).with_context(|| {
            format!(
                "resolved import {} outside app root {}",
                imported_path.display(),
                app_root.display()
            )
        })?;
        let Some(imported_module) = modules_by_path.get(relative_imported_path) else {
            continue;
        };
        if imported_module.kind != ModuleKind::Client {
            continue;
        }
        let Some(exports) = client_reference_ids_by_module.get(&imported_module.id) else {
            bail!(
                "client module {} has no client references",
                imported_module.relative_path.display()
            );
        };
        match import.selection {
            ImportSelection::All => references.extend(exports.values().cloned()),
            ImportSelection::Exports(names) => {
                for name in names {
                    let Some(reference) = exports.get(&name) else {
                        bail!(
                            "client import {} from {} references missing export {name}",
                            import.specifier,
                            module.relative_path.display()
                        );
                    };
                    references.insert(reference.clone());
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StaticImport {
    specifier: String,
    selection: ImportSelection,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ImportSelection {
    All,
    Exports(BTreeSet<String>),
}

fn static_imports(text: &str) -> Vec<StaticImport> {
    let tokens = js_tokens(text);
    let mut imports = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if !matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "import") {
            index += 1;
            continue;
        }
        match tokens.get(index + 1) {
            Some(JsToken::String(specifier)) => {
                imports.push(StaticImport {
                    specifier: specifier.clone(),
                    selection: ImportSelection::All,
                });
            }
            Some(JsToken::Ident(kind)) if kind == "type" => {}
            Some(JsToken::Punct('(')) => {}
            _ => {
                if let Some((specifier, specifier_index)) =
                    following_from_specifier(&tokens, index + 1)
                {
                    imports.push(StaticImport {
                        specifier,
                        selection: import_selection(
                            &tokens,
                            index + 1,
                            specifier_index.saturating_sub(1),
                        ),
                    });
                    index = specifier_index;
                }
            }
        }
        index += 1;
    }
    imports
}

fn import_selection(tokens: &[JsToken], start: usize, from_index: usize) -> ImportSelection {
    if tokens[start..from_index]
        .iter()
        .any(|token| matches!(token, JsToken::Punct('*')))
    {
        return ImportSelection::All;
    }
    let mut names = BTreeSet::new();
    let mut cursor = start;
    if matches!(tokens.get(cursor), Some(JsToken::Ident(value)) if value != "type") {
        names.insert("default".into());
        cursor += 1;
    }
    while cursor < from_index {
        if matches!(tokens.get(cursor), Some(JsToken::Punct('{'))) {
            for name in imported_named_specifiers(tokens, cursor) {
                names.insert(name);
            }
            break;
        }
        cursor += 1;
    }
    if names.is_empty() {
        ImportSelection::All
    } else {
        ImportSelection::Exports(names)
    }
}

fn imported_named_specifiers(tokens: &[JsToken], open_brace: usize) -> Vec<String> {
    let mut names = Vec::new();
    let mut index = open_brace + 1;
    while index < tokens.len() {
        match tokens.get(index) {
            Some(JsToken::Punct('}')) => return names,
            Some(JsToken::Ident(value)) if value == "type" => {
                index += 1;
                while !matches!(tokens.get(index), Some(JsToken::Punct(',' | '}')) | None) {
                    index += 1;
                }
                continue;
            }
            Some(JsToken::Ident(local)) | Some(JsToken::String(local)) => {
                names.push(local.clone());
                if matches!(tokens.get(index + 1), Some(JsToken::Ident(value)) if value == "as") {
                    index += 2;
                }
            }
            _ => {}
        }
        index += 1;
    }
    names
}

fn parse_cache_policy(text: &str) -> Result<CachePolicy> {
    let mut policy = CachePolicy::default();
    for (name, value) in exported_const_values(text) {
        match (name.as_str(), value) {
            ("dynamic", JsToken::String(value)) => {
                policy.dynamic = match value.as_str() {
                    "auto" => DynamicPolicy::Auto,
                    "force-static" => DynamicPolicy::ForceStatic,
                    "force-dynamic" => DynamicPolicy::ForceDynamic,
                    other => bail!("invalid dynamic value: {other}"),
                };
            }
            ("revalidate", JsToken::Ident(value)) if value == "false" => {
                policy.revalidate_seconds = None;
            }
            ("revalidate", JsToken::Number(value)) => {
                policy.revalidate_seconds = Some(
                    value
                        .parse::<u64>()
                        .with_context(|| format!("invalid revalidate value: {value}"))?,
                );
            }
            ("revalidate", value) => bail!("invalid revalidate value: {value:?}"),
            _ => {}
        }
    }
    if policy.dynamic == DynamicPolicy::ForceDynamic && policy.revalidate_seconds.is_some() {
        bail!("force-dynamic routes cannot declare revalidate");
    }
    Ok(policy)
}

fn exported_const_values(text: &str) -> Vec<(String, JsToken)> {
    let tokens = js_tokens(text);
    let local_consts = const_values(&tokens);
    let mut values = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if !matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "export") {
            index += 1;
            continue;
        }
        match tokens.get(index + 1) {
            Some(JsToken::Ident(value)) if value == "const" => {
                let Some(JsToken::Ident(name)) = tokens.get(index + 2) else {
                    index += 1;
                    continue;
                };
                let Some(assignment) = assignment_operator_after_binding(&tokens, index + 3) else {
                    index += 1;
                    continue;
                };
                if let Some(value) = tokens.get(assignment + 1) {
                    values.push((name.clone(), value.clone()));
                }
                index = assignment + 2;
                continue;
            }
            Some(JsToken::Punct('{')) if !export_list_has_from_clause(&tokens, index + 1) => {
                for (local, exported) in exported_named_specifier_pairs(&tokens, index + 1) {
                    if let Some(value) = local_consts.get(&local) {
                        values.push((exported, value.clone()));
                    }
                }
            }
            _ => {}
        }
        index += 1;
    }
    values
}

fn const_values(tokens: &[JsToken]) -> BTreeMap<String, JsToken> {
    let mut values = BTreeMap::new();
    let mut index = 0;
    while index < tokens.len() {
        if !matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "const") {
            index += 1;
            continue;
        }
        let Some(JsToken::Ident(name)) = tokens.get(index + 1) else {
            index += 1;
            continue;
        };
        let Some(assignment) = assignment_operator_after_binding(tokens, index + 2) else {
            index += 1;
            continue;
        };
        if let Some(value) = tokens.get(assignment + 1) {
            values.insert(name.clone(), value.clone());
        }
        index = assignment + 2;
    }
    values
}

fn route_handler_methods(text: &str) -> Result<Vec<String>> {
    const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
    let mut found = BTreeSet::new();
    for name in exported_callable_names(text) {
        if METHODS.contains(&name.as_str()) {
            found.insert(name);
        }
    }
    if found.contains("GET") {
        found.insert("HEAD".into());
    }
    Ok(found.into_iter().collect())
}

fn server_action_exports(text: &str) -> Result<Vec<String>> {
    let mut names = BTreeSet::new();
    for name in exported_callable_names(text) {
        if !is_valid_named_export(&name) {
            bail!("invalid server action export name: {name}");
        }
        names.insert(name);
    }
    Ok(names.into_iter().collect())
}

fn client_reference_exports(text: &str) -> Result<Vec<String>> {
    let mut names = BTreeSet::new();
    for name in exported_value_names(text) {
        if name != "default" && !is_valid_named_export(&name) {
            bail!("invalid client reference export name: {name}");
        }
        names.insert(name);
    }
    Ok(names.into_iter().collect())
}

fn is_valid_named_export(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn exported_value_names(text: &str) -> Vec<String> {
    let tokens = js_tokens(text);
    let local_values = value_bindings(&tokens);
    let mut names = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if !matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "export") {
            index += 1;
            continue;
        }
        index += 1;
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "type") {
            index += 1;
            continue;
        }
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "default") {
            names.push("default".into());
            index += 1;
            continue;
        }
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "async") {
            index += 1;
        }
        match tokens.get(index) {
            Some(JsToken::Ident(value)) if matches!(value.as_str(), "function" | "class") => {
                if let Some(JsToken::Ident(name)) = tokens.get(index + 1) {
                    names.push(name.clone());
                }
            }
            Some(JsToken::Ident(value)) if matches!(value.as_str(), "const" | "let" | "var") => {
                if let Some(JsToken::Ident(name)) = tokens.get(index + 1) {
                    names.push(name.clone());
                }
            }
            Some(JsToken::Punct('{')) if !export_list_has_from_clause(&tokens, index) => {
                for (local, exported) in exported_named_specifier_pairs(&tokens, index) {
                    if local_values.contains(&local) {
                        names.push(exported);
                    }
                }
            }
            _ => {}
        }
        index += 1;
    }
    names
}

fn exported_callable_names(text: &str) -> Vec<String> {
    let tokens = js_tokens(text);
    let local_callables = callable_values(&tokens);
    let mut names = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if !matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "export") {
            index += 1;
            continue;
        }
        index += 1;
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "type") {
            index += 1;
            continue;
        }
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "async") {
            index += 1;
        }
        match tokens.get(index) {
            Some(JsToken::Ident(value)) if value == "function" => {
                if let Some(JsToken::Ident(name)) = tokens.get(index + 1) {
                    names.push(name.clone());
                }
            }
            Some(JsToken::Ident(value)) if matches!(value.as_str(), "const" | "let" | "var") => {
                if let Some(JsToken::Ident(name)) = tokens.get(index + 1) {
                    if is_callable_assignment(&tokens, index + 2) {
                        names.push(name.clone());
                    }
                }
            }
            Some(JsToken::Punct('{')) if !export_list_has_from_clause(&tokens, index) => {
                for (local, exported) in exported_named_specifier_pairs(&tokens, index) {
                    if local_callables.contains(&local) {
                        names.push(exported);
                    }
                }
            }
            _ => {}
        }
        index += 1;
    }
    names
}

fn callable_values(tokens: &[JsToken]) -> BTreeSet<String> {
    let mut values = BTreeSet::new();
    let mut index = 0;
    while index < tokens.len() {
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "async") {
            if matches!(tokens.get(index + 1), Some(JsToken::Ident(value)) if value == "function") {
                if let Some(JsToken::Ident(name)) = tokens.get(index + 2) {
                    values.insert(name.clone());
                }
            }
            index += 1;
            continue;
        }
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "function") {
            if let Some(JsToken::Ident(name)) = tokens.get(index + 1) {
                values.insert(name.clone());
            }
            index += 1;
            continue;
        }
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if matches!(value.as_str(), "const" | "let" | "var"))
        {
            if let Some(JsToken::Ident(name)) = tokens.get(index + 1) {
                if is_callable_assignment(tokens, index + 2) {
                    values.insert(name.clone());
                }
            }
        }
        index += 1;
    }
    values
}

fn value_bindings(tokens: &[JsToken]) -> BTreeSet<String> {
    let mut values = BTreeSet::new();
    let mut index = 0;
    while index < tokens.len() {
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if value == "async") {
            if matches!(tokens.get(index + 1), Some(JsToken::Ident(value)) if value == "function") {
                if let Some(JsToken::Ident(name)) = tokens.get(index + 2) {
                    values.insert(name.clone());
                }
            }
            index += 1;
            continue;
        }
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if matches!(value.as_str(), "function" | "class"))
        {
            if let Some(JsToken::Ident(name)) = tokens.get(index + 1) {
                values.insert(name.clone());
            }
            index += 1;
            continue;
        }
        if matches!(tokens.get(index), Some(JsToken::Ident(value)) if matches!(value.as_str(), "const" | "let" | "var"))
        {
            if let Some(JsToken::Ident(name)) = tokens.get(index + 1) {
                values.insert(name.clone());
            }
        }
        index += 1;
    }
    values
}

fn is_callable_assignment(tokens: &[JsToken], index: usize) -> bool {
    let Some(assignment) = assignment_operator_after_binding(tokens, index) else {
        return false;
    };
    let mut value_index = assignment + 1;
    if matches!(tokens.get(value_index), Some(JsToken::Ident(value)) if value == "async") {
        value_index += 1;
    }
    matches!(tokens.get(value_index), Some(JsToken::Ident(value)) if value == "function")
        || is_arrow_function_assignment(tokens, value_index)
}

fn assignment_operator_after_binding(tokens: &[JsToken], index: usize) -> Option<usize> {
    match tokens.get(index) {
        Some(JsToken::Punct('=')) => Some(index),
        Some(JsToken::Punct(':')) => {
            let mut angle_depth = 0usize;
            let mut paren_depth = 0usize;
            let mut bracket_depth = 0usize;
            let mut brace_depth = 0usize;
            for cursor in index + 1..tokens.len() {
                match tokens.get(cursor) {
                    Some(JsToken::Punct('<')) => angle_depth += 1,
                    Some(JsToken::Punct('>')) => angle_depth = angle_depth.saturating_sub(1),
                    Some(JsToken::Punct('(')) => paren_depth += 1,
                    Some(JsToken::Punct(')')) => paren_depth = paren_depth.saturating_sub(1),
                    Some(JsToken::Punct('[')) => bracket_depth += 1,
                    Some(JsToken::Punct(']')) => bracket_depth = bracket_depth.saturating_sub(1),
                    Some(JsToken::Punct('{')) => brace_depth += 1,
                    Some(JsToken::Punct('}')) => brace_depth = brace_depth.saturating_sub(1),
                    Some(JsToken::Punct('='))
                        if angle_depth == 0
                            && paren_depth == 0
                            && bracket_depth == 0
                            && brace_depth == 0
                            && !matches!(tokens.get(cursor + 1), Some(JsToken::Punct('>'))) =>
                    {
                        return Some(cursor);
                    }
                    Some(JsToken::Punct(',' | ';'))
                        if angle_depth == 0
                            && paren_depth == 0
                            && bracket_depth == 0
                            && brace_depth == 0 =>
                    {
                        return None;
                    }
                    _ => {}
                }
            }
            None
        }
        _ => None,
    }
}

fn is_arrow_function_assignment(tokens: &[JsToken], index: usize) -> bool {
    match tokens.get(index) {
        Some(JsToken::Ident(_)) => {
            matches!(tokens.get(index + 1), Some(JsToken::Punct('=')))
                && matches!(tokens.get(index + 2), Some(JsToken::Punct('>')))
        }
        Some(JsToken::Punct('(')) => {
            let mut depth = 0usize;
            for cursor in index..tokens.len() {
                match tokens.get(cursor) {
                    Some(JsToken::Punct('(')) => depth += 1,
                    Some(JsToken::Punct(')')) => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            return matches!(tokens.get(cursor + 1), Some(JsToken::Punct('=')))
                                && matches!(tokens.get(cursor + 2), Some(JsToken::Punct('>')));
                        }
                    }
                    _ => {}
                }
            }
            false
        }
        _ => false,
    }
}

fn export_list_has_from_clause(tokens: &[JsToken], open_brace: usize) -> bool {
    let mut depth = 0usize;
    for index in open_brace..tokens.len() {
        match tokens.get(index) {
            Some(JsToken::Punct('{')) => depth += 1,
            Some(JsToken::Punct('}')) => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return matches!(tokens.get(index + 1), Some(JsToken::Ident(value)) if value == "from");
                }
            }
            _ => {}
        }
    }
    false
}

fn exported_named_specifier_pairs(tokens: &[JsToken], open_brace: usize) -> Vec<(String, String)> {
    let mut names = Vec::new();
    let mut index = open_brace + 1;
    while index < tokens.len() {
        match tokens.get(index) {
            Some(JsToken::Punct('}')) => return names,
            Some(JsToken::Ident(value)) if value == "type" => {
                index += 1;
            }
            Some(JsToken::Ident(local)) | Some(JsToken::String(local)) => {
                let mut exported = local.clone();
                if matches!(tokens.get(index + 1), Some(JsToken::Ident(value)) if value == "as") {
                    if let Some(JsToken::Ident(alias) | JsToken::String(alias)) =
                        tokens.get(index + 2)
                    {
                        exported = alias.clone();
                        index += 2;
                    }
                }
                names.push((local.clone(), exported));
            }
            _ => {}
        }
        index += 1;
    }
    names
}

fn stable_action_id(path: &Path, export: &str) -> String {
    format!("action:{}#{}", module_id(path), export)
}

fn stable_client_reference_id(path: &Path, export: &str) -> String {
    format!("client:{}#{}", module_id(path), export)
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
    use http::Method;
    use std::fs;
    use zap_render::Renderer;
    use zap_runtime::request::{plan_action, plan_request};

    fn write_react_runtime(root: &Path) -> Vec<(String, String)> {
        let react = root.join("third_party/react");
        let react_dom = root.join("third_party/react-dom");
        fs::create_dir_all(&react).unwrap();
        fs::create_dir_all(&react_dom).unwrap();
        fs::write(
            react.join("jsx-runtime.js"),
            r#"
            export function jsx(type, props) {
                return { type, props: props || {} };
            }
            export const jsxs = jsx;
            export const Fragment = Symbol.for("react.fragment");
            "#,
        )
        .unwrap();
        fs::write(
            react_dom.join("server.browser.js"),
            r#"
            function escapeText(value) {
                return String(value).replace(/[&<>"]/g, (match) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;'}[match]));
            }
            function renderTree(tree) {
                if (tree == null || tree === false || tree === true) return "";
                if (typeof tree === "string" || typeof tree === "number" || typeof tree === "bigint") return escapeText(tree);
                if (Array.isArray(tree)) return tree.map(renderTree).join("");
                if (typeof tree.type === "function") return renderTree(tree.type(tree.props || {}));
                const props = tree.props || {};
                const attrs = Object.keys(props)
                    .filter((key) => key !== "children" && props[key] != null && props[key] !== false)
                    .map((key) => props[key] === true ? ` ${key}` : ` ${key}="${escapeText(props[key])}"`)
                    .join("");
                return `<${tree.type}${attrs}>${renderTree(props.children)}</${tree.type}>`;
            }
            export function renderToReadableStream(tree) {
                return new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(renderTree(tree)));
                        controller.close();
                    }
                });
            }
            "#,
        )
        .unwrap();
        vec![
            ("react".into(), react.to_string_lossy().into_owned()),
            ("react-dom".into(), react_dom.to_string_lossy().into_owned()),
        ]
    }

    fn write_fixture(root: &Path) -> Vec<(String, String)> {
        let aliases = write_react_runtime(root);
        fs::write(
            root.join("entry.tsx"),
            r#"
            const name: string = "Zap";
            export const view = <main data-framework={name}>Hello {name}</main>;
            "#,
        )
        .unwrap();
        aliases
    }

    #[test]
    fn static_imports_capture_client_reference_exports() {
        let imports = static_imports(
            "import DefaultCounter from './counter';
import { Renamed, type Ignored } from '../../counter';
import * as CounterModule from '../counter';
import './side-effect';
const lazy = import('./lazy');
",
        );
        let selected = |exports: &[&str]| {
            ImportSelection::Exports(exports.iter().map(|value| (*value).to_string()).collect())
        };
        assert_eq!(
            imports,
            vec![
                StaticImport {
                    specifier: "./counter".into(),
                    selection: selected(&["default"]),
                },
                StaticImport {
                    specifier: "../../counter".into(),
                    selection: selected(&["Renamed"]),
                },
                StaticImport {
                    specifier: "../counter".into(),
                    selection: ImportSelection::All,
                },
                StaticImport {
                    specifier: "./side-effect".into(),
                    selection: ImportSelection::All,
                },
            ]
        );
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
            concat!(
                "import DefaultCounter from './counter';
",
                "export default function Layout(){ return DefaultCounter; }
",
            ),
        )
        .unwrap();
        fs::write(
            app.join("dashboard/layout.tsx"),
            "export default function DashboardLayout(){}\n",
        )
        .unwrap();
        fs::write(
            app.join("dashboard/[id]/page.tsx"),
            concat!(
                "import { Renamed } from '../../counter';
",
                "export const dynamic = 'force-static';
",
                "export const revalidate = 60;
",
                "export default function Page(){ return Renamed; }
",
            ),
        )
        .unwrap();
        fs::write(app.join("api/echo/route.ts"), "export function POST(){}\n").unwrap();
        fs::write(
            app.join("counter.tsx"),
            concat!(
                "/* copyright */
",
                "'use client';
",
                "export function Counter(){}
",
                "const Inner = () => null;
",
                "export { Inner as Renamed };
",
                "export default function DefaultCounter(){}
",
            ),
        )
        .unwrap();
        fs::write(
            app.join("actions.ts"),
            "// generated action module\n'use server';\nexport async function save(){}\nexport const remove = async () => {};\n",
        )
        .unwrap();
        fs::write(app.join("types.d.ts"), "export interface Ignored {}\n").unwrap();
        fs::write(
            app.join("types.ts"),
            "export type PageProps = { id: string };\n",
        )
        .unwrap();
        fs::write(
            app.join("helper.ts"),
            "export function helper() { return 'helper'; }\n",
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
        assert_eq!(
            page.client_references,
            vec!["client:counter#Renamed", "client:counter#default"]
        );

        let handler = graph
            .routes
            .iter()
            .find(|route| route.pattern == "/api/echo")
            .unwrap();
        assert_eq!(handler.kind, RouteKind::Handler);
        assert_eq!(handler.methods, vec!["POST"]);

        assert!(graph.modules.iter().all(|module| module.id != "types.d"));
        assert!(graph.modules.iter().all(|module| module.id != "types"));
        assert!(graph.modules.iter().all(|module| module.id != "helper"));
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
        let client_reference_ids = graph
            .client_references
            .iter()
            .map(|reference| reference.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            client_reference_ids,
            vec![
                "client:counter#Counter",
                "client:counter#Renamed",
                "client:counter#default"
            ]
        );
        let default_reference = graph
            .client_references
            .iter()
            .find(|reference| reference.export == "default")
            .unwrap();
        assert_eq!(default_reference.module, "counter");
        assert_eq!(default_reference.path, Path::new("counter.tsx"));
        assert_eq!(
            default_reference.browser_chunk.as_path(),
            Path::new(".zap/browser/counter.js")
        );

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

        fs::write(
            app.join("page.tsx"),
            "export const dynamic = 'force-dynamic';
export const revalidate = 60;
export default function Page(){}
",
        )
        .unwrap();
        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("force-dynamic routes cannot declare revalidate"),
            "{error}"
        );

        fs::write(
            app.join("page.tsx"),
            "export const dynamic =
  'force-dynamic';
export const revalidate =
  60;
export default function Page(){}
",
        )
        .unwrap();
        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("force-dynamic routes cannot declare revalidate"),
            "{error}"
        );

        fs::write(
            app.join("page.tsx"),
            "export const revalidate =
  seconds;
export default function Page(){}
",
        )
        .unwrap();
        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("invalid revalidate value"), "{error}");

        fs::write(
            app.join("page.tsx"),
            "const mode: 'force-static' = 'force-static';
const seconds: number = 45;
export { mode as dynamic, seconds as revalidate };
export default function Page(){}
",
        )
        .unwrap();
        let graph = build_application_graph(&GraphOptions::new(temp.path())).unwrap();
        assert_eq!(graph.routes[0].cache.dynamic, DynamicPolicy::ForceStatic);
        assert_eq!(graph.routes[0].cache.revalidate_seconds, Some(45));

        fs::write(
            app.join("page.tsx"),
            "export { dynamic } from './cache';
export default function Page(){}
",
        )
        .unwrap();
        let graph = build_application_graph(&GraphOptions::new(temp.path())).unwrap();
        assert_eq!(graph.routes[0].cache, CachePolicy::default());
    }

    #[test]
    fn application_graph_rejects_unsafe_route_segments() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        fs::create_dir_all(app.join("bad segment")).unwrap();
        fs::write(
            app.join("bad segment/page.tsx"),
            "export default function Page(){}
",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("invalid route pattern"), "{error}");
    }

    #[test]
    fn application_graph_rejects_unsafe_public_asset_paths() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(temp.path().join("public/images")).unwrap();
        fs::write(
            app.join("page.tsx"),
            "export default function Page(){}
",
        )
        .unwrap();
        fs::write(
            temp.path().join("public/images/logo mark.svg"),
            "<svg/>
",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("asset URL path must be absolute and safe"),
            "{error}"
        );
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
            "export { GET } from './methods';
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

        fs::write(
            app.join("route.ts"),
            "export const GET = 1;
export const POST = { handler: true };
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
            "const getHandler: Handler = () => new Response('ok');
export { getHandler as GET };
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
            "/* generated */
'use server';
export { save } from './impl';
",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("must export at least one"), "{error}");

        fs::write(
            app.join("actions.ts"),
            "/* generated */
'use server';
const hidden = 1;
",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("must export at least one callable action"),
            "{error}"
        );

        fs::write(
            app.join("actions.ts"),
            "/* generated */
'use server';
export const meaning = 42;
export const config = { mutate: true };
",
        )
        .unwrap();

        let error = build_application_graph(&GraphOptions::new(temp.path()))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("must export at least one callable action"),
            "{error}"
        );

        fs::write(
            app.join("actions.ts"),
            "/* generated */
'use server';
export async
function save(){}
const destroy: Action = async () => {};
const archive: Action = function() {};
export const
remove: Action = async () => {};
export let rename: (input: Input) => Output = input => input;
export { destroy as deleteItem, archive };
export type { IgnoredAction };
",
        )
        .unwrap();
        let graph = build_application_graph(&GraphOptions::new(temp.path())).unwrap();
        let exports: Vec<_> = graph
            .actions
            .iter()
            .map(|action| action.export.clone())
            .collect();
        assert_eq!(
            exports,
            vec!["archive", "deleteItem", "remove", "rename", "save"]
        );
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
            "import { Counter } from './client';
export const dynamic = 'force-dynamic';
export default function Page(request){ return <main data-path={request.path}>home:{request.path}</main>; }
",
        )
        .unwrap();
        fs::write(
            app.join("client.tsx"),
            "'use client';
export function Counter(){ return '1'; }
export const Label = 'count';
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
        fs::write(
            app.join("types.ts"),
            "export type PageProps = { id: string };\n",
        )
        .unwrap();
        fs::write(
            app.join("helper.ts"),
            "export function helper() { return 'helper'; }\n",
        )
        .unwrap();

        let mut options = ApplicationBuildOptions::new(temp.path());
        options.aliases = write_react_runtime(temp.path());
        options.minify = false;
        let output = build_application(&options).await.unwrap();

        assert!(output.manifest.ends_with(Path::new(".zap/manifest.json")));
        assert!(output.manifest.is_file());
        let manifest = fs::read_to_string(&output.manifest).unwrap();
        assert!(manifest.contains("ForceDynamic"));
        assert!(manifest.contains(".zap/server/page.js"));
        assert!(manifest.contains(".zap/browser/actions.js"));
        let compiled = CompiledManifest::load(&output.manifest).unwrap();
        let matched = compiled.resolve("/").unwrap().unwrap();
        assert_eq!(matched.route.module, "page");
        let hydration = compiled.route_hydration(matched.route).unwrap();
        assert_eq!(
            hydration.browser_chunks,
            vec![
                PathBuf::from(".zap/browser/actions.js"),
                PathBuf::from(".zap/browser/client.js")
            ]
        );
        assert_eq!(
            hydration
                .client_references
                .iter()
                .map(|reference| reference.id.as_str())
                .collect::<Vec<_>>(),
            vec!["client:client#Counter"]
        );
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
        let action_proxy = temp.path().join(".zap/browser/actions.js");
        let output_action_proxy = output.action_proxy.as_deref().unwrap();
        assert!(output_action_proxy.ends_with(Path::new(".zap/browser/actions.js")));
        assert_eq!(
            output.graph.action_proxy.as_deref(),
            Some(Path::new(".zap/browser/actions.js"))
        );
        assert_eq!(
            compiled.action_proxy(),
            Some(Path::new(".zap/browser/actions.js"))
        );
        assert!(page_bundle.is_file());
        assert!(route_bundle.is_file());
        assert!(get_route_bundle.is_file());
        assert!(action_bundle.is_file());
        assert!(action_proxy.is_file());
        let action_proxy_source = fs::read_to_string(&action_proxy).unwrap();
        assert!(action_proxy_source.contains("action:actions#save"));
        assert!(action_proxy_source.contains("export async function invokeAction"));
        assert!(action_proxy_source.contains("/_zap/action"));
        assert!(action_proxy_source.contains("action_id: resolved.id"));
        assert!(
            action_proxy_source.contains("credentials: options.credentials || \"same-origin\"")
        );
        assert!(!temp.path().join(".zap/server/client.js").exists());
        assert!(temp.path().join(".zap/browser/client.js").is_file());
        assert_eq!(compiled.manifest().client_references.len(), 2);
        assert_eq!(
            compiled
                .client_reference("client:client#Counter")
                .unwrap()
                .browser_chunk,
            PathBuf::from(".zap/browser/client.js")
        );
        assert_eq!(
            compiled
                .client_reference("client:client#Label")
                .unwrap()
                .export,
            "Label"
        );
        assert!(temp.path().join(".zap/entries/server/page.js").is_file());
        assert!(
            temp.path()
                .join(".zap/entries/server/api/echo/route.js")
                .is_file()
        );
        assert!(temp.path().join(".zap/entries/server/actions.js").is_file());
        assert!(!temp.path().join(".zap/server/types.js").exists());
        assert!(!temp.path().join(".zap/server/helper.js").exists());
        assert!(!temp.path().join(".zap/entries/server/types.js").exists());
        assert!(!temp.path().join(".zap/entries/server/helper.js").exists());
        let page_request = plan_request(&compiled, &Method::GET, "/")
            .unwrap()
            .renderer_request_json("/")
            .unwrap()
            .unwrap();
        let rendered = Renderer::new(fs::read_to_string(page_bundle).unwrap())
            .render(&page_request)
            .unwrap();
        assert_eq!(rendered, r#"<main data-path="/">home:/</main>"#);
        let route_request = plan_request(&compiled, &Method::POST, "/api/echo")
            .unwrap()
            .renderer_request_json("/api/echo")
            .unwrap()
            .unwrap();
        let handled = Renderer::new(fs::read_to_string(route_bundle).unwrap())
            .handle_route_response(&route_request)
            .unwrap();
        assert_eq!(handled.status, 202);
        assert_eq!(handled.headers, vec![("x-zap-route".into(), "echo".into())]);
        assert_eq!(handled.body, "echo:POST:/api/echo");
        let head_request = plan_request(&compiled, &Method::HEAD, "/api/ping")
            .unwrap()
            .renderer_request_json("/api/ping")
            .unwrap()
            .unwrap();
        let head = Renderer::new(fs::read_to_string(get_route_bundle).unwrap())
            .handle_route_response(&head_request)
            .unwrap();
        assert_eq!(head.status, 200);
        assert_eq!(head.headers, vec![("x-zap-route".into(), "ping".into())]);
        assert_eq!(head.body, "ping:HEAD:/api/ping");
        let action_request = plan_action(
            &compiled,
            &Method::POST,
            "action:actions#save",
            Some("https://example.com"),
            Some("https://example.com"),
        )
        .unwrap()
        .target
        .invocation
        .json(vec![serde_json::json!({"id": 7})])
        .unwrap();
        let action = Renderer::new(fs::read_to_string(action_bundle).unwrap())
            .invoke_action_response(&action_request)
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
        let cases = [
            (
                "platform_scheme.ts",
                concat!(
                    "import fs from '",
                    "no",
                    "de:fs'; export const value = fs.readFileSync;"
                ),
            ),
            (
                "bare_builtin.ts",
                "import fs from 'fs'; export const value = fs.readFileSync;",
            ),
            (
                "type_only_platform_builtin.ts",
                "import type { Stats } from 'fs'; export const value = 1 as number;",
            ),
            (
                "builtin_subpath.ts",
                "import { readFile } from 'fs/promises'; export const value = readFile;",
            ),
            (
                "dynamic_import.ts",
                "export async function load(){ return import('child_process'); }",
            ),
            (
                "commonjs_require.ts",
                "const os = require('os'); export const value = os.platform;",
            ),
            (
                "multiline_import.ts",
                "import {\n  readFile\n} from\n  'fs/promises'; export const value = readFile;",
            ),
            (
                "multiline_export.ts",
                concat!("export { readFile }\nfrom\n'", "no", "de:fs';"),
            ),
            (
                "spaced_dynamic_import.ts",
                "export async function load(){ return import (\n  'worker_threads'\n); }",
            ),
            (
                "template_dynamic_import.ts",
                "export async function load(){ return import(`fs/promises`); }",
            ),
            (
                "computed_dynamic_import.ts",
                "export async function load(name){ return import(name); }",
            ),
            (
                "concatenated_dynamic_import.ts",
                "export async function load(){ return import('f' + 's'); }",
            ),
            (
                "template_expr_dynamic_import.ts",
                "export async function load(name){ return import(`${name}`); }",
            ),
            (
                "spaced_commonjs_require.ts",
                "const vm = require (\n  'vm'\n); export const value = vm;",
            ),
            (
                "template_require.ts",
                concat!(
                    "const mod = require(`",
                    "no",
                    "de:module`); export const value = mod;"
                ),
            ),
            (
                "require_resolve.ts",
                "export const value = require.resolve('fs');",
            ),
            (
                "process_env.ts",
                "export const value = process.env.NODE_ENV;",
            ),
            (
                "division_process.ts",
                "export const value = 1 / process.pid;",
            ),
            (
                "buffer_global.ts",
                "export const value = Buffer.from('zap');",
            ),
            (
                "ternary_process.ts",
                "const enabled = true; export const value = enabled ? process : null;",
            ),
            (
                "global_bracket_process.ts",
                "export const value = globalThis['process'];",
            ),
            (
                "optional_chain_process.ts",
                "export const value = globalThis?.process;",
            ),
            (
                "optional_chain_bracket_process.ts",
                "export const value = globalThis?.['process'];",
            ),
            (
                "computed_global_bracket_process.ts",
                "export const value = globalThis['pro' + 'cess'];",
            ),
            (
                "computed_optional_global_bracket_buffer.ts",
                "export const value = globalThis?.['Buf' + 'fer'];",
            ),
            (
                "global_probe_process.ts",
                "export const value = 'process' in globalThis;",
            ),
            (
                "global_destructure_process.ts",
                "const { process } = globalThis; export const value = process;",
            ),
            (
                "global_destructure_alias_buffer.ts",
                "const { Buffer: Bytes } = globalThis; export const value = Bytes;",
            ),
            (
                "module_exports.ts",
                "module.exports = {}; export const value = 1;",
            ),
            ("dirname_global.ts", "export const value = __dirname;"),
        ];
        for (name, source) in cases {
            let temp = tempfile::tempdir().unwrap();
            fs::write(temp.path().join(name), source).unwrap();
            let output = temp.path().join("dist/client.js");
            let error = bundle(&BundleOptions::new(
                temp.path(),
                Path::new(name),
                &output,
                Target::Browser,
            ))
            .await
            .unwrap_err();

            assert!(
                error
                    .to_string()
                    .contains("bundle cannot depend on unavailable platform module")
                    || error
                        .to_string()
                        .contains("bundle cannot depend on unavailable platform global")
                    || error
                        .to_string()
                        .contains("bundle cannot depend on non-static dynamic import"),
                "{name}: {error:?}"
            );
            assert!(!output.exists(), "{name}");
        }

        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("entry.ts"),
            "import './nested/module'; export const value = 1;",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("nested")).unwrap();
        fs::write(
            temp.path().join("nested/module.ts"),
            "import path from 'path'; export const value = path.sep;",
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
                .contains("bundle cannot depend on unavailable platform module"),
            "{error:?}"
        );
        assert!(!output.exists());

        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("entry.ts"),
            "// import fs from 'fs'; process.env.SECRET;\n/* const os = require('os'); Buffer.from('x'); */\nconst text = \"import path from 'path'; process.env.NODE_ENV\"; export const value = text;",
        )
        .unwrap();
        let output = temp.path().join("dist/client.js");
        let result = bundle(&BundleOptions::new(
            temp.path(),
            Path::new("entry.ts"),
            &output,
            Target::Browser,
        ))
        .await
        .unwrap();
        assert_eq!(result.files, vec![output.clone()]);
        assert!(output.is_file());

        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("entry.ts"),
            "import type { Thing } from './types'; import { type Other } from './more-types'; export { type Thing } from './types'; export const value: Thing & Other = 1;",
        )
        .unwrap();
        let output = temp.path().join("dist/client.js");
        let result = bundle(&BundleOptions::new(
            temp.path(),
            Path::new("entry.ts"),
            &output,
            Target::Browser,
        ))
        .await
        .unwrap();
        assert_eq!(result.files, vec![output.clone()]);
        assert!(output.is_file());

        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("entry.ts"),
            "const text = `ignored ${\"import('fs')\"} and ${\"process.env.NODE_ENV\"}`; export const value = text;",
        )
        .unwrap();
        let output = temp.path().join("dist/client.js");
        let result = bundle(&BundleOptions::new(
            temp.path(),
            Path::new("entry.ts"),
            &output,
            Target::Browser,
        ))
        .await
        .unwrap();
        assert_eq!(result.files, vec![output.clone()]);
        assert!(output.is_file());

        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("entry.ts"),
            "const pattern = /process\\.env|Buffer\\.from/; export const value = pattern.test('text');",
        )
        .unwrap();
        let output = temp.path().join("dist/client.js");
        let result = bundle(&BundleOptions::new(
            temp.path(),
            Path::new("entry.ts"),
            &output,
            Target::Browser,
        ))
        .await
        .unwrap();
        assert_eq!(result.files, vec![output.clone()]);
        assert!(output.is_file());

        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("entry.ts"),
            "type Job = { process?: string, Buffer: number }; const data = { process: 'queued', Buffer: 1, require() { return 'local'; } }; export const value = data.process + data.Buffer + data.require();",
        )
        .unwrap();
        let output = temp.path().join("dist/client.js");
        let result = bundle(&BundleOptions::new(
            temp.path(),
            Path::new("entry.ts"),
            &output,
            Target::Browser,
        ))
        .await
        .unwrap();
        assert_eq!(result.files, vec![output.clone()]);
        assert!(output.is_file());

        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("entry.ts"),
            "export const value = globalThis.process;",
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
                .contains("bundle cannot depend on unavailable platform global"),
            "{error:?}"
        );
        assert!(!output.exists());

        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside.ts");
        fs::write(&outside, "export const value = 1;").unwrap();
        fs::create_dir_all(temp.path().join("app")).unwrap();
        fs::write(
            temp.path().join("app/entry.ts"),
            "import '../outside'; export const value = 1;",
        )
        .unwrap();
        let output = temp.path().join("dist/client.js");
        let error = bundle(&BundleOptions::new(
            &temp.path().join("app"),
            Path::new("entry.ts"),
            &output,
            Target::Browser,
        ))
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("escapes bundle root"),
            "{error:?}"
        );
        assert!(!output.exists());
    }
}
