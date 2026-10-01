//! Executes built ZapJS artifacts through the Rust-owned runtime and renderer.

use http::{Method, StatusCode};
use serde_json::Value;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use zap_render::{RenderError, Renderer};
use zap_runtime::{
    manifest::{CompiledManifest, ManifestError, RouteHydration},
    request::{
        ActionAdmission, ActionInput, AdmissionLimits, AdmissionOutcome, ExecutionContext,
        ExecutionPolicy, ImmediateResponse, InvocationContext, RequestInput, RequestPlanError,
        RequestTarget, admit_action_execution, admit_request_execution,
    },
};

#[derive(Debug, Error)]
pub enum ExecuteError {
    #[error("manifest error: {0}")]
    Manifest(#[from] ManifestError),
    #[error("request plan error: {0}")]
    RequestPlan(#[from] RequestPlanError),
    #[error("read artifact {path}: {source}")]
    ReadArtifact { path: PathBuf, source: io::Error },
    #[error("render artifact {path}: {source}")]
    RenderArtifact { path: PathBuf, source: RenderError },
    #[error("invalid renderer status {0}")]
    InvalidStatus(u16),
    #[error("hydrate page payload: {0}")]
    HydrationPayload(serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionResponse {
    pub status: StatusCode,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl ExecutionResponse {
    fn new(status: StatusCode) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    fn with_headers(mut self, headers: impl IntoIterator<Item = (String, String)>) -> Self {
        self.headers.extend(headers);
        self
    }

    fn with_body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }
}

pub trait ExecutionAuthorizer: Send + Sync {
    fn authorize_request(
        &self,
        _target: &RequestTarget<'_>,
        _context: &ExecutionContext,
    ) -> Option<ExecutionResponse> {
        None
    }

    fn authorize_action(
        &self,
        _admission: &ActionAdmission<'_>,
        _context: &ExecutionContext,
    ) -> Option<ExecutionResponse> {
        None
    }
}

#[derive(Debug, Default)]
struct AllowAllAuthorizer;

impl ExecutionAuthorizer for AllowAllAuthorizer {}

#[derive(Debug, Clone)]
pub struct RequestExecutionInput<'a> {
    pub method: &'a Method,
    pub path: &'a str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub declared_body_bytes: Option<u64>,
    pub uses_private_request_state: bool,
    pub context: InvocationContext<'a>,
}

impl<'a> RequestExecutionInput<'a> {
    pub fn new(method: &'a Method, path: &'a str) -> Self {
        Self {
            method,
            path,
            headers: Vec::new(),
            body: Vec::new(),
            declared_body_bytes: None,
            uses_private_request_state: false,
            context: InvocationContext {
                request_id: None,
                authenticated: false,
                deadline_ms: None,
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActionExecutionInput<'a> {
    pub method: &'a Method,
    pub action_id: &'a str,
    pub origin: Option<&'a str>,
    pub expected_origin: Option<&'a str>,
    pub declared_body_bytes: Option<u64>,
    pub args: Vec<Value>,
    pub context: InvocationContext<'a>,
}

#[derive(Debug, Clone)]
pub struct ActionEndpointInput<'a> {
    pub method: &'a Method,
    pub path: &'a str,
    pub origin: Option<&'a str>,
    pub expected_origin: Option<&'a str>,
    pub body: &'a [u8],
    pub context: InvocationContext<'a>,
}

pub struct ApplicationExecutor {
    root: PathBuf,
    public_dir: PathBuf,
    manifest: CompiledManifest,
    limits: AdmissionLimits,
    execution_policy: ExecutionPolicy,
    authorizer: Arc<dyn ExecutionAuthorizer>,
}

impl ApplicationExecutor {
    pub fn load(root: impl AsRef<Path>) -> Result<Self, ExecuteError> {
        Self::load_from(root.as_ref(), root.as_ref().join(".zap/manifest.json"))
    }

    pub fn load_from(
        root: impl AsRef<Path>,
        manifest_path: impl AsRef<Path>,
    ) -> Result<Self, ExecuteError> {
        let root = root.as_ref().to_owned();
        let manifest = CompiledManifest::load(manifest_path.as_ref())?;
        Ok(Self {
            public_dir: root.join("public"),
            root,
            manifest,
            limits: AdmissionLimits::default(),
            execution_policy: ExecutionPolicy::default(),
            authorizer: Arc::new(AllowAllAuthorizer),
        })
    }

    pub fn with_public_dir(mut self, public_dir: impl AsRef<Path>) -> Self {
        self.public_dir = public_dir.as_ref().to_owned();
        self
    }

    pub fn with_limits(mut self, limits: AdmissionLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn with_execution_policy(mut self, policy: ExecutionPolicy) -> Self {
        self.execution_policy = policy;
        self
    }

    pub fn with_authorizer(mut self, authorizer: Arc<dyn ExecutionAuthorizer>) -> Self {
        self.authorizer = authorizer;
        self
    }

    pub fn execute_request(
        &self,
        input: &RequestExecutionInput<'_>,
    ) -> Result<ExecutionResponse, ExecuteError> {
        if let Some(asset) = self.browser_asset(input.path) {
            return self.execute_browser_asset(input.method, &asset);
        }

        match admit_request_execution(
            &self.manifest,
            &RequestInput {
                method: input.method,
                path: input.path,
                declared_body_bytes: input.declared_body_bytes,
                uses_private_request_state: input.uses_private_request_state
                    || has_sensitive_headers(&input.headers),
            },
            &self.limits,
            &input.context,
            &self.execution_policy,
        )? {
            AdmissionOutcome::Respond(response) => Ok(immediate_response(response)),
            AdmissionOutcome::Dispatch(plan) => {
                if let Some(response) = self
                    .authorizer
                    .authorize_request(&plan.target, &plan.context)
                {
                    return Ok(response);
                }
                self.dispatch_request(input, plan.target)
            }
        }
    }

    pub fn execute_action_endpoint(
        &self,
        input: &ActionEndpointInput<'_>,
    ) -> Result<ExecutionResponse, ExecuteError> {
        if input.path != "/_zap/action" {
            return Ok(ExecutionResponse::new(StatusCode::NOT_FOUND));
        }
        if input.method != Method::POST {
            return Ok(ExecutionResponse::new(StatusCode::METHOD_NOT_ALLOWED)
                .with_headers([("allow".into(), "POST".into())]));
        }
        let declared_body_bytes = input.body.len() as u64;
        if declared_body_bytes > self.limits.max_body_bytes {
            return Ok(ExecutionResponse::new(StatusCode::PAYLOAD_TOO_LARGE));
        }
        let Some((action_id, args)) = parse_action_endpoint_payload(input.body) else {
            return Ok(ExecutionResponse::new(StatusCode::BAD_REQUEST));
        };

        self.execute_action(&ActionExecutionInput {
            method: input.method,
            action_id: &action_id,
            origin: input.origin,
            expected_origin: input.expected_origin,
            declared_body_bytes: Some(declared_body_bytes),
            args,
            context: input.context.clone(),
        })
    }

    pub fn execute_action(
        &self,
        input: &ActionExecutionInput<'_>,
    ) -> Result<ExecutionResponse, ExecuteError> {
        match admit_action_execution(
            &self.manifest,
            &ActionInput {
                method: input.method,
                action_id: input.action_id,
                origin: input.origin,
                expected_origin: input.expected_origin,
                declared_body_bytes: input.declared_body_bytes,
            },
            &self.limits,
            &input.context,
            &self.execution_policy,
        )? {
            AdmissionOutcome::Respond(response) => Ok(immediate_response(response)),
            AdmissionOutcome::Dispatch(plan) => {
                if let Some(response) = self
                    .authorizer
                    .authorize_action(&plan.target, &plan.context)
                {
                    return Ok(response);
                }
                let admission = plan.target;
                let invocation = &admission.target.invocation;
                let bundle_path = self.root.join(&invocation.server_bundle);
                let bundle = read_artifact_string(&bundle_path)?;
                let invocation_json = invocation.json(input.args.clone())?;
                let rendered = Renderer::new(bundle)
                    .invoke_action_response(&invocation_json)
                    .map_err(|source| ExecuteError::RenderArtifact {
                        path: bundle_path.clone(),
                        source,
                    })?;
                route_response(rendered.status, rendered.headers, rendered.body)
            }
        }
    }

    fn browser_asset(&self, path: &str) -> Option<PathBuf> {
        let relative = path.strip_prefix('/')?;
        if relative.is_empty() || relative.contains(['?', '#', '\\']) {
            return None;
        }
        let requested = PathBuf::from(relative);
        if self
            .manifest
            .manifest()
            .client_references
            .iter()
            .any(|reference| reference.browser_chunk == requested)
        {
            return Some(requested);
        }
        if self.manifest.action_proxy() == Some(requested.as_path()) {
            return Some(requested);
        }
        if self.manifest.browser_bootstrap() == Some(requested.as_path()) {
            return Some(requested);
        }
        None
    }

    fn execute_browser_asset(
        &self,
        method: &Method,
        asset: &Path,
    ) -> Result<ExecutionResponse, ExecuteError> {
        if !matches!(*method, Method::GET | Method::HEAD) {
            return Ok(ExecutionResponse::new(StatusCode::METHOD_NOT_ALLOWED)
                .with_headers([("allow".into(), "GET, HEAD".into())]));
        }
        let source = self.root.join(asset);
        let body = if *method == Method::HEAD {
            Vec::new()
        } else {
            read_artifact_bytes(&source)?
        };
        Ok(ExecutionResponse::new(StatusCode::OK)
            .with_headers([(
                "content-type".into(),
                "text/javascript; charset=utf-8".into(),
            )])
            .with_body(body))
    }

    fn dispatch_request(
        &self,
        input: &RequestExecutionInput<'_>,
        target: RequestTarget<'_>,
    ) -> Result<ExecutionResponse, ExecuteError> {
        match &target {
            RequestTarget::StaticAsset(asset) => {
                let source = self.public_dir.join(&asset.source);
                let body = if input.method == Method::HEAD {
                    Vec::new()
                } else {
                    read_artifact_bytes(&source)?
                };
                Ok(ExecutionResponse::new(StatusCode::OK).with_body(body))
            }
            RequestTarget::Page {
                cache,
                hydration,
                invocation,
                ..
            } => {
                let request_json = target
                    .renderer_request_json(input.path, &input.headers, &input.body)?
                    .expect("page targets produce renderer payloads");
                let wants_flight = wants_flight_response(&input.headers);
                let body = if input.method == Method::HEAD {
                    String::new()
                } else if wants_flight {
                    let bundle_path = self.root.join(&invocation.flight_bundle);
                    let bundle = read_artifact_string(&bundle_path)?;
                    Renderer::new(bundle)
                        .flight(&request_json)
                        .map_err(|source| ExecuteError::RenderArtifact {
                            path: bundle_path.clone(),
                            source,
                        })?
                } else {
                    let bundle_path = self.root.join(&invocation.server_bundle);
                    let bundle = read_artifact_string(&bundle_path)?;
                    let rendered =
                        Renderer::new(bundle)
                            .render(&request_json)
                            .map_err(|source| ExecuteError::RenderArtifact {
                                path: bundle_path.clone(),
                                source,
                            })?;
                    append_hydration_bootstrap(
                        rendered,
                        input.path,
                        &request_json,
                        hydration,
                        self.manifest.action_proxy(),
                        self.manifest.browser_bootstrap(),
                    )?
                };
                let content_type = if wants_flight {
                    "text/x-component; charset=utf-8"
                } else {
                    "text/html; charset=utf-8"
                };
                Ok(ExecutionResponse::new(StatusCode::OK)
                    .with_headers(cache.response_headers())
                    .with_headers([
                        ("content-type".into(), content_type.into()),
                        ("vary".into(), "RSC, Accept".into()),
                    ])
                    .with_body(body.into_bytes()))
            }
            RequestTarget::RouteHandler {
                cache, invocation, ..
            } => {
                let bundle_path = self.root.join(&invocation.server_bundle);
                let bundle = read_artifact_string(&bundle_path)?;
                let request_json = target
                    .renderer_request_json(input.path, &input.headers, &input.body)?
                    .expect("route handler targets produce renderer payloads");
                let rendered = Renderer::new(bundle)
                    .handle_route_response(&request_json)
                    .map_err(|source| ExecuteError::RenderArtifact {
                        path: bundle_path.clone(),
                        source,
                    })?;
                let mut response =
                    route_response(rendered.status, rendered.headers, rendered.body)?;
                if input.method == Method::HEAD {
                    response.body.clear();
                }
                response.headers.extend(cache.response_headers());
                Ok(response)
            }
            RequestTarget::NotFound | RequestTarget::MethodNotAllowed { .. } => {
                unreachable!("terminal request targets are mapped before dispatch")
            }
        }
    }
}

fn route_response(
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
) -> Result<ExecutionResponse, ExecuteError> {
    let status = StatusCode::from_u16(status).map_err(|_| ExecuteError::InvalidStatus(status))?;
    Ok(ExecutionResponse::new(status)
        .with_headers(headers)
        .with_body(body.into_bytes()))
}

fn immediate_response(response: ImmediateResponse) -> ExecutionResponse {
    ExecutionResponse::new(response.status).with_headers(response.headers)
}

fn append_hydration_bootstrap(
    html: String,
    path: &str,
    request_json: &str,
    hydration: &RouteHydration,
    action_proxy: Option<&Path>,
    browser_bootstrap: Option<&Path>,
) -> Result<String, ExecuteError> {
    if hydration.browser_chunks.is_empty() && hydration.client_references.is_empty() {
        return Ok(html);
    }

    let chunks = hydration
        .browser_chunks
        .iter()
        .map(|chunk| browser_asset_url(chunk))
        .collect::<Vec<_>>();
    let references = hydration
        .client_references
        .iter()
        .map(|reference| {
            serde_json::json!({
                "id": reference.id,
                "module": reference.module,
                "export": reference.export,
                "browser_chunk": browser_asset_url(&reference.browser_chunk),
            })
        })
        .collect::<Vec<_>>();
    let request_payload: serde_json::Value =
        serde_json::from_str(request_json).map_err(ExecuteError::HydrationPayload)?;
    let payload = serde_json::json!({
        "path": path,
        "request": {
            "method": request_payload.get("method").cloned().unwrap_or_else(|| serde_json::json!("GET")),
            "path": request_payload.get("path").cloned().unwrap_or_else(|| serde_json::json!(path)),
            "params": request_payload.get("params").cloned().unwrap_or_else(|| serde_json::json!({})),
            "searchParams": request_payload.get("searchParams").cloned().unwrap_or_else(|| serde_json::json!({})),
        },
        "action_proxy": action_proxy.map(browser_asset_url),
        "page_hydration": hydration.page_hydration_chunk.as_ref().map(|chunk| browser_asset_url(chunk)),
        "browser_chunks": chunks,
        "client_references": references,
    });
    let payload = escape_json_for_html_script(
        &serde_json::to_string(&payload).map_err(ExecuteError::HydrationPayload)?,
    );

    let mut bootstrap = String::new();
    for chunk in &hydration.browser_chunks {
        bootstrap.push_str("<link rel=\"modulepreload\" href=\"");
        bootstrap.push_str(&html_attr_escape(&browser_asset_url(chunk)));
        bootstrap.push_str("\">");
    }
    bootstrap.push_str("<script type=\"application/json\" id=\"__zap_hydration\">");
    bootstrap.push_str(&payload);
    bootstrap.push_str("</script>");
    if let Some(browser_bootstrap) = browser_bootstrap {
        bootstrap.push_str("<script type=\"module\" src=\"");
        bootstrap.push_str(&html_attr_escape(&browser_asset_url(browser_bootstrap)));
        bootstrap.push_str("\"></script>");
    }

    if let Some(index) = html.rfind("</body>") {
        let mut output = String::with_capacity(html.len() + bootstrap.len());
        output.push_str(&html[..index]);
        output.push_str(&bootstrap);
        output.push_str(&html[index..]);
        Ok(output)
    } else {
        let mut output = html;
        output.push_str(&bootstrap);
        Ok(output)
    }
}

fn browser_asset_url(path: &Path) -> String {
    format!("/{}", path.to_string_lossy().replace('\\', "/"))
}

fn html_attr_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_json_for_html_script(value: &str) -> String {
    value
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn wants_flight_response(headers: &[(String, String)]) -> bool {
    headers.iter().any(|(name, value)| {
        (name.eq_ignore_ascii_case("rsc") && value.trim() == "1")
            || (name.eq_ignore_ascii_case("accept")
                && value
                    .split(',')
                    .any(|media| media.trim().starts_with("text/x-component")))
    })
}

fn has_sensitive_headers(headers: &[(String, String)]) -> bool {
    headers.iter().any(|(name, _)| {
        name.eq_ignore_ascii_case("cookie") || name.eq_ignore_ascii_case("authorization")
    })
}

fn parse_action_endpoint_payload(body: &[u8]) -> Option<(String, Vec<Value>)> {
    let payload = serde_json::from_slice::<Value>(body).ok()?;
    let object = payload.as_object()?;
    let action_id = object.get("action_id")?.as_str()?.to_owned();
    if action_id.is_empty() {
        return None;
    }
    let args = match object.get("args") {
        Some(Value::Array(values)) => values.clone(),
        None => Vec::new(),
        _ => return None,
    };
    Some((action_id, args))
}

fn read_artifact_string(path: &Path) -> Result<String, ExecuteError> {
    fs::read_to_string(path).map_err(|source| ExecuteError::ReadArtifact {
        path: path.to_owned(),
        source,
    })
}

fn read_artifact_bytes(path: &Path) -> Result<Vec<u8>, ExecuteError> {
    fs::read(path).map_err(|source| ExecuteError::ReadArtifact {
        path: path.to_owned(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use zap_runtime::manifest::{
        ActionRef, ApplicationManifest, AssetRef, CachePolicy, ClientReference, ModuleKind,
        ModuleRef, RouteEntry, RouteKind,
    };

    #[test]
    fn executes_pages_handlers_assets_and_actions_from_manifest() {
        let temp = tempfile::tempdir().unwrap();
        write_fixture(temp.path());
        let executor =
            ApplicationExecutor::load_from(temp.path(), temp.path().join(".zap/manifest.json"))
                .unwrap();

        let page = executor
            .execute_request(&RequestExecutionInput::new(&Method::GET, "/"))
            .unwrap();
        assert_eq!(page.status, StatusCode::OK);
        let page_body = String::from_utf8(page.body).unwrap();
        assert!(page_body.starts_with("<main>GET:/</main>"));
        assert!(
            page_body.contains("<link rel=\"modulepreload\" href=\"/.zap/browser/actions.js\">")
        );
        assert!(
            page_body.contains("<link rel=\"modulepreload\" href=\"/.zap/browser/client.js\">")
        );
        assert!(
            page_body
                .contains("<script type=\"module\" src=\"/.zap/browser/bootstrap.js\"></script>")
        );
        assert!(page_body.contains("id=\"__zap_hydration\""));
        let hydration_json = page_body
            .split("<script type=\"application/json\" id=\"__zap_hydration\">")
            .nth(1)
            .and_then(|value| value.split("</script>").next())
            .unwrap();
        let hydration: serde_json::Value = serde_json::from_str(hydration_json).unwrap();
        assert_eq!(hydration["path"], "/");
        assert_eq!(hydration["action_proxy"], "/.zap/browser/actions.js");
        assert_eq!(hydration["page_hydration"], "/.zap/browser/page.hydrate.js");
        assert_eq!(hydration["request"]["method"], "GET");
        assert_eq!(hydration["request"]["path"], "/");
        assert_eq!(
            hydration["browser_chunks"],
            serde_json::json!([
                "/.zap/browser/actions.js",
                "/.zap/browser/bootstrap.js",
                "/.zap/browser/client.js",
                "/.zap/browser/page.hydrate.js"
            ])
        );
        assert_eq!(hydration["client_references"].as_array().unwrap().len(), 1);
        assert_eq!(
            hydration["client_references"][0]["id"],
            "client:client#Counter"
        );
        assert_eq!(hydration["client_references"][0]["module"], "client");
        assert_eq!(hydration["client_references"][0]["export"], "Counter");
        assert_eq!(
            hydration["client_references"][0]["browser_chunk"],
            "/.zap/browser/client.js"
        );
        assert!(
            page.headers
                .contains(&("content-type".into(), "text/html; charset=utf-8".into()))
        );

        let query_page = executor
            .execute_request(&RequestExecutionInput {
                headers: vec![("accept-language".into(), "en-US".into())],
                ..RequestExecutionInput::new(&Method::GET, "/?q=rust+search")
            })
            .unwrap();
        assert_eq!(query_page.status, StatusCode::OK);
        assert!(
            String::from_utf8(query_page.body)
                .unwrap()
                .starts_with("<main>GET:/:rust search:en-US</main>"),
        );

        let flight_page = executor
            .execute_request(&RequestExecutionInput {
                headers: vec![
                    ("rsc".into(), "1".into()),
                    ("accept".into(), "text/x-component".into()),
                ],
                ..RequestExecutionInput::new(&Method::GET, "/")
            })
            .unwrap();
        assert_eq!(flight_page.status, StatusCode::OK);
        assert!(flight_page.headers.contains(&(
            "content-type".into(),
            "text/x-component; charset=utf-8".into()
        )));
        assert!(
            flight_page
                .headers
                .contains(&("vary".into(), "RSC, Accept".into()))
        );
        assert_eq!(
            String::from_utf8(flight_page.body).unwrap(),
            "flight:GET:/:1"
        );

        let client_asset = executor
            .execute_request(&RequestExecutionInput::new(
                &Method::GET,
                "/.zap/browser/client.js",
            ))
            .unwrap();
        assert_eq!(client_asset.status, StatusCode::OK);
        assert_eq!(
            client_asset.headers,
            vec![(
                "content-type".into(),
                "text/javascript; charset=utf-8".into()
            )]
        );
        assert_eq!(
            String::from_utf8(client_asset.body).unwrap(),
            "export const Counter = 1;"
        );

        let action_asset = executor
            .execute_request(&RequestExecutionInput::new(
                &Method::GET,
                "/.zap/browser/actions.js",
            ))
            .unwrap();
        assert_eq!(action_asset.status, StatusCode::OK);
        assert_eq!(
            String::from_utf8(action_asset.body).unwrap(),
            "export const actions = {};"
        );

        let bootstrap_asset = executor
            .execute_request(&RequestExecutionInput::new(
                &Method::GET,
                "/.zap/browser/bootstrap.js",
            ))
            .unwrap();
        assert_eq!(bootstrap_asset.status, StatusCode::OK);
        assert_eq!(
            String::from_utf8(bootstrap_asset.body).unwrap(),
            "globalThis.__zap_bootstrap = true;"
        );

        let browser_wrong_method = executor
            .execute_request(&RequestExecutionInput::new(
                &Method::POST,
                "/.zap/browser/client.js",
            ))
            .unwrap();
        assert_eq!(browser_wrong_method.status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            browser_wrong_method.headers,
            vec![("allow".into(), "GET, HEAD".into())]
        );

        let head = executor
            .execute_request(&RequestExecutionInput::new(&Method::HEAD, "/"))
            .unwrap();
        assert_eq!(head.status, StatusCode::OK);
        assert!(head.body.is_empty());

        let route = executor
            .execute_request(&RequestExecutionInput {
                body: br#"{"name":"zap"}"#.to_vec(),
                declared_body_bytes: Some(14),
                ..RequestExecutionInput::new(&Method::POST, "/api/echo")
            })
            .unwrap();
        assert_eq!(route.status, StatusCode::ACCEPTED);
        assert_eq!(
            route.headers,
            vec![
                ("x-zap-route".into(), "echo".into()),
                ("cache-control".into(), "private, no-store".into())
            ]
        );
        assert_eq!(
            String::from_utf8(route.body).unwrap(),
            r#"echo:POST:/api/echo:{"name":"zap"}"#
        );

        let asset = executor
            .execute_request(&RequestExecutionInput::new(&Method::GET, "/logo.txt"))
            .unwrap();
        assert_eq!(asset.status, StatusCode::OK);
        assert_eq!(String::from_utf8(asset.body).unwrap(), "zap");

        let action = executor
            .execute_action(&ActionExecutionInput {
                method: &Method::POST,
                action_id: "action:actions#save",
                origin: Some("https://example.com"),
                expected_origin: Some("https://example.com"),
                declared_body_bytes: None,
                args: vec![serde_json::json!({"id": 7})],
                context: InvocationContext {
                    request_id: Some("action-1"),
                    authenticated: true,
                    deadline_ms: Some(1000),
                },
            })
            .unwrap();
        assert_eq!(action.status, StatusCode::CREATED);
        assert_eq!(String::from_utf8(action.body).unwrap(), "saved:7");

        let endpoint = executor
            .execute_action_endpoint(&ActionEndpointInput {
                method: &Method::POST,
                path: "/_zap/action",
                origin: Some("https://example.com"),
                expected_origin: Some("https://example.com"),
                body: br#"{"action_id":"action:actions#save","args":[{"id":8}]}"#,
                context: InvocationContext {
                    request_id: Some("action-2"),
                    authenticated: true,
                    deadline_ms: Some(1000),
                },
            })
            .unwrap();
        assert_eq!(endpoint.status, StatusCode::CREATED);
        assert_eq!(String::from_utf8(endpoint.body).unwrap(), "saved:8");
    }

    #[test]
    fn action_endpoint_enforces_browser_proxy_contract() {
        let temp = tempfile::tempdir().unwrap();
        write_fixture(temp.path());
        let executor =
            ApplicationExecutor::load_from(temp.path(), temp.path().join(".zap/manifest.json"))
                .unwrap();

        let wrong_path = executor
            .execute_action_endpoint(&ActionEndpointInput {
                method: &Method::POST,
                path: "/api/action",
                origin: Some("https://example.com"),
                expected_origin: Some("https://example.com"),
                body: br#"{"action_id":"action:actions#save","args":[]}"#,
                context: InvocationContext {
                    request_id: Some("action-3"),
                    authenticated: true,
                    deadline_ms: Some(1000),
                },
            })
            .unwrap();
        assert_eq!(wrong_path.status, StatusCode::NOT_FOUND);

        let wrong_method = executor
            .execute_action_endpoint(&ActionEndpointInput {
                method: &Method::GET,
                path: "/_zap/action",
                origin: Some("https://example.com"),
                expected_origin: Some("https://example.com"),
                body: br#"{"action_id":"action:actions#save","args":[]}"#,
                context: InvocationContext {
                    request_id: Some("action-4"),
                    authenticated: true,
                    deadline_ms: Some(1000),
                },
            })
            .unwrap();
        assert_eq!(wrong_method.status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(wrong_method.headers, vec![("allow".into(), "POST".into())]);

        let malformed = executor
            .execute_action_endpoint(&ActionEndpointInput {
                method: &Method::POST,
                path: "/_zap/action",
                origin: Some("https://example.com"),
                expected_origin: Some("https://example.com"),
                body: br#"{"args":[]}"#,
                context: InvocationContext {
                    request_id: Some("action-5"),
                    authenticated: true,
                    deadline_ms: Some(1000),
                },
            })
            .unwrap();
        assert_eq!(malformed.status, StatusCode::BAD_REQUEST);

        let denied_origin = executor
            .execute_action_endpoint(&ActionEndpointInput {
                method: &Method::POST,
                path: "/_zap/action",
                origin: Some("https://evil.example"),
                expected_origin: Some("https://example.com"),
                body: br#"{"action_id":"action:actions#save","args":[]}"#,
                context: InvocationContext {
                    request_id: Some("action-6"),
                    authenticated: true,
                    deadline_ms: Some(1000),
                },
            })
            .unwrap();
        assert_eq!(denied_origin.status, StatusCode::FORBIDDEN);

        let too_large = executor
            .with_limits(AdmissionLimits { max_body_bytes: 4 })
            .execute_action_endpoint(&ActionEndpointInput {
                method: &Method::POST,
                path: "/_zap/action",
                origin: Some("https://example.com"),
                expected_origin: Some("https://example.com"),
                body: br#"{"action_id":"action:actions#save","args":[]}"#,
                context: InvocationContext {
                    request_id: Some("action-7"),
                    authenticated: true,
                    deadline_ms: Some(1000),
                },
            })
            .unwrap();
        assert_eq!(too_large.status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn maps_terminal_admission_to_responses() {
        let temp = tempfile::tempdir().unwrap();
        write_fixture(temp.path());
        let executor =
            ApplicationExecutor::load_from(temp.path(), temp.path().join(".zap/manifest.json"))
                .unwrap();

        let missing = executor
            .execute_request(&RequestExecutionInput::new(&Method::GET, "/missing"))
            .unwrap();
        assert_eq!(missing.status, StatusCode::NOT_FOUND);

        let wrong_method = executor
            .execute_request(&RequestExecutionInput::new(&Method::PUT, "/"))
            .unwrap();
        assert_eq!(wrong_method.status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            wrong_method.headers,
            vec![("allow".into(), "GET, HEAD".into())]
        );
    }

    #[test]
    fn execution_policy_denies_missing_authenticated_context_before_dispatch() {
        let temp = tempfile::tempdir().unwrap();
        write_fixture(temp.path());
        let executor =
            ApplicationExecutor::load_from(temp.path(), temp.path().join(".zap/manifest.json"))
                .unwrap()
                .with_execution_policy(ExecutionPolicy {
                    require_request_id: false,
                    require_authenticated: true,
                    max_deadline_ms: 1000,
                });

        let denied = executor
            .execute_request(&RequestExecutionInput::new(&Method::GET, "/"))
            .unwrap();
        assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
        assert!(denied.body.is_empty());
    }

    #[test]
    fn authorizer_can_deny_requests_and_actions_before_artifact_execution() {
        #[derive(Debug)]
        struct DenyAll;
        impl ExecutionAuthorizer for DenyAll {
            fn authorize_request(
                &self,
                _target: &RequestTarget<'_>,
                context: &ExecutionContext,
            ) -> Option<ExecutionResponse> {
                assert_eq!(context.request_id.as_deref(), Some("request-1"));
                Some(ExecutionResponse::new(StatusCode::FORBIDDEN).with_body("request denied"))
            }

            fn authorize_action(
                &self,
                _admission: &ActionAdmission<'_>,
                context: &ExecutionContext,
            ) -> Option<ExecutionResponse> {
                assert_eq!(context.request_id.as_deref(), Some("action-1"));
                Some(ExecutionResponse::new(StatusCode::FORBIDDEN).with_body("action denied"))
            }
        }

        let temp = tempfile::tempdir().unwrap();
        write_fixture(temp.path());
        let executor =
            ApplicationExecutor::load_from(temp.path(), temp.path().join(".zap/manifest.json"))
                .unwrap()
                .with_execution_policy(ExecutionPolicy {
                    require_request_id: true,
                    require_authenticated: true,
                    max_deadline_ms: 1000,
                })
                .with_authorizer(Arc::new(DenyAll));

        let request = executor
            .execute_request(&RequestExecutionInput {
                context: InvocationContext {
                    request_id: Some("request-1"),
                    authenticated: true,
                    deadline_ms: Some(500),
                },
                ..RequestExecutionInput::new(&Method::GET, "/")
            })
            .unwrap();
        assert_eq!(request.status, StatusCode::FORBIDDEN);
        assert_eq!(String::from_utf8(request.body).unwrap(), "request denied");

        let action = executor
            .execute_action(&ActionExecutionInput {
                method: &Method::POST,
                action_id: "action:actions#save",
                origin: Some("https://example.com"),
                expected_origin: Some("https://example.com"),
                declared_body_bytes: None,
                args: vec![serde_json::json!({"id": 7})],
                context: InvocationContext {
                    request_id: Some("action-1"),
                    authenticated: true,
                    deadline_ms: Some(500),
                },
            })
            .unwrap();
        assert_eq!(action.status, StatusCode::FORBIDDEN);
        assert_eq!(String::from_utf8(action.body).unwrap(), "action denied");
    }

    fn write_fixture(root: &Path) {
        fs::create_dir_all(root.join(".zap/server/api/echo")).unwrap();
        fs::create_dir_all(root.join("public")).unwrap();
        fs::write(root.join("public/logo.txt"), "zap").unwrap();
        fs::write(
            root.join(".zap/server/page.js"),
            r#"globalThis.ZapRender = { render(request) { const q = request.searchParams && request.searchParams.q ? `:${request.searchParams.q[0]}` : ""; const lang = request.headers && request.headers["accept-language"] ? `:${request.headers["accept-language"]}` : ""; return `<main>${request.method}:${request.path}${q}${lang}</main>`; } };"#,
        )
        .unwrap();
        fs::write(
            root.join(".zap/server/page.flight.js"),
            r#"globalThis.ZapRender = { flight(request) { return `flight:${request.method}:${request.path}:${request.headers["rsc"] || "0"}`; } };"#,
        )
        .unwrap();
        fs::write(
            root.join(".zap/server/api/echo/route.js"),
            r#"globalThis.ZapRoute = { handle(request) { return new Response(`echo:${request.method}:${request.path}:${request.body}`, { status: 202, headers: { "x-zap-route": "echo" } }); } };"#,
        )
        .unwrap();
        fs::write(
            root.join(".zap/server/actions.js"),
            r#"globalThis.ZapAction = { invoke(invocation) { return new Response(`saved:${invocation.args[0].id}`, { status: 201 }); } };"#,
        )
        .unwrap();
        fs::create_dir_all(root.join(".zap/browser")).unwrap();
        fs::write(
            root.join(".zap/browser/client.js"),
            "export const Counter = 1;",
        )
        .unwrap();
        fs::write(
            root.join(".zap/browser/actions.js"),
            "export const actions = {};",
        )
        .unwrap();
        fs::write(
            root.join(".zap/browser/bootstrap.js"),
            "globalThis.__zap_bootstrap = true;",
        )
        .unwrap();
        fs::write(
            root.join(".zap/browser/page.hydrate.js"),
            "export function hydrateZapPage(){}",
        )
        .unwrap();
        let manifest = ApplicationManifest {
            routes: vec![
                RouteEntry {
                    id: "page".into(),
                    pattern: "/".into(),
                    kind: RouteKind::Page,
                    source: PathBuf::from("page.tsx"),
                    layouts: Vec::new(),
                    module: "page".into(),
                    methods: vec!["GET".into(), "HEAD".into()],
                    cache: CachePolicy::default(),
                    client_references: vec!["client:client#Counter".into()],
                },
                RouteEntry {
                    id: "echo".into(),
                    pattern: "/api/echo".into(),
                    kind: RouteKind::Handler,
                    source: PathBuf::from("api/echo/route.ts"),
                    layouts: Vec::new(),
                    module: "echo".into(),
                    methods: vec!["POST".into()],
                    cache: CachePolicy::default(),
                    client_references: Vec::new(),
                },
            ],
            layouts: Vec::new(),
            modules: vec![
                ModuleRef {
                    id: "page".into(),
                    path: PathBuf::from("page.tsx"),
                    kind: ModuleKind::Server,
                    browser_chunk: None,
                    server_bundle: Some(PathBuf::from(".zap/server/page.js")),
                    flight_bundle: Some(PathBuf::from(".zap/server/page.flight.js")),
                    hydration_bundle: Some(PathBuf::from(".zap/browser/page.hydrate.js")),
                },
                ModuleRef {
                    id: "echo".into(),
                    path: PathBuf::from("api/echo/route.ts"),
                    kind: ModuleKind::Server,
                    browser_chunk: None,
                    server_bundle: Some(PathBuf::from(".zap/server/api/echo/route.js")),
                    flight_bundle: None,
                    hydration_bundle: None,
                },
                ModuleRef {
                    id: "actions".into(),
                    path: PathBuf::from("actions.ts"),
                    kind: ModuleKind::ServerActions,
                    browser_chunk: None,
                    server_bundle: Some(PathBuf::from(".zap/server/actions.js")),
                    flight_bundle: None,
                    hydration_bundle: None,
                },
                ModuleRef {
                    id: "client".into(),
                    path: PathBuf::from("client.tsx"),
                    kind: ModuleKind::Client,
                    browser_chunk: Some(PathBuf::from(".zap/browser/client.js")),
                    server_bundle: None,
                    flight_bundle: None,
                    hydration_bundle: None,
                },
            ],
            actions: vec![ActionRef {
                id: "action:actions#save".into(),
                module: "actions".into(),
                export: "save".into(),
                path: PathBuf::from("actions.ts"),
            }],
            action_proxy: Some(PathBuf::from(".zap/browser/actions.js")),
            browser_bootstrap: Some(PathBuf::from(".zap/browser/bootstrap.js")),
            client_references: vec![ClientReference {
                id: "client:client#Counter".into(),
                module: "client".into(),
                export: "Counter".into(),
                path: PathBuf::from("client.tsx"),
                browser_chunk: PathBuf::from(".zap/browser/client.js"),
            }],
            assets: vec![AssetRef {
                source: PathBuf::from("logo.txt"),
                url_path: "/logo.txt".into(),
            }],
        };
        fs::create_dir_all(root.join(".zap")).unwrap();
        fs::write(
            root.join(".zap/manifest.json"),
            manifest.to_manifest_json().unwrap(),
        )
        .unwrap();
    }
}
