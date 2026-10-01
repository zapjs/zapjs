use crate::{
    manifest::{
        ActionRef, AssetRef, CachePolicy, CompiledManifest, DynamicPolicy, ManifestError,
        RouteEntry, RouteKind,
    },
    routing::Param,
};
use http::{Method, StatusCode, Uri};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestTarget<'a> {
    StaticAsset(&'a AssetRef),
    Page {
        route: &'a RouteEntry,
        params: BTreeMap<String, Param>,
        cache: RouteCacheDecision,
    },
    RouteHandler {
        route: &'a RouteEntry,
        params: BTreeMap<String, Param>,
        cache: RouteCacheDecision,
    },
    NotFound,
    MethodNotAllowed {
        allowed: Vec<Method>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteCacheDecision {
    Public { revalidate_seconds: Option<u64> },
    PrivateNoStore,
}

impl RouteCacheDecision {
    fn allows_private_request_state(&self) -> bool {
        matches!(self, Self::PrivateNoStore)
    }

    pub fn response_headers(&self) -> Vec<(String, String)> {
        match self {
            Self::Public {
                revalidate_seconds: Some(seconds),
            } => vec![(
                "cache-control".into(),
                format!("public, max-age=0, s-maxage={seconds}, stale-while-revalidate"),
            )],
            Self::Public {
                revalidate_seconds: None,
            } => vec![("cache-control".into(), "public, immutable".into())],
            Self::PrivateNoStore => vec![("cache-control".into(), "private, no-store".into())],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionOutcome<T> {
    Dispatch(T),
    Respond(ImmediateResponse),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImmediateResponse {
    pub status: StatusCode,
    pub headers: Vec<(String, String)>,
}

impl ImmediateResponse {
    pub fn new(status: StatusCode) -> Self {
        Self {
            status,
            headers: Vec::new(),
        }
    }

    pub fn method_not_allowed(allowed: &[Method]) -> Self {
        Self {
            status: StatusCode::METHOD_NOT_ALLOWED,
            headers: vec![("allow".into(), allow_header(allowed))],
        }
    }
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
    #[error("request body exceeds configured limit")]
    BodyTooLarge,
    #[error("server action module is not executable")]
    ActionModule,
    #[error("request context is missing required state")]
    MissingContext,
    #[error("request context is not authorized")]
    Unauthorized,
    #[error("public cache policy cannot use private request state")]
    PrivateCacheState,
    #[error("request deadline exceeds configured limit")]
    DeadlineTooLong,
}

const PAGE_METHODS: &[Method] = &[Method::GET, Method::HEAD];
const ASSET_METHODS: &[Method] = &[Method::GET, Method::HEAD];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionLimits {
    pub max_body_bytes: u64,
}

impl Default for AdmissionLimits {
    fn default() -> Self {
        Self {
            max_body_bytes: 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestInput<'a> {
    pub method: &'a Method,
    pub path: &'a str,
    pub declared_body_bytes: Option<u64>,
    pub uses_private_request_state: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInput<'a> {
    pub method: &'a Method,
    pub action_id: &'a str,
    pub origin: Option<&'a str>,
    pub expected_origin: Option<&'a str>,
    pub declared_body_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvocationContext<'a> {
    pub request_id: Option<&'a str>,
    pub authenticated: bool,
    pub deadline_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionPolicy {
    pub require_request_id: bool,
    pub require_authenticated: bool,
    pub max_deadline_ms: u64,
}

impl Default for ExecutionPolicy {
    fn default() -> Self {
        Self {
            require_request_id: false,
            require_authenticated: false,
            max_deadline_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionContext {
    pub request_id: Option<String>,
    pub authenticated: bool,
    pub deadline_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionPlan<T> {
    pub target: T,
    pub context: ExecutionContext,
}

pub fn admit_request_input<'a>(
    manifest: &'a CompiledManifest,
    input: &RequestInput<'_>,
    limits: &AdmissionLimits,
) -> Result<AdmissionOutcome<RequestTarget<'a>>, RequestPlanError> {
    match plan_request_input(manifest, input, limits) {
        Ok(RequestTarget::NotFound) => Ok(AdmissionOutcome::Respond(ImmediateResponse::new(
            StatusCode::NOT_FOUND,
        ))),
        Ok(RequestTarget::MethodNotAllowed { allowed }) => Ok(AdmissionOutcome::Respond(
            ImmediateResponse::method_not_allowed(&allowed),
        )),
        Ok(target) => Ok(AdmissionOutcome::Dispatch(target)),
        Err(RequestPlanError::Path) => Ok(AdmissionOutcome::Respond(ImmediateResponse::new(
            StatusCode::BAD_REQUEST,
        ))),
        Err(RequestPlanError::BodyTooLarge) => Ok(AdmissionOutcome::Respond(
            ImmediateResponse::new(StatusCode::PAYLOAD_TOO_LARGE),
        )),
        Err(RequestPlanError::PrivateCacheState) => Ok(AdmissionOutcome::Respond(
            ImmediateResponse::new(StatusCode::INTERNAL_SERVER_ERROR),
        )),
        Err(error) => Err(error),
    }
}

pub fn admit_action_input<'a>(
    manifest: &'a CompiledManifest,
    input: &ActionInput<'_>,
    limits: &AdmissionLimits,
) -> Result<AdmissionOutcome<ActionAdmission<'a>>, RequestPlanError> {
    match plan_action_input(manifest, input, limits) {
        Ok(admission) => Ok(AdmissionOutcome::Dispatch(admission)),
        Err(RequestPlanError::ActionMethod) => Ok(AdmissionOutcome::Respond(
            ImmediateResponse::method_not_allowed(&[Method::POST]),
        )),
        Err(RequestPlanError::ActionOrigin) => Ok(AdmissionOutcome::Respond(
            ImmediateResponse::new(StatusCode::FORBIDDEN),
        )),
        Err(RequestPlanError::UnknownAction) => Ok(AdmissionOutcome::Respond(
            ImmediateResponse::new(StatusCode::NOT_FOUND),
        )),
        Err(RequestPlanError::BodyTooLarge) => Ok(AdmissionOutcome::Respond(
            ImmediateResponse::new(StatusCode::PAYLOAD_TOO_LARGE),
        )),
        Err(error) => Err(error),
    }
}

pub fn admit_request_execution<'a>(
    manifest: &'a CompiledManifest,
    input: &RequestInput<'_>,
    limits: &AdmissionLimits,
    context: &InvocationContext<'_>,
    policy: &ExecutionPolicy,
) -> Result<AdmissionOutcome<ExecutionPlan<RequestTarget<'a>>>, RequestPlanError> {
    match admit_request_input(manifest, input, limits)? {
        AdmissionOutcome::Dispatch(target) => match enforce_execution_context(context, policy) {
            Ok(context) => Ok(AdmissionOutcome::Dispatch(ExecutionPlan {
                target,
                context,
            })),
            Err(error) => Ok(AdmissionOutcome::Respond(context_error_response(error)?)),
        },
        AdmissionOutcome::Respond(response) => Ok(AdmissionOutcome::Respond(response)),
    }
}

pub fn admit_action_execution<'a>(
    manifest: &'a CompiledManifest,
    input: &ActionInput<'_>,
    limits: &AdmissionLimits,
    context: &InvocationContext<'_>,
    policy: &ExecutionPolicy,
) -> Result<AdmissionOutcome<ExecutionPlan<ActionAdmission<'a>>>, RequestPlanError> {
    match admit_action_input(manifest, input, limits)? {
        AdmissionOutcome::Dispatch(target) => match enforce_execution_context(context, policy) {
            Ok(context) => Ok(AdmissionOutcome::Dispatch(ExecutionPlan {
                target,
                context,
            })),
            Err(error) => Ok(AdmissionOutcome::Respond(context_error_response(error)?)),
        },
        AdmissionOutcome::Respond(response) => Ok(AdmissionOutcome::Respond(response)),
    }
}

pub fn plan_request_input<'a>(
    manifest: &'a CompiledManifest,
    input: &RequestInput<'_>,
    limits: &AdmissionLimits,
) -> Result<RequestTarget<'a>, RequestPlanError> {
    enforce_body_limit(input.declared_body_bytes, limits)?;
    let target = plan_request(manifest, input.method, input.path)?;
    enforce_cache_privacy(&target, input.uses_private_request_state)?;
    Ok(target)
}

pub fn plan_action_input<'a>(
    manifest: &'a CompiledManifest,
    input: &ActionInput<'_>,
    limits: &AdmissionLimits,
) -> Result<ActionAdmission<'a>, RequestPlanError> {
    enforce_body_limit(input.declared_body_bytes, limits)?;
    plan_action(
        manifest,
        input.method,
        input.action_id,
        input.origin,
        input.expected_origin,
    )
}

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
                cache: route_cache_decision(&matched.route.cache),
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
                cache: route_cache_decision(&matched.route.cache),
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

fn route_cache_decision(policy: &CachePolicy) -> RouteCacheDecision {
    match policy.dynamic {
        DynamicPolicy::ForceStatic => RouteCacheDecision::Public {
            revalidate_seconds: policy.revalidate_seconds,
        },
        DynamicPolicy::ForceDynamic => RouteCacheDecision::PrivateNoStore,
        DynamicPolicy::Auto => match policy.revalidate_seconds {
            Some(0) | None => RouteCacheDecision::PrivateNoStore,
            Some(seconds) => RouteCacheDecision::Public {
                revalidate_seconds: Some(seconds),
            },
        },
    }
}

fn enforce_cache_privacy(
    target: &RequestTarget<'_>,
    uses_private_request_state: bool,
) -> Result<(), RequestPlanError> {
    if !uses_private_request_state {
        return Ok(());
    }
    let cache = match target {
        RequestTarget::Page { cache, .. } | RequestTarget::RouteHandler { cache, .. } => cache,
        RequestTarget::StaticAsset(_)
        | RequestTarget::NotFound
        | RequestTarget::MethodNotAllowed { .. } => return Ok(()),
    };
    if cache.allows_private_request_state() {
        Ok(())
    } else {
        Err(RequestPlanError::PrivateCacheState)
    }
}

fn enforce_execution_context(
    context: &InvocationContext<'_>,
    policy: &ExecutionPolicy,
) -> Result<ExecutionContext, RequestPlanError> {
    if policy.require_request_id && context.request_id.is_none_or(str::is_empty) {
        return Err(RequestPlanError::MissingContext);
    }
    if policy.require_authenticated && !context.authenticated {
        return Err(RequestPlanError::Unauthorized);
    }
    let deadline_ms = context.deadline_ms.unwrap_or(policy.max_deadline_ms);
    if deadline_ms == 0 || deadline_ms > policy.max_deadline_ms {
        return Err(RequestPlanError::DeadlineTooLong);
    }
    Ok(ExecutionContext {
        request_id: context.request_id.map(str::to_owned),
        authenticated: context.authenticated,
        deadline_ms,
    })
}

fn context_error_response(error: RequestPlanError) -> Result<ImmediateResponse, RequestPlanError> {
    match error {
        RequestPlanError::MissingContext | RequestPlanError::DeadlineTooLong => {
            Ok(ImmediateResponse::new(StatusCode::BAD_REQUEST))
        }
        RequestPlanError::Unauthorized => Ok(ImmediateResponse::new(StatusCode::UNAUTHORIZED)),
        error => Err(error),
    }
}

fn allow_header(methods: &[Method]) -> String {
    methods
        .iter()
        .map(Method::as_str)
        .collect::<Vec<_>>()
        .join(", ")
}

fn origin_allowed(origin: Option<&str>, expected_origin: Option<&str>) -> bool {
    let Some(expected_origin) = expected_origin else {
        return true;
    };
    let Some(origin) = origin else {
        return false;
    };
    match (normalize_origin(origin), normalize_origin(expected_origin)) {
        (Some(origin), Some(expected_origin)) => origin == expected_origin,
        _ => false,
    }
}

fn normalize_origin(value: &str) -> Option<String> {
    let (scheme, authority) = value.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") {
        return None;
    }
    if authority.is_empty() || authority.contains(['@', '/', '?', '#']) {
        return None;
    }
    let uri = format!("{scheme}://{authority}").parse::<Uri>().ok()?;
    let authority = uri.authority()?.as_str();
    Some(format!("{scheme}://{}", authority.to_ascii_lowercase()))
}

