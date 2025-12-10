use syn::{
    GenericArgument, PathArguments, PathSegment, ReturnType, Type, TypePath, TypeTuple,
};

use crate::metadata::TypeMetadata;

/// Parse a syn::Type into our TypeMetadata representation
pub fn parse_type(ty: &Type) -> TypeMetadata {
    match ty {
        Type::Path(type_path) => parse_type_path(type_path),
        Type::Tuple(tuple) => parse_tuple(tuple),
        Type::Reference(type_ref) => {
            // Dereference and parse the inner type
            parse_type(&type_ref.elem)
        }
        _ => {
            // Fallback for complex types
            TypeMetadata::Custom {
                name: "Unknown".to_string(),
                generics: vec![],
            }
        }
    }
}

/// Parse a TypePath (most common case)
fn parse_type_path(type_path: &TypePath) -> TypeMetadata {
    if let Some(segment) = type_path.path.segments.last() {
        parse_path_segment(segment)
    } else {
        TypeMetadata::Custom {
            name: "Empty".to_string(),
            generics: vec![],
        }
    }
}

/// Parse a single path segment
fn parse_path_segment(segment: &PathSegment) -> TypeMetadata {
    let ident = segment.ident.to_string();

    match ident.as_str() {
        // Primitive types
        "String" | "str" => TypeMetadata::String,
        "bool" => TypeMetadata::Bool,
        "i8" => TypeMetadata::I8,
        "i16" => TypeMetadata::I16,
        "i32" => TypeMetadata::I32,
        "i64" => TypeMetadata::I64,
        "i128" => TypeMetadata::I128,
        "u8" => TypeMetadata::U8,
        "u16" => TypeMetadata::U16,
        "u32" => TypeMetadata::U32,
        "u64" => TypeMetadata::U64,
        "u128" => TypeMetadata::U128,
        "f32" => TypeMetadata::F32,
        "f64" => TypeMetadata::F64,

        // Collection types
        "Vec" | "vector" => {
            let inner = extract_first_generic(&segment.arguments);
            TypeMetadata::Vec(Box::new(inner))
        }

        "Option" => {
            let inner = extract_first_generic(&segment.arguments);
            TypeMetadata::Option(Box::new(inner))
        }

        "HashMap" | "BTreeMap" => {
            let key = extract_nth_generic(&segment.arguments, 0);
            let value = extract_nth_generic(&segment.arguments, 1);
            TypeMetadata::HashMap {
                key: Box::new(key),
                value: Box::new(value),
            }
        }

        "Result" => {
            let ok = extract_nth_generic(&segment.arguments, 0);
            let err = extract_nth_generic(&segment.arguments, 1);
            TypeMetadata::Result {
                ok: Box::new(ok),
                err: Box::new(err),
            }
        }

        // User-defined types
        _ => {
            let generics = extract_all_generics(&segment.arguments);
            TypeMetadata::Custom {
                name: ident,
                generics,
            }
        }
    }
}

/// Extract the first generic type argument
fn extract_first_generic(args: &PathArguments) -> TypeMetadata {
    extract_nth_generic(args, 0)
}

/// Extract the nth generic type argument
fn extract_nth_generic(args: &PathArguments, n: usize) -> TypeMetadata {
    if let PathArguments::AngleBracketed(angle_args) = args {
        if let Some(GenericArgument::Type(ty)) = angle_args.args.iter().nth(n) {
            return parse_type(ty);
        }
    }

    // Default to String if we can't find the generic
    TypeMetadata::String
}

/// Extract all generic type arguments
fn extract_all_generics(args: &PathArguments) -> Vec<TypeMetadata> {
    if let PathArguments::AngleBracketed(angle_args) = args {
        angle_args
            .args
            .iter()
            .filter_map(|arg| {
                if let GenericArgument::Type(ty) = arg {
                    Some(parse_type(ty))
                } else {
                    None
                }
            })
            .collect()
    } else {
        vec![]
    }
}

/// Parse a return type
pub fn parse_return_type(rt: &ReturnType) -> TypeMetadata {
    match rt {
        ReturnType::Default => TypeMetadata::Unit,
        ReturnType::Type(_, ty) => parse_type(ty),
    }
}

/// Parse a tuple type
fn parse_tuple(tuple: &TypeTuple) -> TypeMetadata {
    if tuple.elems.is_empty() {
        TypeMetadata::Unit
    } else if tuple.elems.len() == 1 {
        parse_type(&tuple.elems[0])
    } else {
        // Multiple elements - can't represent in TypeScript as single value
        TypeMetadata::Custom {
            name: format!("Tuple{}", tuple.elems.len()),
            generics: tuple.elems.iter().map(parse_type).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syn::parse_quote;

    #[test]
    fn test_parse_primitive_types() {
        let string_ty: Type = parse_quote!(String);
        assert_eq!(parse_type(&string_ty), TypeMetadata::String);

        let bool_ty: Type = parse_quote!(bool);
        assert_eq!(parse_type(&bool_ty), TypeMetadata::Bool);

        let u64_ty: Type = parse_quote!(u64);
        assert_eq!(parse_type(&u64_ty), TypeMetadata::U64);
    }

    #[test]
    fn test_parse_option() {
        let option_ty: Type = parse_quote!(Option<String>);
        let expected = TypeMetadata::Option(Box::new(TypeMetadata::String));
        assert_eq!(parse_type(&option_ty), expected);
    }

    #[test]
    fn test_parse_vec() {
        let vec_ty: Type = parse_quote!(Vec<u32>);
        let expected = TypeMetadata::Vec(Box::new(TypeMetadata::U32));
        assert_eq!(parse_type(&vec_ty), expected);
    }

    #[test]
    fn test_parse_result() {
        let result_ty: Type = parse_quote!(Result<String, String>);
        let expected = TypeMetadata::Result {
            ok: Box::new(TypeMetadata::String),
            err: Box::new(TypeMetadata::String),
        };
        assert_eq!(parse_type(&result_ty), expected);
    }

    #[test]
    fn test_parse_custom_type() {
        let custom_ty: Type = parse_quote!(User);
        match parse_type(&custom_ty) {
            TypeMetadata::Custom { name, generics } => {
                assert_eq!(name, "User");
                assert!(generics.is_empty());
            }
            _ => panic!("Expected Custom type"),
        }
    }
}
