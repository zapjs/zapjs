use serde::{Deserialize, Serialize};
use std::path::Path;
use syn::{Attribute, Fields, FnArg, ItemFn, ItemStruct, Pat, ReturnType, Type, Visibility};
use walkdir::WalkDir;

/// Metadata about an exported function
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedFunction {
    pub name: String,
    pub namespace: Option<String>,
    pub is_async: bool,
    pub params: Vec<ExportedParam>,
    pub return_type: ExportedType,
    pub doc_comments: Vec<String>,
}

/// Group of functions under a namespace
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionNamespace {
    pub name: String,
    pub functions: Vec<ExportedFunction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedParam {
    pub name: String,
    pub ty: ExportedType,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExportedType {
    String,
    Bool,
    I8,
    I16,
    I32,
    I64,
    I128,
    U8,
    U16,
    U32,
    U64,
    U128,
    F32,
    F64,
    Option(Box<ExportedType>),
    Vec(Box<ExportedType>),
    HashMap {
        key: Box<ExportedType>,
        value: Box<ExportedType>,
    },
    Custom {
        name: String,
        generics: Vec<ExportedType>,
    },
    Unit,
    Result {
        ok: Box<ExportedType>,
        err: Box<ExportedType>,
    },
}

/// Metadata about an exported struct
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedStruct {
    pub name: String,
    pub fields: Vec<StructField>,
    pub doc_comments: Vec<String>,
}

/// A field in an exported struct
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructField {
    pub name: String,
    pub ty: ExportedType,
    pub ts_name: Option<String>, // From #[serde(rename = "...")]
    pub optional: bool,
}

impl ExportedType {
    /// Convert Rust type to TypeScript type string
    pub fn to_typescript(&self) -> String {
        match self {
            ExportedType::String => "string".to_string(),
            ExportedType::Bool => "boolean".to_string(),
            ExportedType::I8
            | ExportedType::I16
            | ExportedType::I32
            | ExportedType::I64
            | ExportedType::I128
            | ExportedType::U8
            | ExportedType::U16
            | ExportedType::U32
            | ExportedType::U64
            | ExportedType::U128
            | ExportedType::F32
            | ExportedType::F64 => "number".to_string(),
            ExportedType::Option(inner) => {
                format!("{} | null", inner.to_typescript())
            }
            ExportedType::Vec(inner) => {
                format!("{}[]", inner.to_typescript())
            }
            ExportedType::HashMap { key, value } => {
                format!(
                    "Record<{}, {}>",
                    key.to_typescript(),
                    value.to_typescript()
                )
            }
            ExportedType::Unit => "void".to_string(),
            ExportedType::Result { ok, err } => {
                // Generate union type: T | E
                format!("{} | {}", ok.to_typescript(), err.to_typescript())
            }
            ExportedType::Custom { name, generics } => {
                if generics.is_empty() {
                    name.clone()
                } else {
                    let generic_str = generics
                        .iter()
                        .map(|g| g.to_typescript())
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("{}<{}>", name, generic_str)
                }
            }
        }
    }

    /// Convert parameter name to camelCase
    pub fn to_camel_case(snake_str: &str) -> String {
        let mut result = String::new();
        let mut capitalize_next = false;

        for (i, c) in snake_str.chars().enumerate() {
            if c == '_' {
                capitalize_next = true;
            } else if capitalize_next && i > 0 {
                result.push(c.to_uppercase().next().unwrap());
                capitalize_next = false;
            } else {
                result.push(c);
            }
        }

        result
    }
}

/// Recursively collect custom type names from an ExportedType
fn collect_custom_types(ty: &ExportedType, types: &mut std::collections::HashSet<String>) {
    match ty {
        ExportedType::Custom { name, generics } => {
            types.insert(name.clone());
            for g in generics {
                collect_custom_types(g, types);
            }
        }
        ExportedType::Option(inner) => collect_custom_types(inner, types),
        ExportedType::Vec(inner) => collect_custom_types(inner, types),
        ExportedType::HashMap { key, value } => {
            collect_custom_types(key, types);
            collect_custom_types(value, types);
        }
        ExportedType::Result { ok, err } => {
            collect_custom_types(ok, types);
            collect_custom_types(err, types);
        }
        _ => {}
    }
}

/// Generate TypeScript type definitions
pub fn generate_typescript_definitions(functions: &[ExportedFunction]) -> String {
    let mut output = String::from("// Auto-generated TypeScript definitions\n");
    output.push_str("// DO NOT EDIT MANUALLY\n\n");

    // Collect all custom types used by functions
    let mut custom_types: std::collections::HashSet<String> = std::collections::HashSet::new();
    for func in functions {
        collect_custom_types(&func.return_type, &mut custom_types);
        for param in &func.params {
            collect_custom_types(&param.ty, &mut custom_types);
        }
    }

    let mut sorted_types: Vec<_> = custom_types.into_iter().collect();
    sorted_types.sort();

    // Import types for local usage
    output.push_str("import type {\n");
    for ty in &sorted_types {
        output.push_str(&format!("  {},\n", ty));
    }
    output.push_str("} from './types';\n\n");

    // Re-export all types for convenience
    output.push_str("// Re-export types for consumers\n");
    output.push_str("export * from './types';\n\n");

    // Generate JSDoc and function signatures
    for func in functions {
        // Generate JSDoc comment
        if !func.doc_comments.is_empty() {
            output.push_str("/**\n");
            for comment in &func.doc_comments {
                output.push_str(&format!(" * {}\n", comment));
            }
            output.push_str(" */\n");
        }

        // Generate function signature
        let params = func
            .params
            .iter()
            .map(|p| {
                format!(
                    "{}: {}",
                    ExportedType::to_camel_case(&p.name),
                    p.ty.to_typescript()
                )
            })
            .collect::<Vec<_>>()
            .join(", ");

        let return_type = func.return_type.to_typescript();
        let async_keyword = if func.is_async { "async " } else { "" };

        output.push_str(&format!(
            "export {}function {}({}): Promise<{}>;\n\n",
            async_keyword, &func.name, params, return_type
        ));
    }

    // Generate backend object interface
    output.push_str("export interface ZapBackend {\n");
    for func in functions {
        let params = func
            .params
            .iter()
            .map(|p| {
                format!(
                    "{}: {}",
                    ExportedType::to_camel_case(&p.name),
                    p.ty.to_typescript()
                )
            })
            .collect::<Vec<_>>()
            .join(", ");

        let return_type = func.return_type.to_typescript();

        output.push_str(&format!(
            "  {}({}): Promise<{}>;\n",
            ExportedType::to_camel_case(&func.name),
            params,
            return_type
        ));
    }
    output.push_str("}\n\n");

    // Generate backend export
    output.push_str("export declare const backend: ZapBackend;\n");

    output
}

/// Generate TypeScript runtime bindings (flat style)
pub fn generate_typescript_runtime(functions: &[ExportedFunction]) -> String {
    let mut output = String::from("// Auto-generated TypeScript runtime bindings\n");
    output.push_str("// DO NOT EDIT MANUALLY\n\n");
    output.push_str("import { rpcCall } from './rpc-client';\n");

    // Collect all custom types used by functions
    let mut custom_types: std::collections::HashSet<String> = std::collections::HashSet::new();
    for func in functions {
        collect_custom_types(&func.return_type, &mut custom_types);
        for param in &func.params {
            collect_custom_types(&param.ty, &mut custom_types);
        }
    }

    let mut sorted_types: Vec<_> = custom_types.into_iter().collect();
    sorted_types.sort();

    // Import types for local usage AND re-export for consumers
    output.push_str("import type {\n");
    for ty in &sorted_types {
        output.push_str(&format!("  {},\n", ty));
    }
    output.push_str("} from './types';\n\n");

    // Re-export all types for convenience
    output.push_str("// Re-export types for consumers\n");
    output.push_str("export * from './types';\n\n");

    // Generate backend object
    output.push_str("export const backend = {\n");

    for func in functions {
        let fn_name = ExportedType::to_camel_case(&func.name);
        let rust_name = &func.name;

        // Generate typed parameters
        let typed_params = func
            .params
            .iter()
            .map(|p| {
                let camel = ExportedType::to_camel_case(&p.name);
                let ts_type = p.ty.to_typescript();
                format!("{}: {}", camel, ts_type)
            })
            .collect::<Vec<_>>()
            .join(", ");

        let param_mapping = func
            .params
            .iter()
            .map(|p| {
                let camel = ExportedType::to_camel_case(&p.name);
                format!("{}: {}", p.name, camel)
            })
            .collect::<Vec<_>>()
            .join(", ");

        let return_type = func.return_type.to_typescript();

        output.push_str(&format!(
            r#"  async {}({}): Promise<{}> {{
    return rpcCall<{}>('{}', {{ {} }});
  }},

"#,
            fn_name, typed_params, return_type, return_type, rust_name, param_mapping
        ));
    }

    output.push_str("};\n\n");

    // Generate individual exports with proper types
    for func in functions {
        let fn_name = ExportedType::to_camel_case(&func.name);
        output.push_str(&format!("export const {} = backend.{};\n", fn_name, fn_name));
    }

    output
}