fn enforce_body_limit(
    declared_body_bytes: Option<u64>,
    limits: &AdmissionLimits,
) -> Result<(), RequestPlanError> {
    if declared_body_bytes.is_some_and(|bytes| bytes > limits.max_body_bytes) {
        return Err(RequestPlanError::BodyTooLarge);
    }
    Ok(())
}

fn allowed_methods(route: &RouteEntry) -> Vec<Method> {
    let mut methods = route
        .methods
        .iter()
        .filter_map(|method| Method::from_bytes(method.as_bytes()).ok())
        .collect::<Vec<_>>();
    if methods.contains(&Method::GET) && !methods.contains(&Method::HEAD) {
        methods.push(Method::HEAD);
    }
    methods
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
                    id: "static-page".into(),
                    pattern: "/public".into(),
                    kind: RouteKind::Page,
                    source: PathBuf::from("public/page.tsx"),
                    layouts: vec!["layout".into()],
                    module: "page".into(),
                    methods: vec!["GET".into(), "HEAD".into()],
                    cache: CachePolicy {
                        dynamic: DynamicPolicy::ForceStatic,
                        revalidate_seconds: Some(60),
                    },
                },
                RouteEntry {
                    id: "dynamic-page".into(),
                    pattern: "/account".into(),
                    kind: RouteKind::Page,
                    source: PathBuf::from("account/page.tsx"),
                    layouts: vec!["layout".into()],
                    module: "page".into(),
                    methods: vec!["GET".into(), "HEAD".into()],
                    cache: CachePolicy {
                        dynamic: DynamicPolicy::ForceDynamic,
                        revalidate_seconds: None,
                    },
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
                RouteEntry {
                    id: "get-handler".into(),
                    pattern: "/api/ping".into(),
                    kind: RouteKind::Handler,
                    source: PathBuf::from("api/ping/route.ts"),
                    layouts: Vec::new(),
                    module: "handler".into(),
                    methods: vec!["GET".into()],
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
                ModuleRef {
                    id: "actions".into(),
                    path: PathBuf::from("actions.ts"),
                    kind: ModuleKind::ServerActions,
                    browser_chunk: None,
                    server_bundle: Some(PathBuf::from(".zap/server/actions.js")),
                },
            ],
            actions: vec![ActionRef {
                id: "action:actions#save".into(),
                module: "actions".into(),
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
            RequestTarget::Page { route, params, .. } => {
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
            "action:actions#save",
            Some("https://example.com"),
            Some("https://example.com"),
        )
        .unwrap();
        assert_eq!(admitted.target.action.export, "save");

        assert!(matches!(
            plan_action(&manifest, &Method::GET, "action:actions#save", None, None),
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
                "action:actions#save",
                Some("https://evil.example"),
                Some("https://example.com"),
            ),
            Err(RequestPlanError::ActionOrigin)
        ));
        assert!(matches!(
            plan_action(
                &manifest,
                &Method::POST,
                "action:actions#save",
                Some("not an origin"),
                Some("https://example.com"),
            ),
            Err(RequestPlanError::ActionOrigin)
        ));
        assert!(matches!(
            plan_action(
                &manifest,
                &Method::POST,
                "action:actions#save",
                Some("not an origin"),
                Some("also not an origin"),
            ),
            Err(RequestPlanError::ActionOrigin)
        ));
        for malformed in [
            "https://example.com/path",
            "https://example.com?next=/",
            "https://example.com#frag",
            "ftp://example.com",
            "https://user@example.com",
        ] {
            assert!(
                matches!(
                    plan_action(
                        &manifest,
                        &Method::POST,
                        "action:actions#save",
                        Some(malformed),
                        Some("https://example.com"),
                    ),
                    Err(RequestPlanError::ActionOrigin)
                ),
                "origin should be rejected: {malformed}"
            );
        }
    }

    #[test]
    fn enforces_body_limits_before_route_or_action_dispatch() {
        let manifest = compiled();
        let limits = AdmissionLimits { max_body_bytes: 4 };
        assert!(matches!(
            plan_request_input(
                &manifest,
                &RequestInput {
                    method: &Method::POST,
                    path: "/api/echo",
                    declared_body_bytes: Some(5),
                    uses_private_request_state: false,
                },
                &limits,
            ),
            Err(RequestPlanError::BodyTooLarge)
        ));
        assert!(matches!(
            plan_action_input(
                &manifest,
                &ActionInput {
                    method: &Method::POST,
                    action_id: "action:actions#save",
                    origin: None,
                    expected_origin: None,
                    declared_body_bytes: Some(5),
                },
                &limits,
            ),
            Err(RequestPlanError::BodyTooLarge)
        ));
        assert!(matches!(
            plan_request_input(
                &manifest,
                &RequestInput {
                    method: &Method::POST,
                    path: "/api/echo",
                    declared_body_bytes: Some(4),
                    uses_private_request_state: false,
                },
                &limits,
            )
            .unwrap(),
            RequestTarget::RouteHandler { .. }
        ));
    }

    #[test]
    fn enforces_cache_policy_before_route_dispatch() {
        let manifest = compiled();
        let limits = AdmissionLimits { max_body_bytes: 16 };

        match plan_request_input(
            &manifest,
            &RequestInput {
                method: &Method::GET,
                path: "/public",
                declared_body_bytes: None,
                uses_private_request_state: false,
            },
            &limits,
        )
        .unwrap()
        {
            RequestTarget::Page { cache, .. } => {
                assert_eq!(
                    cache,
                    RouteCacheDecision::Public {
                        revalidate_seconds: Some(60),
                    }
                );
                assert_eq!(
                    cache.response_headers(),
                    vec![(
                        "cache-control".to_owned(),
                        "public, max-age=0, s-maxage=60, stale-while-revalidate".to_owned(),
                    )]
                );
            }
            target => panic!("unexpected target: {target:?}"),
        }

        assert!(matches!(
            plan_request_input(
                &manifest,
                &RequestInput {
                    method: &Method::GET,
                    path: "/public",
                    declared_body_bytes: None,
                    uses_private_request_state: true,
                },
                &limits,
            ),
            Err(RequestPlanError::PrivateCacheState)
        ));
        assert_eq!(
            admit_request_input(
                &manifest,
                &RequestInput {
                    method: &Method::GET,
                    path: "/public",
                    declared_body_bytes: None,
                    uses_private_request_state: true,
                },
                &limits,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::INTERNAL_SERVER_ERROR))
        );
        match plan_request_input(
            &manifest,
            &RequestInput {
                method: &Method::GET,
                path: "/account",
                declared_body_bytes: None,
                uses_private_request_state: true,
            },
            &limits,
        )
        .unwrap()
        {
            RequestTarget::Page { cache, .. } => {
                assert_eq!(cache, RouteCacheDecision::PrivateNoStore);
                assert_eq!(
                    cache.response_headers(),
                    vec![("cache-control".into(), "private, no-store".into())]
                );
            }
            target => panic!("unexpected target: {target:?}"),
        }
        let zero_revalidate = route_cache_decision(&CachePolicy {
            dynamic: DynamicPolicy::Auto,
            revalidate_seconds: Some(0),
        });
        assert_eq!(zero_revalidate, RouteCacheDecision::PrivateNoStore);
        assert_eq!(
            zero_revalidate.response_headers(),
            vec![("cache-control".into(), "private, no-store".into())]
        );
    }

    #[test]
    fn admission_outcomes_map_terminal_requests_to_http_responses() {
        let manifest = compiled();
        let limits = AdmissionLimits { max_body_bytes: 4 };

        match admit_request_input(
            &manifest,
            &RequestInput {
                method: &Method::GET,
                path: "/shop/1",
                declared_body_bytes: None,
                uses_private_request_state: false,
            },
            &limits,
        )
        .unwrap()
        {
            AdmissionOutcome::Dispatch(RequestTarget::Page { route, .. }) => {
                assert_eq!(route.module, "page")
            }
            outcome => panic!("unexpected outcome: {outcome:?}"),
        }

        assert_eq!(
            admit_request_input(
                &manifest,
                &RequestInput {
                    method: &Method::POST,
                    path: "/shop/1",
                    declared_body_bytes: None,
                    uses_private_request_state: false,
                },
                &limits,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse {
                status: StatusCode::METHOD_NOT_ALLOWED,
                headers: vec![("allow".into(), "GET, HEAD".into())],
            })
        );
        assert_eq!(
            admit_request_input(
                &manifest,
                &RequestInput {
                    method: &Method::GET,
                    path: "/missing",
                    declared_body_bytes: None,
                    uses_private_request_state: false,
                },
                &limits,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::NOT_FOUND))
        );
        assert_eq!(
            admit_request_input(
                &manifest,
                &RequestInput {
                    method: &Method::GET,
                    path: "/shop/1?x=1",
                    declared_body_bytes: None,
                    uses_private_request_state: false,
                },
                &limits,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::BAD_REQUEST))
        );
        assert_eq!(
            admit_request_input(
                &manifest,
                &RequestInput {
                    method: &Method::POST,
                    path: "/api/echo",
                    declared_body_bytes: Some(5),
                    uses_private_request_state: false,
                },
                &limits,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::PAYLOAD_TOO_LARGE))
        );
    }

    #[test]
    fn admission_outcomes_map_terminal_actions_to_http_responses() {
        let manifest = compiled();
        let limits = AdmissionLimits { max_body_bytes: 4 };

        match admit_action_input(
            &manifest,
            &ActionInput {
                method: &Method::POST,
                action_id: "action:actions#save",
                origin: Some("https://example.com"),
                expected_origin: Some("https://example.com"),
                declared_body_bytes: Some(4),
            },
            &limits,
        )
        .unwrap()
        {
            AdmissionOutcome::Dispatch(admission) => {
                assert_eq!(admission.target.action.export, "save")
            }
            outcome => panic!("unexpected outcome: {outcome:?}"),
        }

        assert_eq!(
            admit_action_input(
                &manifest,
                &ActionInput {
                    method: &Method::GET,
                    action_id: "action:actions#save",
                    origin: None,
                    expected_origin: None,
                    declared_body_bytes: None,
                },
                &limits,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse {
                status: StatusCode::METHOD_NOT_ALLOWED,
                headers: vec![("allow".into(), "POST".into())],
            })
        );
        assert_eq!(
            admit_action_input(
                &manifest,
                &ActionInput {
                    method: &Method::POST,
                    action_id: "missing",
                    origin: None,
                    expected_origin: None,
                    declared_body_bytes: None,
                },
                &limits,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::NOT_FOUND))
        );
        assert_eq!(
            admit_action_input(
                &manifest,
                &ActionInput {
                    method: &Method::POST,
                    action_id: "action:actions#save",
                    origin: Some("https://evil.example"),
                    expected_origin: Some("https://example.com"),
                    declared_body_bytes: None,
                },
                &limits,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::FORBIDDEN))
        );
        assert_eq!(
            admit_action_input(
                &manifest,
                &ActionInput {
                    method: &Method::POST,
                    action_id: "action:actions#save",
                    origin: None,
                    expected_origin: None,
                    declared_body_bytes: Some(5),
                },
                &limits,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::PAYLOAD_TOO_LARGE))
        );
    }

    #[test]
    fn execution_admission_enforces_context_policy_before_dispatch() {
        let manifest = compiled();
        let limits = AdmissionLimits { max_body_bytes: 16 };
        let policy = ExecutionPolicy {
            require_request_id: true,
            require_authenticated: true,
            max_deadline_ms: 50,
        };
        let context = InvocationContext {
            request_id: Some("req-1"),
            authenticated: true,
            deadline_ms: Some(25),
        };

        match admit_request_execution(
            &manifest,
            &RequestInput {
                method: &Method::POST,
                path: "/api/echo",
                declared_body_bytes: None,
                uses_private_request_state: false,
            },
            &limits,
            &context,
            &policy,
        )
        .unwrap()
        {
            AdmissionOutcome::Dispatch(plan) => {
                assert!(matches!(plan.target, RequestTarget::RouteHandler { .. }));
                assert_eq!(plan.context.request_id.as_deref(), Some("req-1"));
                assert!(plan.context.authenticated);
                assert_eq!(plan.context.deadline_ms, 25);
            }
            outcome => panic!("unexpected outcome: {outcome:?}"),
        }

        assert_eq!(
            admit_request_execution(
                &manifest,
                &RequestInput {
                    method: &Method::POST,
                    path: "/api/echo",
                    declared_body_bytes: None,
                    uses_private_request_state: false,
                },
                &limits,
                &InvocationContext {
                    request_id: None,
                    authenticated: true,
                    deadline_ms: Some(25),
                },
                &policy,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::BAD_REQUEST))
        );
        assert_eq!(
            admit_action_execution(
                &manifest,
                &ActionInput {
                    method: &Method::POST,
                    action_id: "action:actions#save",
                    origin: None,
                    expected_origin: None,
                    declared_body_bytes: None,
                },
                &limits,
                &InvocationContext {
                    request_id: Some("req-2"),
                    authenticated: false,
                    deadline_ms: Some(25),
                },
                &policy,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::UNAUTHORIZED))
        );
        assert_eq!(
            admit_action_execution(
                &manifest,
                &ActionInput {
                    method: &Method::POST,
                    action_id: "action:actions#save",
                    origin: None,
                    expected_origin: None,
                    declared_body_bytes: None,
                },
                &limits,
                &InvocationContext {
                    request_id: Some("req-3"),
                    authenticated: true,
                    deadline_ms: Some(51),
                },
                &policy,
            )
            .unwrap(),
            AdmissionOutcome::Respond(ImmediateResponse::new(StatusCode::BAD_REQUEST))
        );
    }

    #[test]
    fn admits_head_for_get_route_handlers_at_runtime() {
        let manifest = compiled();
        match plan_request(&manifest, &Method::HEAD, "/api/ping").unwrap() {
            RequestTarget::RouteHandler { route, .. } => assert_eq!(route.id, "get-handler"),
            target => panic!("unexpected target: {target:?}"),
        }

        match plan_request(&manifest, &Method::PUT, "/api/ping").unwrap() {
            RequestTarget::MethodNotAllowed { allowed } => {
                assert_eq!(allowed, vec![Method::GET, Method::HEAD]);
            }
            target => panic!("unexpected target: {target:?}"),
        }
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
        match plan_request(&manifest, &Method::HEAD, "/api/ping").unwrap() {
            RequestTarget::RouteHandler { route, .. } => assert_eq!(route.module, "handler"),
            target => panic!("unexpected target: {target:?}"),
        }
        assert!(plan_request(&manifest, &Method::GET, "/shop/%").is_err());
        assert!(plan_request(&manifest, &Method::GET, "/shop/1?x=1").is_err());
        assert!(plan_request(&manifest, &Method::GET, "/shop//1").is_err());
        assert!(plan_request(&manifest, &Method::GET, "/shop/1/").is_err());
    }
}
