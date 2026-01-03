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
        return e;
    }

    // Extract function metadata
    let metadata = extract_metadata(&input);

    // Generate the wrapper function
    let wrapper = generate_wrapper(&input, &metadata);

    // Generate metadata emission code (for build script to collect)
    let metadata_emission = generate_metadata_emission(&metadata);

    // Generate inventory registration
    let registration = generate_registration(&metadata);

    // Return the original function + wrapper + metadata + registration
    let original = &input;
    let output = quote! {
        #original
        #wrapper
        #metadata_emission
        #registration
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

/// Check if a type is Context (for Context parameter detection)
fn is_context_type(ty: &syn::Type) -> bool {
    // Handle both Context and &Context
    match ty {
        syn::Type::Path(type_path) => {
            if let Some(segment) = type_path.path.segments.last() {
                return segment.ident == "Context";
            }
        }
        syn::Type::Reference(type_ref) => {
            // Recurse to check if the referenced type is Context
            return is_context_type(&type_ref.elem);
        }
        _ => {}
    }
    false
}

/// Extract metadata from a function signature
fn extract_metadata(func: &ItemFn) -> FunctionMetadata {
    let name = func.sig.ident.to_string();
    let is_async = func.sig.asyncness.is_some();

    // Check if first parameter is Context
    let has_context = func.sig.inputs.first()
        .map_or(false, |arg| {
            if let FnArg::Typed(PatType { ty, .. }) = arg {
                is_context_type(ty)
            } else {
                false
            }
        });

    // Extract parameters (skip Context if present)
    let params: Vec<ParamMetadata> = func
        .sig
        .inputs
        .iter()
        .enumerate()
        .filter_map(|(idx, arg)| {
            // Skip first parameter if it's Context
            if idx == 0 && has_context {
                return None;
            }

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
        has_context,
        doc_comments,
        line_number: 0, // Would need span info to get real line number
    }
}

/// Generate the wrapper function
fn generate_wrapper(func: &ItemFn, metadata: &FunctionMetadata) -> proc_macro2::TokenStream {
    let fn_name = &func.sig.ident;
    let wrapper_name = format_ident!("__zap_wrapper_{}", fn_name);

    // Get parameter types for proper deserialization (skip Context if present)
    let param_types: Vec<_> = func.sig.inputs.iter()
        .enumerate()
        .filter_map(|(idx, arg)| {
            // Skip first param if it's Context
            if idx == 0 && metadata.has_context {
                return None;
            }
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

    let call_expr = if metadata.has_context {
        // Pass context as first parameter
        if metadata.is_async {
            quote! { #fn_name(ctx, #(#param_names),*).await }
        } else {
            quote! { #fn_name(ctx, #(#param_names),*) }
        }
    } else {
        // No context parameter
        if metadata.is_async {
            quote! { #fn_name(#(#param_names),*).await }
        } else {
            quote! { #fn_name(#(#param_names),*) }
        }
    };

    // Handle Result types - if the return type is a Result, handle both Ok and Err cases
    // The Err case should serialize the error as JSON for type-safe TypeScript consumption
    let result_handling = if metadata.return_type.is_result() {
        quote! {
            match #call_expr {
                Ok(result) => {
                    serde_json::to_value(result).map_err(|e| e.to_string())
                }
                Err(e) => {
                    // Serialize the error as JSON - TypeScript will receive it as the error type
                    // The caller must handle this appropriately (set success=false)
                    match serde_json::to_value(&e) {
                        Ok(error_json) => Err(format!("__TYPED_ERROR__:{}", error_json)),
                        Err(ser_err) => Err(format!("Failed to serialize error: {}", ser_err)),
                    }
                }
            }
        }
    } else {
        quote! {
            let result = #call_expr;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
    };

    // Generate the full wrapper with conditional Context parameter
    if metadata.has_context {
        // Context-aware wrapper signature
        if metadata.is_async {
            quote! {
                #[doc(hidden)]
                pub async fn #wrapper_name(
                    ctx: &::zap_server::__private::Context,
                    params: &std::collections::HashMap<String, serde_json::Value>
                ) -> Result<serde_json::Value, String> {
                    #(#param_deserialize)*
                    #result_handling
                }
            }
        } else {
            quote! {
                #[doc(hidden)]
                pub fn #wrapper_name(
                    ctx: &::zap_server::__private::Context,
                    params: &std::collections::HashMap<String, serde_json::Value>
                ) -> Result<serde_json::Value, String> {
                    #(#param_deserialize)*
                    #result_handling
                }
            }
        }
    } else {
        // Legacy wrapper signature (no Context)
        if metadata.is_async {
            quote! {
                #[doc(hidden)]
                pub async fn #wrapper_name(
                    params: &std::collections::HashMap<String, serde_json::Value>
                ) -> Result<serde_json::Value, String> {
                    #(#param_deserialize)*
                    #result_handling
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
                }
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
    // Use different prefix to avoid collision with linkme static
    let const_name = format_ident!("__ZAP_METADATA_{}", fn_name.to_uppercase());

    quote! {
        #[doc(hidden)]
        #[allow(non_upper_case_globals)]
        pub const #const_name: &str = #metadata_str;
    }
}

/// Generate linkme registration code for runtime function registry
fn generate_registration(metadata: &FunctionMetadata) -> proc_macro2::TokenStream {
    let fn_name = &metadata.name;
    let wrapper_name = format_ident!("__zap_wrapper_{}", fn_name);
    let is_async = metadata.is_async;
    let has_context = metadata.has_context;

    // Determine which FunctionWrapper variant to use based on (is_async, has_context)
    let wrapper_variant = match (is_async, has_context) {
        (false, false) => {
            // Sync, no context
            quote! {
                ::zap_server::__private::FunctionWrapper::Sync(#wrapper_name)
            }
        }
        (true, false) => {
            // Async, no context
            quote! {
                ::zap_server::__private::FunctionWrapper::Async(
                    |params| {
                        let params_owned = params.clone();
                        ::std::boxed::Box::pin(async move {
                            #wrapper_name(&params_owned).await
                        })
                    }
                )
            }
        }
        (false, true) => {
            // Sync with context
            quote! {
                ::zap_server::__private::FunctionWrapper::SyncCtx(#wrapper_name)
            }
        }
        (true, true) => {
            // Async with context (clone context for 'static future)
            quote! {
                ::zap_server::__private::FunctionWrapper::AsyncCtx(
                    |ctx, params| {
                        let ctx_owned = ctx.clone();
                        let params_owned = params.clone();
                        ::std::boxed::Box::pin(async move {
                            #wrapper_name(&ctx_owned, &params_owned).await
                        })
                    }
                )
            }
        }
    };

    // Use linkme distributed_slice instead of inventory
    // Generate unique static variable name using function name
    let static_name = syn::Ident::new(
        &format!("__ZAP_EXPORT_{}", metadata.name.to_uppercase()),
        proc_macro2::Span::call_site()
    );

    quote! {
        #[::zap_server::__private::linkme::distributed_slice(::zap_server::__private::EXPORTS)]
        #[linkme(crate = ::zap_server::__private::linkme)]
        static #static_name: ::zap_server::__private::ExportedFunction =
            ::zap_server::__private::ExportedFunction {
                name: #fn_name,
                is_async: #is_async,
                has_context: #has_context,
                wrapper: #wrapper_variant,
            };
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