/// Group functions by namespace
pub fn group_by_namespace(functions: &[ExportedFunction]) -> Vec<FunctionNamespace> {
    use std::collections::HashMap;

    let mut groups: HashMap<String, Vec<ExportedFunction>> = HashMap::new();

    for func in functions {
        let ns = func.namespace.clone().unwrap_or_else(|| "default".to_string());
        groups.entry(ns).or_default().push(func.clone());
    }

    groups
        .into_iter()
        .map(|(name, functions)| FunctionNamespace { name, functions })
        .collect()
}

/// Generate namespaced server client (server.users.get() style)
pub fn generate_namespaced_server(functions: &[ExportedFunction]) -> String {
    let mut output = String::from("// Auto-generated server client\n");
    output.push_str("// DO NOT EDIT MANUALLY\n\n");
    output.push_str("import { rpcCall } from './rpc-client';\n");

    // Collect all custom types used by functions
    let mut custom_types: std::collections::HashSet<String> = std::collections::HashSet::new();
    for func in functions {
        collect_custom_types(&func.return_type, &mut custom_types);
        for param in &func.params {
            collect_custom_types(&param.ty, &mut custom_types);
        }
    }

    let mut sorted_types: Vec<_> = custom_types.into_iter().collect();
    sorted_types.sort();

    // Import types for local usage
    output.push_str("import type {\n");
    for ty in &sorted_types {
        output.push_str(&format!("  {},\n", ty));
    }
    output.push_str("} from './types';\n\n");

    // Re-export all types for convenience
    output.push_str("// Re-export types for consumers\n");
    output.push_str("export * from './types';\n\n");

    let namespaces = group_by_namespace(functions);

    // Generate server object with namespaces
    output.push_str("export const server = {\n");

    for ns in &namespaces {
        let ns_name = ExportedType::to_camel_case(&ns.name);
        output.push_str(&format!("  {}: {{\n", ns_name));

        for func in &ns.functions {
            let fn_name = ExportedType::to_camel_case(&func.name);

            // Full RPC name includes namespace
            let rpc_name = match &func.namespace {
                Some(ns) => format!("{}.{}", ns, func.name),
                None => func.name.clone(),
            };

            // Generate typed params
            let typed_params = if func.params.is_empty() {
                String::new()
            } else {
                let params = func
                    .params
                    .iter()
                    .map(|p| {
                        format!(
                            "{}: {}",
                            ExportedType::to_camel_case(&p.name),
                            p.ty.to_typescript()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("params: {{ {} }}", params)
            };

            let return_type = func.return_type.to_typescript();

            // Build RPC call params
            let rpc_params = if func.params.is_empty() {
                "{}".to_string()
            } else {
                let mappings = func
                    .params
                    .iter()
                    .map(|p| {
                        let camel = ExportedType::to_camel_case(&p.name);
                        format!("{}: params.{}", p.name, camel)
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{{ {} }}", mappings)
            };

            output.push_str(&format!(
                "    async {}({}): Promise<{}> {{\n",
                fn_name, typed_params, return_type
            ));
            output.push_str(&format!(
                "      return rpcCall<{}>('{}', {});\n",
                return_type, rpc_name, rpc_params
            ));
            output.push_str("    },\n");
        }

        output.push_str("  },\n");
    }

    output.push_str("} as const;\n\n");

    // Generate types
    output.push_str("export type Server = typeof server;\n");

    output
}

/// Generate TypeScript interfaces from Rust structs
pub fn generate_typescript_interfaces(structs: &[ExportedStruct]) -> String {
    let mut output = String::from("// Auto-generated TypeScript interfaces\n");
    output.push_str("// DO NOT EDIT MANUALLY\n\n");

    for s in structs {
        // Generate JSDoc comment
        if !s.doc_comments.is_empty() {
            output.push_str("/**\n");
            for comment in &s.doc_comments {
                output.push_str(&format!(" * {}\n", comment));
            }
            output.push_str(" */\n");
        }

        output.push_str(&format!("export interface {} {{\n", s.name));

        for field in &s.fields {
            let ts_name = field.ts_name.as_ref().unwrap_or(&field.name);
            let ts_type = field.ty.to_typescript();

            if field.optional {
                output.push_str(&format!("  {}?: {};\n", ts_name, ts_type));
            } else {
                output.push_str(&format!("  {}: {};\n", ts_name, ts_type));
            }
        }

        output.push_str("}\n\n");
    }

    output
}

/// Check if a struct has #[derive(Serialize)] or #[derive(Deserialize)]
fn has_serde_derive(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attr| {
        if attr.path().is_ident("derive") {
            if let syn::Meta::List(meta_list) = &attr.meta {
                let tokens = meta_list.tokens.to_string();
                return tokens.contains("Serialize") || tokens.contains("Deserialize");
            }
        }
        false
    })
}

/// Extract #[serde(rename = "...")] from field attributes
fn extract_serde_rename(attrs: &[Attribute]) -> Option<String> {
    for attr in attrs {
        if attr.path().is_ident("serde") {
            if let syn::Meta::List(meta_list) = &attr.meta {
                let tokens = meta_list.tokens.to_string();
                // Parse rename = "name" pattern
                if let Some(start) = tokens.find("rename") {
                    let rest = &tokens[start..];
                    if let Some(eq_pos) = rest.find('=') {
                        let after_eq = &rest[eq_pos + 1..].trim();
                        // Extract the string value
                        if after_eq.starts_with('"') {
                            if let Some(end_quote) = after_eq[1..].find('"') {
                                return Some(after_eq[1..end_quote + 1].to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Parse a struct item into ExportedStruct
fn parse_struct(item: &ItemStruct) -> Option<ExportedStruct> {
    // Must be pub
    if !matches!(item.vis, Visibility::Public(_)) {
        return None;
    }

    // Must have Serialize derive
    if !has_serde_derive(&item.attrs) {
        return None;
    }

    let name = item.ident.to_string();
    let doc_comments = extract_doc_comments(&item.attrs);

    let fields = match &item.fields {
        Fields::Named(named) => named
            .named
            .iter()
            .filter_map(|field| {
                let field_name = field.ident.as_ref()?.to_string();
                let field_type = parse_type(&field.ty);
                let ts_name = extract_serde_rename(&field.attrs);

                // Check if the type is Option<T>
                let optional = matches!(&field_type, ExportedType::Option(_));

                Some(StructField {
                    name: field_name,
                    ty: field_type,
                    ts_name,
                    optional,
                })
            })
            .collect(),
        _ => return None, // Only support named structs
    };

    Some(ExportedStruct {
        name,
        fields,
        doc_comments,
    })
}

/// Find all serializable structs in Rust source files
pub fn find_exported_structs(project_dir: &Path) -> anyhow::Result<Vec<ExportedStruct>> {
    let mut structs = Vec::new();

    // Look for server/src directory first (standard ZapJS project structure)
    let server_src = project_dir.join("server").join("src");
    let search_dir = if server_src.exists() {
        server_src
    } else {
        project_dir.to_path_buf()
    };

    for entry in WalkDir::new(&search_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "rs"))
    {
        let content = std::fs::read_to_string(entry.path())?;

        // Parse the file
        let syntax = match syn::parse_file(&content) {
            Ok(syntax) => syntax,
            Err(_) => continue,
        };

        // Find all structs with #[derive(Serialize)]
        for item in syntax.items {
            if let syn::Item::Struct(s) = item {
                if let Some(exported) = parse_struct(&s) {
                    eprintln!(
                        "Found serializable struct: {} in {}",
                        exported.name,
                        entry.path().display()
                    );
                    structs.push(exported);
                }
            }
        }
    }

    Ok(structs)
}

/// Check if a function has the #[export] attribute
fn has_export_attribute(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attr| {
        let path = attr.path();
        // Match #[export] or #[zap::export] or #[zap_server::export]
        if path.is_ident("export") {
            return true;
        }
        let segments: Vec<_> = path.segments.iter().collect();
        if segments.len() == 2 {
            let first = segments[0].ident.to_string();
            let second = segments[1].ident.to_string();
            return (first == "zap" || first == "zap_server") && second == "export";
        }
        false
    })
}

/// Extract doc comments from attributes
fn extract_doc_comments(attrs: &[Attribute]) -> Vec<String> {
    attrs
        .iter()
        .filter_map(|attr| {
            if attr.path().is_ident("doc") {
                if let syn::Meta::NameValue(meta) = &attr.meta {
                    if let syn::Expr::Lit(expr_lit) = &meta.value {
                        if let syn::Lit::Str(lit_str) = &expr_lit.lit {
                            return Some(lit_str.value().trim().to_string());
                        }
                    }
                }
            }
            None
        })
        .collect()
}

/// Parse a Rust type into ExportedType
fn parse_type(ty: &Type) -> ExportedType {
    match ty {
        Type::Path(type_path) => {
            let segments: Vec<_> = type_path.path.segments.iter().collect();
            if segments.is_empty() {
                return ExportedType::Custom {
                    name: "unknown".to_string(),
                    generics: vec![],
                };
            }

            let last_segment = segments.last().unwrap();
            let type_name = last_segment.ident.to_string();

            // Handle generic arguments
            let generics = match &last_segment.arguments {
                syn::PathArguments::AngleBracketed(args) => args
                    .args
                    .iter()
                    .filter_map(|arg| {
                        if let syn::GenericArgument::Type(inner_ty) = arg {
                            Some(parse_type(inner_ty))
                        } else {
                            None
                        }
                    })
                    .collect(),
                _ => vec![],
            };

            match type_name.as_str() {
                "String" | "str" => ExportedType::String,
                "bool" => ExportedType::Bool,
                "i8" => ExportedType::I8,
                "i16" => ExportedType::I16,
                "i32" => ExportedType::I32,
                "i64" => ExportedType::I64,
                "i128" => ExportedType::I128,
                "isize" => ExportedType::I64, // Map to i64
                "u8" => ExportedType::U8,
                "u16" => ExportedType::U16,
                "u32" => ExportedType::U32,
                "u64" => ExportedType::U64,
                "u128" => ExportedType::U128,
                "usize" => ExportedType::U64, // Map to u64
                "f32" => ExportedType::F32,
                "f64" => ExportedType::F64,
                "Option" => {
                    if let Some(inner) = generics.into_iter().next() {
                        ExportedType::Option(Box::new(inner))
                    } else {
                        ExportedType::Option(Box::new(ExportedType::Unit))
                    }
                }
                "Vec" => {
                    if let Some(inner) = generics.into_iter().next() {
                        ExportedType::Vec(Box::new(inner))
                    } else {
                        ExportedType::Vec(Box::new(ExportedType::Unit))
                    }
                }
                "HashMap" | "BTreeMap" => {
                    let mut iter = generics.into_iter();
                    let key = iter.next().unwrap_or(ExportedType::String);
                    let value = iter.next().unwrap_or(ExportedType::Unit);
                    ExportedType::HashMap {
                        key: Box::new(key),
                        value: Box::new(value),
                    }
                }
                "Result" => {
                    let mut iter = generics.into_iter();
                    let ok = iter.next().unwrap_or(ExportedType::Unit);
                    let err = iter.next().unwrap_or(ExportedType::String);
                    ExportedType::Result {
                        ok: Box::new(ok),
                        err: Box::new(err),
                    }
                }
                // serde_json::Value maps to any/unknown
                "Value" => ExportedType::Custom {
                    name: "unknown".to_string(),
                    generics: vec![],
                },
                _ => ExportedType::Custom {
                    name: type_name,
                    generics,
                },
            }
        }
        Type::Reference(type_ref) => parse_type(&type_ref.elem),
        Type::Tuple(tuple) if tuple.elems.is_empty() => ExportedType::Unit,
        _ => ExportedType::Custom {
            name: "unknown".to_string(),
            generics: vec![],
        },
    }
}

/// Parse a function item into ExportedFunction
fn parse_function(func: &ItemFn) -> Option<ExportedFunction> {
    // Check for #[export] attribute
    if !has_export_attribute(&func.attrs) {
        return None;
    }

    // Must be pub
    if !matches!(func.vis, Visibility::Public(_)) {
        return None;
    }

    let name = func.sig.ident.to_string();
    let is_async = func.sig.asyncness.is_some();

    // Parse parameters
    let params: Vec<ExportedParam> = func
        .sig
        .inputs
        .iter()
        .filter_map(|arg| {
            if let FnArg::Typed(pat_type) = arg {
                let param_name = if let Pat::Ident(pat_ident) = &*pat_type.pat {
                    pat_ident.ident.to_string()
                } else {
                    return None;
                };
                let param_type = parse_type(&pat_type.ty);
                Some(ExportedParam {
                    name: param_name,
                    ty: param_type,
                })
            } else {
                None
            }
        })
        .collect();

    // Parse return type
    let return_type = match &func.sig.output {
        ReturnType::Default => ExportedType::Unit,
        ReturnType::Type(_, ty) => parse_type(ty),
    };

    // Extract doc comments
    let doc_comments = extract_doc_comments(&func.attrs);

    // Try to extract namespace from function name (e.g., users_get -> namespace: users)
    let namespace = None; // Can be extended to support #[export(namespace = "users")]

    Some(ExportedFunction {
        name,
        namespace,
        is_async,
        params,
        return_type,
        doc_comments,
    })
}

/// Find all exported functions in Rust source files
pub fn find_exported_functions(project_dir: &Path) -> anyhow::Result<Vec<ExportedFunction>> {
    let mut functions = Vec::new();

    // Look for server/src directory first (standard ZapJS project structure)
    let server_src = project_dir.join("server").join("src");
    let search_dir = if server_src.exists() {
        server_src
    } else {
        project_dir.to_path_buf()
    };

    for entry in WalkDir::new(&search_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "rs"))
    {
        let content = std::fs::read_to_string(entry.path())?;

        // Parse the file
        let syntax = match syn::parse_file(&content) {
            Ok(syntax) => syntax,
            Err(e) => {
                eprintln!(
                    "Warning: Failed to parse {}: {}",
                    entry.path().display(),
                    e
                );
                continue;
            }
        };

        // Find all functions with #[export] attribute
        for item in syntax.items {
            if let syn::Item::Fn(func) = item {
                if let Some(exported) = parse_function(&func) {
                    eprintln!(
                        "Found exported function: {} in {}",
                        exported.name,
                        entry.path().display()
                    );
                    functions.push(exported);
                }
            }
        }
    }

    Ok(functions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_camel_case() {
        assert_eq!(ExportedType::to_camel_case("get_user"), "getUser");
        assert_eq!(ExportedType::to_camel_case("create_user"), "createUser");
        assert_eq!(ExportedType::to_camel_case("user"), "user");
    }

    #[test]
    fn test_type_to_typescript() {
        assert_eq!(ExportedType::String.to_typescript(), "string");
        assert_eq!(ExportedType::U64.to_typescript(), "number");
        assert_eq!(
            ExportedType::Option(Box::new(ExportedType::String)).to_typescript(),
            "string | null"
        );
        assert_eq!(
            ExportedType::Vec(Box::new(ExportedType::U32)).to_typescript(),
            "number[]"
        );
    }

    #[test]
    fn test_generate_definitions() {
        let func = ExportedFunction {
            name: "get_user".to_string(),
            namespace: Some("users".to_string()),
            is_async: true,
            params: vec![ExportedParam {
                name: "id".to_string(),
                ty: ExportedType::U64,
            }],
            return_type: ExportedType::Custom {
                name: "User".to_string(),
                generics: vec![],
            },
            doc_comments: vec!["Get user by ID".to_string()],
        };

        let defs = generate_typescript_definitions(&[func]);
        assert!(defs.contains("getUser"));
        assert!(defs.contains("Promise<User>"));
    }

    #[test]
    fn test_generate_namespaced_server() {
        let func = ExportedFunction {
            name: "get".to_string(),
            namespace: Some("users".to_string()),
            is_async: true,
            params: vec![ExportedParam {
                name: "id".to_string(),
                ty: ExportedType::U64,
            }],
            return_type: ExportedType::Custom {
                name: "User".to_string(),
                generics: vec![],
            },
            doc_comments: vec![],
        };

        let server = generate_namespaced_server(&[func]);
        // Check namespace structure is generated
        assert!(server.contains("users: {"));
        assert!(server.contains("async get("));
        // Check RPC call uses namespaced name
        assert!(server.contains("'users.get'"));
    }
}
