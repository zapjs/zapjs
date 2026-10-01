use crate::{
    manifest::{ActionRef, AssetRef, CompiledManifest, ManifestError, RouteEntry, RouteKind},
    routing::Param,
};
use http::{Method, Uri};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestTarget<'a> {
    StaticAsset(&'a AssetRef),
    Page {
        route: &'a RouteEntry,
        params: BTreeMap<String, Param>,
    },
    RouteHandler {
        route: &'a RouteEntry,
        params: BTreeMap<String, Param>,
    },
    NotFound,
    MethodNotAllowed {
        allowed: Vec<Method>,
    },
}

#[derive(Debug, Error)]
pub enum RequestPlanError {
    #[error("unsupported request target path")]
    Path,
    #[error("invalid application manifest: {0}")]
    Manifest(#[from] ManifestError),
    #[error("unknown server action")]
    UnknownAction,
    #[error("server action requires POST")]
    ActionMethod,
    #[error("server action origin is not allowed")]
    ActionOrigin,
    #[error("server action module is not executable")]
    ActionModule,
}

const PAGE_METHODS: &[Method] = &[Method::GET, Method::HEAD];
const ASSET_METHODS: &[Method] = &[Method::GET, Method::HEAD];

pub fn plan_request<'a>(
    manifest: &'a CompiledManifest,
    method: &Method,
    path: &str,
) -> Result<RequestTarget<'a>, RequestPlanError> {
    let path = request_path(path).ok_or(RequestPlanError::Path)?;

    if let Some(asset) = manifest.asset(path) {
        if !ASSET_METHODS.contains(method) {
            return Ok(RequestTarget::MethodNotAllowed {
                allowed: ASSET_METHODS.to_vec(),
            });
        }
        return Ok(RequestTarget::StaticAsset(asset));
    }

    let Some(matched) = manifest.resolve(path)? else {
        return Ok(RequestTarget::NotFound);
    };

    match matched.route.kind {
        RouteKind::Page => {
            if !PAGE_METHODS.contains(method) {
                return Ok(RequestTarget::MethodNotAllowed {
                    allowed: PAGE_METHODS.to_vec(),
                });
            }
            Ok(RequestTarget::Page {
                route: matched.route,
                params: matched.params,
            })
        }
        RouteKind::Handler => {
            let allowed = allowed_methods(matched.route);
            if !allowed.contains(method) {
                return Ok(RequestTarget::MethodNotAllowed { allowed });
            }
            Ok(RequestTarget::RouteHandler {
                route: matched.route,
                params: matched.params,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionTarget<'a> {
    pub action: &'a ActionRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionAdmission<'a> {
    pub target: ActionTarget<'a>,
}

pub fn plan_action<'a>(
    manifest: &'a CompiledManifest,
    method: &Method,
    action_id: &str,
    origin: Option<&str>,
    expected_origin: Option<&str>,
) -> Result<ActionAdmission<'a>, RequestPlanError> {
    if method != Method::POST {
        return Err(RequestPlanError::ActionMethod);
    }
    if !origin_allowed(origin, expected_origin) {
        return Err(RequestPlanError::ActionOrigin);
    }
    let action = manifest
        .action(action_id)
        .ok_or(RequestPlanError::UnknownAction)?;
    let module = manifest
        .module(&action.module)
        .ok_or(RequestPlanError::ActionModule)?;
    if module.server_bundle.is_none() {
        return Err(RequestPlanError::ActionModule);
    }
    Ok(ActionAdmission {
        target: ActionTarget { action },
    })
}

fn origin_allowed(origin: Option<&str>, expected_origin: Option<&str>) -> bool {
    let Some(expected_origin) = expected_origin else {
        return true;
    };
    let Some(origin) = origin else {
        return false;
    };
    normalize_origin(origin).as_deref() == normalize_origin(expected_origin).as_deref()
}

fn normalize_origin(value: &str) -> Option<String> {
    let uri = value.parse::<Uri>().ok()?;
    let scheme = uri.scheme_str()?;
    let authority = uri.authority()?.as_str();
    Some(format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        authority.to_ascii_lowercase()
    ))
}

fn allowed_methods(route: &RouteEntry) -> Vec<Method> {
    route
        .methods
        .iter()
        .filter_map(|method| Method::from_bytes(method.as_bytes()).ok())
        .collect()
}

fn request_path(path: &str) -> Option<&str> {
    if path.is_empty() || !path.starts_with('/') || path.contains(['?', '#', '\\']) {
        return None;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{
        ActionRef, ApplicationManifest, AssetRef, CachePolicy, LayoutRef, ModuleKind, ModuleRef,
        RouteEntry, RouteKind,
    };
    use std::path::PathBuf;

    fn compiled() -> CompiledManifest {
        CompiledManifest::new(ApplicationManifest {
            routes: vec![
                RouteEntry {
                    id: "page".into(),
                    pattern: "/shop/[id]".into(),
                    kind: RouteKind::Page,
                    source: PathBuf::from("shop/[id]/page.tsx"),
                    layouts: vec!["layout".into()],
                    module: "page".into(),
                    methods: vec!["GET".into(), "HEAD".into()],
                    cache: CachePolicy::default(),
                },
                RouteEntry {
                    id: "handler".into(),
                    pattern: "/api/echo".into(),
                    kind: RouteKind::Handler,
                    source: PathBuf::from("api/echo/route.ts"),
                    layouts: Vec::new(),
                    module: "handler".into(),
                    methods: vec!["POST".into()],
                    cache: CachePolicy::default(),
                },
            ],
            layouts: vec![LayoutRef {
                id: "layout".into(),
                path: PathBuf::from("layout.tsx"),
                depth: 0,
            }],
            modules: vec![
                ModuleRef {
                    id: "page".into(),
                    path: PathBuf::from("shop/[id]/page.tsx"),
                    kind: ModuleKind::Server,
                    browser_chunk: None,
                    server_bundle: Some(PathBuf::from(".zap/server/page.js")),
                },
                ModuleRef {
                    id: "handler".into(),
                    path: PathBuf::from("api/echo/route.ts"),
                    kind: ModuleKind::Server,
                    browser_chunk: None,
                    server_bundle: Some(PathBuf::from(".zap/server/handler.js")),
                },
            ],
            actions: vec![ActionRef {
                id: "action:page#save".into(),
                module: "page".into(),
                export: "save".into(),
                path: PathBuf::from("actions.ts"),
            }],
            assets: vec![AssetRef {
                source: PathBuf::from("images/logo.svg"),
                url_path: "/images/logo.svg".into(),
            }],
        })
        .unwrap()
    }

    #[test]
    fn plans_assets_pages_handlers_and_not_found() {
        let manifest = compiled();
        match plan_request(&manifest, &Method::GET, "/images/logo.svg").unwrap() {
            RequestTarget::StaticAsset(asset) => {
                assert_eq!(asset.source, PathBuf::from("images/logo.svg"))
            }
            target => panic!("unexpected target: {target:?}"),
        }
        match plan_request(&manifest, &Method::HEAD, "/shop/caf%C3%A9").unwrap() {
            RequestTarget::Page { route, params } => {
                assert_eq!(route.module, "page");
                assert_eq!(params["id"], Param::One("café".into()));
            }
            target => panic!("unexpected target: {target:?}"),
        }
        match plan_request(&manifest, &Method::POST, "/api/echo").unwrap() {
            RequestTarget::RouteHandler { route, .. } => assert_eq!(route.module, "handler"),
            target => panic!("unexpected target: {target:?}"),
        }
        assert!(matches!(
            plan_request(&manifest, &Method::GET, "/missing").unwrap(),
            RequestTarget::NotFound
        ));
    }

    #[test]
    fn admits_known_actions_with_post_and_same_origin() {
        let manifest = compiled();
        let admitted = plan_action(
            &manifest,
            &Method::POST,
            "action:page#save",
            Some("https://example.com/form"),
            Some("https://example.com"),
        )
        .unwrap();
        assert_eq!(admitted.target.action.export, "save");

        assert!(matches!(
            plan_action(&manifest, &Method::GET, "action:page#save", None, None),
            Err(RequestPlanError::ActionMethod)
        ));
        assert!(matches!(
            plan_action(&manifest, &Method::POST, "missing", None, None),
            Err(RequestPlanError::UnknownAction)
        ));
        assert!(matches!(
            plan_action(
                &manifest,
                &Method::POST,
                "action:page#save",
                Some("https://evil.example"),
                Some("https://example.com"),
            ),
            Err(RequestPlanError::ActionOrigin)
        ));
    }

    #[test]
    fn rejects_methods_and_unsafe_paths_before_dispatch() {
        let manifest = compiled();
        match plan_request(&manifest, &Method::POST, "/shop/1").unwrap() {
            RequestTarget::MethodNotAllowed { allowed } => {
                assert_eq!(allowed, PAGE_METHODS.to_vec())
            }
            target => panic!("unexpected target: {target:?}"),
        }
        match plan_request(&manifest, &Method::DELETE, "/images/logo.svg").unwrap() {
            RequestTarget::MethodNotAllowed { allowed } => {
                assert_eq!(allowed, ASSET_METHODS.to_vec())
            }
            target => panic!("unexpected target: {target:?}"),
        }
        match plan_request(&manifest, &Method::GET, "/api/echo").unwrap() {
            RequestTarget::MethodNotAllowed { allowed } => assert_eq!(allowed, vec![Method::POST]),
            target => panic!("unexpected target: {target:?}"),
        }
        assert!(plan_request(&manifest, &Method::GET, "/shop/%").is_err());
        assert!(plan_request(&manifest, &Method::GET, "/shop/1?x=1").is_err());
    }
}
