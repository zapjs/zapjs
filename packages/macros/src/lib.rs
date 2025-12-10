mod metadata;
mod types;

use metadata::{FunctionMetadata, ParamMetadata};
use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::{parse_macro_input, FnArg, ItemFn, PatType};
use types::{parse_return_type, parse_type};

/// Export a Rust function to be callable from TypeScript
///
/// # Example
/// ```ignore
/// #[zap::export]
/// pub async fn get_user(id: u64) -> Result<User, Error> {
///     // implementation
/// }
/// ```
///
/// This generates:
/// - A wrapper function that handles serialization/deserialization
/// - Metadata for TypeScript codegen
/// - Registration in the global function registry
#[proc_macro_attribute]
pub fn export(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemFn);

    // Validate the function signature
    if let Err(e) = validate_function(&input) {
        return TokenStream::from(e);
    }

    // Extract function metadata
    let metadata = extract_metadata(&input);

    // Generate the wrapper function
    let wrapper = generate_wrapper(&input, &metadata);

    // Generate metadata emission code (for build script to collect)
    let metadata_emission = generate_metadata_emission(&metadata);

    // Return the original function + wrapper + metadata
    let original = &input;
    let output = quote! {
        #original
        #wrapper
        #metadata_emission
    };

    TokenStream::from(output)
}

/// Validate that the function is suitable for export
fn validate_function(func: &ItemFn) -> Result<(), proc_macro::TokenStream> {
    // Must be public
    if !matches!(func.vis, syn::Visibility::Public(_)) {
        return Err(syn::Error::new_spanned(func, "exported function must be public")
            .to_compile_error()
            .into());
    }

    // Can't have generic parameters (for now)
    if !func.sig.generics.params.is_empty() {
        return Err(
            syn::Error::new_spanned(func, "exported functions cannot have generic parameters")
                .to_compile_error()
                .into(),
        );
    }

    Ok(())
}

/// Extract metadata from a function signature
fn extract_metadata(func: &ItemFn) -> FunctionMetadata {
    let name = func.sig.ident.to_string();
    let is_async = func.sig.asyncness.is_some();

    // Extract parameters
    let params: Vec<ParamMetadata> = func
        .sig
        .inputs
        .iter()
        .filter_map(|arg| {
            if let FnArg::Typed(PatType { pat, ty, .. }) = arg {
                if let syn::Pat::Ident(pat_ident) = &**pat {
                    let param_name = pat_ident.ident.to_string();
                    let param_type = parse_type(ty);
                    return Some(ParamMetadata {
                        name: param_name,
                        ty: param_type,
                        is_optional: false,
                    });
                }
            }
            None
        })
        .collect();

    // Extract return type
    let return_type = parse_return_type(&func.sig.output);

    // Extract documentation
    let doc_comments: Vec<String> = func
        .attrs
        .iter()
        .filter_map(|attr| {
            if attr.path().is_ident("doc") {
                if let syn::Meta::NameValue(nv) = &attr.meta {
                    if let syn::Expr::Lit(syn::ExprLit {
                        lit: syn::Lit::Str(lit_str),
                        ..
                    }) = &nv.value
                    {
                        return Some(lit_str.value());
                    }
                }
            }
            None
        })
        .collect();

    FunctionMetadata {
        name,
        params,
        return_type,
        is_async,
        doc_comments,
        line_number: 0, // Would need span info to get real line number
    }
}

/// Generate the wrapper function
fn generate_wrapper(func: &ItemFn, metadata: &FunctionMetadata) -> proc_macro2::TokenStream {
    let fn_name = &func.sig.ident;
    let wrapper_name = format_ident!("__zap_wrapper_{}", fn_name);

    // Get parameter types for proper deserialization
    let param_types: Vec<_> = func.sig.inputs.iter().filter_map(|arg| {
        if let FnArg::Typed(PatType { ty, .. }) = arg {
            Some(ty.clone())
        } else {
            None
        }
    }).collect();

    // Generate parameter deserialization code with proper type conversion
    let param_deserialize: Vec<_> = metadata
        .params
        .iter()
        .zip(param_types.iter())
        .map(|(p, ty)| {
            let param_name = format_ident!("{}", p.name);
            let param_name_str = &p.name;

            quote! {
                let #param_name: #ty = {
                    let value = params.get(#param_name_str)
                        .ok_or_else(|| format!("Missing parameter: {}", #param_name_str))?
                        .clone();
                    serde_json::from_value(value)
                        .map_err(|e| format!("Failed to deserialize parameter '{}': {}", #param_name_str, e))?
                };
            }
        })
        .collect();

    // Generate the call expression
    let param_names: Vec<_> = metadata
        .params
        .iter()
        .map(|p| format_ident!("{}", p.name))
        .collect();

    let call_expr = if metadata.is_async {
        quote! { #fn_name(#(#param_names),*).await }
    } else {
        quote! { #fn_name(#(#param_names),*) }
    };

    // Handle Result types - if the return type is a Result, unwrap it
    let result_handling = if metadata.return_type.is_result() {
        quote! {
            let result = #call_expr?;
        }
    } else {
        quote! {
            let result = #call_expr;
        }
    };

    // Generate the full wrapper
    if metadata.is_async {
        quote! {
            #[doc(hidden)]
            pub async fn #wrapper_name(
                params: &std::collections::HashMap<String, serde_json::Value>
            ) -> Result<serde_json::Value, String> {
                #(#param_deserialize)*
                #result_handling
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
        }
    } else {
        quote! {
            #[doc(hidden)]
            pub fn #wrapper_name(
                params: &std::collections::HashMap<String, serde_json::Value>
            ) -> Result<serde_json::Value, String> {
                #(#param_deserialize)*
                #result_handling
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
        }
    }
}

/// Generate metadata emission code
fn generate_metadata_emission(metadata: &FunctionMetadata) -> proc_macro2::TokenStream {
    let fn_name = &metadata.name;
    let is_async = metadata.is_async;

    // Build a simple metadata string without serde (to avoid recursion issues)
    let mut metadata_str = format!(r#"{{"name":"{}","is_async":{},"params":["#, fn_name, is_async);

    for (i, param) in metadata.params.iter().enumerate() {
        if i > 0 {
            metadata_str.push(',');
        }
        metadata_str.push_str(&format!(r#"{{"name":"{}"}}"#, param.name));
    }

    metadata_str.push_str(r#"],"return_type":"unit"}"#);

    // Emit as a compile-time constant that the build script can extract
    let const_name = format_ident!("__ZAP_EXPORT_{}", fn_name.to_uppercase());

    quote! {
        #[doc(hidden)]
        #[allow(non_upper_case_globals)]
        pub const #const_name: &str = #metadata_str;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_metadata() {
        let code = quote! {
            /// Get a user by ID
            pub async fn get_user(id: u64) -> Result<User, Error> {
                todo!()
            }
        };

        let func: ItemFn = syn::parse2(code).unwrap();
        let metadata = extract_metadata(&func);

        assert_eq!(metadata.name, "get_user");
        assert!(metadata.is_async);
        assert_eq!(metadata.params.len(), 1);
        assert_eq!(metadata.params[0].name, "id");
        assert!(metadata.return_type.is_result());
    }
}
