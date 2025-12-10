use serde::{Deserialize, Serialize};

/// Metadata about an exported function for TypeScript binding generation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FunctionMetadata {
    /// The function name (snake_case in Rust)
    pub name: String,
    /// Function parameters
    pub params: Vec<ParamMetadata>,
    /// Return type
    pub return_type: TypeMetadata,
    /// Whether the function is async
    pub is_async: bool,
    /// Documentation comments
    pub doc_comments: Vec<String>,
    /// Line number in source file (for error reporting)
    pub line_number: usize,
}

/// Metadata about a function parameter
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParamMetadata {
    /// Parameter name
    pub name: String,
    /// Parameter type
    pub ty: TypeMetadata,
    /// Whether the parameter is optional (Option<T>)
    pub is_optional: bool,
}

/// Represents a Rust type in a portable way
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TypeMetadata {
    // Primitive types
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

    // Complex types
    Option(Box<TypeMetadata>),
    Vec(Box<TypeMetadata>),
    HashMap {
        key: Box<TypeMetadata>,
        value: Box<TypeMetadata>,
    },

    // User-defined types
    Custom {
        name: String,
        generics: Vec<TypeMetadata>,
    },

    // Special
    Unit,
    Result {
        ok: Box<TypeMetadata>,
        err: Box<TypeMetadata>,
    },
}

impl TypeMetadata {
    /// Get the TypeScript equivalent of this Rust type
    pub fn to_typescript(&self) -> String {
        match self {
            TypeMetadata::String => "string".to_string(),
            TypeMetadata::Bool => "boolean".to_string(),
            TypeMetadata::I8
            | TypeMetadata::I16
            | TypeMetadata::I32
            | TypeMetadata::I64
            | TypeMetadata::I128
            | TypeMetadata::U8
            | TypeMetadata::U16
            | TypeMetadata::U32
            | TypeMetadata::U64
            | TypeMetadata::U128
            | TypeMetadata::F32
            | TypeMetadata::F64 => "number".to_string(),

            TypeMetadata::Option(inner) => {
                format!("{} | null", inner.to_typescript())
            }

            TypeMetadata::Vec(inner) => {
                format!("{}[]", inner.to_typescript())
            }

            TypeMetadata::HashMap { key, value } => {
                format!(
                    "Record<{}, {}>",
                    key.to_typescript(),
                    value.to_typescript()
                )
            }

            TypeMetadata::Unit => "void".to_string(),

            // Results become Promises that throw on error
            TypeMetadata::Result { ok, .. } => {
                format!("Promise<{}>", ok.to_typescript())
            }

            TypeMetadata::Custom { name, generics } => {
                if generics.is_empty() {
                    name.clone()
                } else {
                    let generic_types = generics
                        .iter()
                        .map(|g| g.to_typescript())
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("{}<{}>", name, generic_types)
                }
            }
        }
    }

    /// Check if this type is wrapped in a Result
    pub fn is_result(&self) -> bool {
        matches!(self, TypeMetadata::Result { .. })
    }

    /// Get the inner type if this is an Option
    #[allow(dead_code)]
    pub fn inner_option(&self) -> Option<&TypeMetadata> {
        match self {
            TypeMetadata::Option(inner) => Some(inner),
            _ => None,
        }
    }
}

impl std::fmt::Display for TypeMetadata {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_typescript())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_type_to_typescript() {
        assert_eq!(TypeMetadata::String.to_typescript(), "string");
        assert_eq!(TypeMetadata::Bool.to_typescript(), "boolean");
        assert_eq!(TypeMetadata::U64.to_typescript(), "number");

        let option_str = TypeMetadata::Option(Box::new(TypeMetadata::String));
        assert_eq!(option_str.to_typescript(), "string | null");

        let vec_u32 = TypeMetadata::Vec(Box::new(TypeMetadata::U32));
        assert_eq!(vec_u32.to_typescript(), "number[]");

        let result_str = TypeMetadata::Result {
            ok: Box::new(TypeMetadata::String),
            err: Box::new(TypeMetadata::String),
        };
        assert_eq!(result_str.to_typescript(), "Promise<string>");
    }
}
