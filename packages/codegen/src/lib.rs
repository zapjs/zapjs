use serde::{Deserialize, Serialize};
use std::path::Path;
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
            ExportedType::Result { ok, .. } => {
                format!("Promise<{}>", ok.to_typescript())
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

/// Generate TypeScript type definitions
pub fn generate_typescript_definitions(functions: &[ExportedFunction]) -> String {
    let mut output = String::from("// Auto-generated TypeScript definitions\n");
    output.push_str("// DO NOT EDIT MANUALLY\n\n");

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
    output.push_str("import { rpcCall } from './rpc-client';\n\n");

    // Generate backend object
    output.push_str("export const backend = {\n");

    for func in functions {
        let fn_name = ExportedType::to_camel_case(&func.name);
        let rust_name = &func.name;

        let params = func
            .params
            .iter()
            .map(|p| ExportedType::to_camel_case(&p.name))
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

        output.push_str(&format!(
            r#"  async {}({}) {{
    return rpcCall('{}', {{ {} }});
  }},

"#,
            fn_name, params, rust_name, param_mapping
        ));
    }

    output.push_str("};\n\n");

    // Generate individual exports
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
    output.push_str("import { rpcCall } from './rpc-client';\n\n");

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

/// Find all exported functions in Rust source files
pub fn find_exported_functions(project_dir: &Path) -> anyhow::Result<Vec<ExportedFunction>> {
    let functions = Vec::new();

    for entry in WalkDir::new(project_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "rs"))
    {
        let _content = std::fs::read_to_string(entry.path())?;

        // Look for #[zap::export] attribute
        // For now, we'll use a simple heuristic-based approach
        // In production, we'd want to use syn to parse properly
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
