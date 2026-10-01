//! Runs compiler-produced React bundles inside a Rust-owned QuickJS context.
//! Every invocation gets an isolated heap with only the Web primitives and
//! Rust host functions installed by ZapJS.

use rquickjs::{Context, Ctx, Exception, Function, Promise, Runtime, TypedArray};
use serde::Deserialize;
use std::{
    cell::RefCell,
    collections::HashMap,
    fmt,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub type Host = Arc<dyn Fn(&str, &str) -> Result<String, String> + Send + Sync>;

#[derive(Debug)]
pub struct RenderError(pub String);
impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for RenderError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

pub type ActionResponse = RouteResponse;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionOutcome<T> {
    Complete(T),
    Failed(ExecutionFailure),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionFailure {
    pub status: u16,
    pub public_message: String,
    pub diagnostic: String,
}

pub type RouteExecution = ExecutionOutcome<RouteResponse>;
pub type ActionExecution = ExecutionOutcome<ActionResponse>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RouteResponseMetadata {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone)]
pub struct Limits {
    pub memory_bytes: usize,
    pub output_bytes: usize,
    pub timeout: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            memory_bytes: 128 * 1024 * 1024,
            output_bytes: 16 * 1024 * 1024,
            timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Clone)]
pub struct Renderer {
    bundle: Arc<str>,
    host: Host,
    limits: Limits,
}

impl Renderer {
    /// Page IIFEs must define `ZapRender.render(request)`. Route-handler IIFEs
    /// must define `ZapRoute.handle(request)`. Page entries return text or a Web
    /// `ReadableStream` after the build-generated React SSR adapter has converted
    /// React render trees with `renderToReadableStream`. Route-handler entries
    /// return text, `Response`, or a Web `ReadableStream`.
    pub fn new(bundle: impl Into<String>) -> Self {
        Self {
            bundle: Arc::from(bundle.into()),
            host: Arc::new(|name, _| Err(format!("Unknown Rust host operation: {name}"))),
            limits: Limits::default(),
        }
    }
    pub fn with_host(mut self, host: Host) -> Self {
        self.host = host;
        self
    }
    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }
    pub fn render(&self, request_json: &str) -> Result<String, RenderError> {
        self.collect_text(request_json, |renderer, input, cancelled, sink| {
            renderer.render_stream(input, cancelled, sink)
        })
    }

    pub fn flight(&self, request_json: &str) -> Result<String, RenderError> {
        self.collect_text(request_json, |renderer, input, cancelled, sink| {
            renderer.flight_stream(input, cancelled, sink)
        })
    }
    pub fn handle_route(&self, request_json: &str) -> Result<String, RenderError> {
        Ok(self.handle_route_response(request_json)?.body)
    }

    pub fn invoke_action(&self, invocation_json: &str) -> Result<String, RenderError> {
        Ok(self.invoke_action_response(invocation_json)?.body)
    }

    pub fn handle_route_response(&self, request_json: &str) -> Result<RouteResponse, RenderError> {
        let bytes = Rc::new(RefCell::new(Vec::new()));
        let sink = bytes.clone();
        let metadata = self.route_response_stream(
            request_json,
            Arc::new(AtomicBool::new(false)),
            move |chunk| {
                sink.borrow_mut().extend(chunk);
                Ok(())
            },
        )?;
        let bytes = std::mem::take(&mut *bytes.borrow_mut());
        let body = String::from_utf8(bytes)
            .map_err(|error| RenderError(format!("Route output is not UTF-8: {error}")))?;
        Ok(RouteResponse {
            status: metadata.status,
            headers: metadata.headers,
            body,
        })
    }

    pub fn execute_route(&self, request_json: &str) -> RouteExecution {
        match self.handle_route_response(request_json) {
            Ok(response) => ExecutionOutcome::Complete(response),
            Err(error) => ExecutionOutcome::Failed(execution_failure("Route", error)),
        }
    }

    pub fn invoke_action_response(
        &self,
        invocation_json: &str,
    ) -> Result<ActionResponse, RenderError> {
        let bytes = Rc::new(RefCell::new(Vec::new()));
        let sink = bytes.clone();
        let metadata = self.action_response_stream(
            invocation_json,
            Arc::new(AtomicBool::new(false)),
            move |chunk| {
                sink.borrow_mut().extend(chunk);
                Ok(())
            },
        )?;
        let bytes = std::mem::take(&mut *bytes.borrow_mut());
        let body = String::from_utf8(bytes)
            .map_err(|error| RenderError(format!("Action output is not UTF-8: {error}")))?;
        Ok(ActionResponse {
            status: metadata.status,
            headers: metadata.headers,
            body,
        })
    }

    pub fn execute_action(&self, invocation_json: &str) -> ActionExecution {
        match self.invoke_action_response(invocation_json) {
            Ok(response) => ExecutionOutcome::Complete(response),
            Err(error) => ExecutionOutcome::Failed(execution_failure("Action", error)),
        }
    }

    /// Streams actual React chunks as they are produced. The sink owns transport
    /// backpressure and must return an error on disconnect. A sink that blocks
    /// must enforce its own deadline; engine interrupts cannot interrupt Rust.
    pub fn render_stream<F>(
        &self,
        request_json: &str,
        cancelled: Arc<AtomicBool>,
        sink: F,
    ) -> Result<(), RenderError>
    where
        F: FnMut(Vec<u8>) -> Result<(), String> + 'static,
    {
        self.entry_stream(
            "__zap_consume(ZapRender.render(JSON.parse(__zap_input))).then(() => '')",
            request_json,
            cancelled,
            sink,
        )
    }

    /// Streams React Flight/RSC payload chunks through the explicit
    /// `ZapRender.flight` contract generated for page modules.
    pub fn flight_stream<F>(
        &self,
        request_json: &str,
        cancelled: Arc<AtomicBool>,
        sink: F,
    ) -> Result<(), RenderError>
    where
        F: FnMut(Vec<u8>) -> Result<(), String> + 'static,
    {
        self.entry_stream(
            "__zap_consume(ZapRender.flight(JSON.parse(__zap_input))).then(() => '')",
            request_json,
            cancelled,
            sink,
        )
    }

    /// Streams route-handler output through the explicit `ZapRoute.handle`
    /// contract generated by `zap-build` for route modules.
    pub fn route_stream<F>(
        &self,
        request_json: &str,
        cancelled: Arc<AtomicBool>,
        sink: F,
    ) -> Result<(), RenderError>
    where
        F: FnMut(Vec<u8>) -> Result<(), String> + 'static,
    {
        self.route_response_stream(request_json, cancelled, sink)
            .map(|_| ())
    }

    pub fn route_response_stream<F>(
        &self,
        request_json: &str,
        cancelled: Arc<AtomicBool>,
        sink: F,
    ) -> Result<RouteResponseMetadata, RenderError>
    where
        F: FnMut(Vec<u8>) -> Result<(), String> + 'static,
    {
        self.response_metadata_stream(
            "__zap_entry_response(ZapRoute.handle(JSON.parse(__zap_input)))",
            request_json,
            cancelled,
            sink,
            "Route",
        )
    }

    pub fn action_response_stream<F>(
        &self,
        invocation_json: &str,
        cancelled: Arc<AtomicBool>,
        sink: F,
    ) -> Result<RouteResponseMetadata, RenderError>
    where
        F: FnMut(Vec<u8>) -> Result<(), String> + 'static,
    {
        self.response_metadata_stream(
            "__zap_entry_response(ZapAction.invoke(JSON.parse(__zap_input)))",
            invocation_json,
            cancelled,
            sink,
            "Action",
        )
    }

    fn collect_text<F>(&self, input_json: &str, stream: F) -> Result<String, RenderError>
    where
        F: FnOnce(
            &Self,
            &str,
            Arc<AtomicBool>,
            Box<dyn FnMut(Vec<u8>) -> Result<(), String>>,
        ) -> Result<(), RenderError>,
    {
        let bytes = Rc::new(RefCell::new(Vec::new()));
        let sink = bytes.clone();
        stream(
            self,
            input_json,
            Arc::new(AtomicBool::new(false)),
            Box::new(move |chunk| {
                sink.borrow_mut().extend(chunk);
                Ok(())
            }),
        )?;
        let bytes = std::mem::take(&mut *bytes.borrow_mut());
        String::from_utf8(bytes)
            .map_err(|error| RenderError(format!("Render output is not UTF-8: {error}")))
    }

    fn response_metadata_stream<F>(
        &self,
        entry_expression: &'static str,
        input_json: &str,
        cancelled: Arc<AtomicBool>,
        sink: F,
        label: &str,
    ) -> Result<RouteResponseMetadata, RenderError>
    where
        F: FnMut(Vec<u8>) -> Result<(), String> + 'static,
    {
        let json = self.entry_value_stream(entry_expression, input_json, cancelled, sink)?;
        let metadata: RouteResponseMetadata = serde_json::from_str(&json).map_err(|error| {
            RenderError(format!("{label} response metadata is invalid: {error}"))
        })?;
        if !(200..=599).contains(&metadata.status) {
            return Err(RenderError(format!(
                "{label} response status is invalid: {}",
                metadata.status
            )));
        }
        validate_response_headers(label, &metadata.headers)?;
        Ok(metadata)
    }

    fn entry_stream<F>(
        &self,
        entry_expression: &'static str,
        request_json: &str,
        cancelled: Arc<AtomicBool>,
        sink: F,
    ) -> Result<(), RenderError>
    where
        F: FnMut(Vec<u8>) -> Result<(), String> + 'static,
    {
        self.entry_value_stream(entry_expression, request_json, cancelled, sink)
            .map(|_| ())
    }

    fn entry_value_stream<F>(
        &self,
        entry_expression: &'static str,
        request_json: &str,
        cancelled: Arc<AtomicBool>,
        mut sink: F,
    ) -> Result<String, RenderError>
    where
        F: FnMut(Vec<u8>) -> Result<(), String> + 'static,
    {
        let start = Instant::now();
        let deadline = start + self.limits.timeout;
        let runtime = Runtime::new().map_err(engine_error)?;
        runtime.set_memory_limit(self.limits.memory_bytes);
        runtime.set_max_stack_size(2 * 1024 * 1024);
        let interrupt = cancelled.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            interrupt.load(Ordering::Relaxed) || Instant::now() >= deadline
        })));
        let context = Context::full(&runtime).map_err(engine_error)?;
        context.with(|ctx| {
            let execute = || -> rquickjs::Result<String> {
                ctx.globals().set(
                    "__zap_now",
                    Function::new(ctx.clone(), move || start.elapsed().as_secs_f64() * 1000.0)?,
                )?;
                ctx.globals()
                    .set("__zap_encode", Function::new(ctx.clone(), encode)?)?;
                install_decoder(&ctx)?;
                let host = self.host.clone();
                ctx.globals().set(
                    "__zap_call",
                    Function::new(ctx.clone(), move |ctx: Ctx, name: String, input: String| {
                        host(&name, &input)
                            .map_err(|message| Exception::throw_message(&ctx, &message))
                    })?,
                )?;
                let mut total = 0usize;
                let maximum = self.limits.output_bytes;
                ctx.globals().set(
                    "__zap_emit",
                    Function::new(
                        ctx.clone(),
                        rquickjs::function::MutFn::new(move |ctx: Ctx, bytes: TypedArray<u8>| {
                            // rquickjs typed-array slices are valid only until JavaScript runs again.
                            let bytes = unsafe { bytes.as_bytes() }.ok_or_else(|| {
                                Exception::throw_message(&ctx, "Detached stream chunk")
                            })?;
                            total = total.checked_add(bytes.len()).ok_or_else(|| {
                                Exception::throw_message(&ctx, "Render output limit exceeded")
                            })?;
                            if total > maximum {
                                return Err(Exception::throw_message(
                                    &ctx,
                                    "Render output limit exceeded",
                                ));
                            }
                            sink(bytes.to_vec())
                                .map_err(|message| Exception::throw_message(&ctx, &message))
                        }),
                    )?,
                )?;
                ctx.eval::<(), _>(include_str!("host.js"))?;
                ctx.eval::<(), _>(include_str!("../polyfills/abort.js"))?;
                ctx.eval::<(), _>(include_str!("../polyfills/streams.js"))?;
                ctx.eval::<(), _>(self.bundle.as_bytes())?;
                ctx.globals().set("__zap_input", request_json)?;
                let promise: Promise = ctx.eval(entry_expression)?;
                let pump: Function = ctx.globals().get("__zap_pump")?;
                loop {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err(Exception::throw_message(&ctx, "Render cancelled"));
                    }
                    if Instant::now() >= deadline {
                        return Err(Exception::throw_message(&ctx, "Render deadline exceeded"));
                    }
                    if let Some(result) = promise.result::<String>() {
                        return result;
                    }
                    // Bound each microtask batch so a self-replenishing queue cannot
                    // starve cancellation checks or timer callbacks.
                    let mut ran_job = false;
                    for _ in 0..256 {
                        if !ctx.execute_pending_job() {
                            break;
                        }
                        ran_job = true;
                    }
                    pump.call::<_, ()>(())?;
                    if !ran_job {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
            };
            execute().map_err(|error| {
                if error.is_exception() {
                    RenderError(format!("JavaScript render failed: {:?}", ctx.catch()))
                } else {
                    engine_error(error)
                }
            })
        })
    }
}

fn validate_response_headers(label: &str, headers: &[(String, String)]) -> Result<(), RenderError> {
    for (name, value) in headers {
        if !is_valid_header_name(name) {
            return Err(RenderError(format!(
                "{label} response header name is invalid: {name:?}"
            )));
        }
        if !is_valid_header_value(value) {
            return Err(RenderError(format!(
                "{label} response header value is invalid for {name:?}"
            )));
        }
    }
    Ok(())
}

fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            matches!(
                byte,
                b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^'
                    | b'_' | b'`' | b'|' | b'~' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z'
            )
        })
}

fn is_valid_header_value(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| matches!(byte, b'\t' | b' '..=b'~' | 0x80..=0xff))
}

fn execution_failure(label: &str, error: RenderError) -> ExecutionFailure {
    ExecutionFailure {
        status: 500,
        public_message: format!("{label} execution failed"),
        diagnostic: error.to_string(),
    }
}

fn engine_error(error: rquickjs::Error) -> RenderError {
    RenderError(error.to_string())
}
fn encode<'js>(ctx: Ctx<'js>, text: String) -> rquickjs::Result<TypedArray<'js, u8>> {
    TypedArray::new(ctx, text.into_bytes())
}

fn install_decoder(ctx: &Ctx) -> rquickjs::Result<()> {
    let decoders = Rc::new(RefCell::new(HashMap::<u32, encoding_rs::Decoder>::new()));
    let created = decoders.clone();
    ctx.globals().set(
        "__zap_decoder",
        Function::new(ctx.clone(), move |ignore_bom: bool| {
            let mut values = created.borrow_mut();
            let id = values.len() as u32;
            values.insert(
                id,
                if ignore_bom {
                    encoding_rs::UTF_8.new_decoder_without_bom_handling()
                } else {
                    encoding_rs::UTF_8.new_decoder_with_bom_removal()
                },
            );
            id
        })?,
    )?;
    ctx.globals().set(
        "__zap_decode",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx, id: u32, bytes: TypedArray<u8>, stream: bool, fatal: bool| {
                let mut values = decoders.borrow_mut();
                let decoder = values
                    .get_mut(&id)
                    .ok_or_else(|| Exception::throw_message(&ctx, "Invalid decoder"))?;
                // Copy immediately; JavaScript may detach or move the backing store on the next turn.
                let bytes = unsafe { bytes.as_bytes() }
                    .ok_or_else(|| Exception::throw_message(&ctx, "Detached decoder input"))?;
                let mut output = String::with_capacity(bytes.len().saturating_mul(3) + 16);
                let (_, read, malformed) = decoder.decode_to_string(bytes, &mut output, !stream);
                if read != bytes.len() {
                    return Err(Exception::throw_message(
                        &ctx,
                        "Decoder output capacity exceeded",
                    ));
                }
                if fatal && malformed {
                    return Err(Exception::throw_type(&ctx, "Invalid UTF-8"));
                }
                Ok(output)
            },
        )?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn renderer(body: &str) -> Renderer {
        Renderer::new(format!(
            "globalThis.ZapRender={{render(request){{{body}}}}};"
        ))
    }

    fn flight_renderer(body: &str) -> Renderer {
        Renderer::new(format!(
            "globalThis.ZapRender={{flight(request){{{body}}}}};"
        ))
    }

    fn route_handler(body: &str) -> Renderer {
        Renderer::new(format!(
            "globalThis.ZapRoute={{handle(request){{{body}}}}};"
        ))
    }

    fn action_handler(body: &str) -> Renderer {
        Renderer::new(format!(
            "globalThis.ZapAction={{invoke(invocation){{{body}}}}};"
        ))
    }

    #[test]
    fn renders_text_from_bundle() {
        let output = renderer("return `<h1>${request.title}</h1>`;")
            .render(r#"{"title":"Zap"}"#)
            .unwrap();
        assert_eq!(output, "<h1>Zap</h1>");
    }

    #[test]
    fn renders_flight_payload_from_bundle() {
        let output = flight_renderer("return `flight:${request.path}:${request.params.id}`;")
            .flight(r#"{"path":"/shop/1","params":{"id":"1"}}"#)
            .unwrap();
        assert_eq!(output, "flight:/shop/1:1");
    }

    #[test]
    fn streams_readable_stream_chunks() {
        let output = renderer(
            r#"
            return new ReadableStream({
                start(controller) {
                    const encoder = new TextEncoder();
                    controller.enqueue(encoder.encode("hello "));
                    controller.enqueue(encoder.encode(request.name));
                    controller.close();
                }
            });
            "#,
        )
        .render(r#"{"name":"React"}"#)
        .unwrap();
        assert_eq!(output, "hello React");
    }

    #[test]
    fn handles_route_text_from_bundle() {
        let output = route_handler("return `${request.method}:${request.path}`;")
            .handle_route(r#"{"method":"POST","path":"/api/echo"}"#)
            .unwrap();
        assert_eq!(output, "POST:/api/echo");
    }

    #[test]
    fn exposes_web_url_primitives() {
        let response = route_handler(
            r#"const url = new URL(request.url); const params = new URLSearchParams('tag=one&tag=two&space=zap+js'); params.append('id', url.searchParams.get('id')); return new Response(`${url.pathname}:${url.searchParams.get('id')}:${params.getAll('tag').join('|')}:${params.get('space')}:${params.toString()}`);"#,
        )
        .handle_route_response(r#"{"url":"https://zap.local/shop/7?id=42"}"#)
        .unwrap();
        assert_eq!(
            response.body,
            "/shop/7:42:one|two:zap js:tag=one&tag=two&space=zap+js&id=42"
        );
    }

    #[test]
    fn exposes_web_request_primitive() {
        let response = route_handler(
            r#"const webRequest = new Request('https://zap.local/api/echo?tag=one', {method: 'POST', headers: {'x-zap': '1'}, body: request.body}); return new Response(`${webRequest.method}:${webRequest.url}:${webRequest.headers.get('x-zap')}:${webRequest.body}`);"#,
        )
        .handle_route_response(r#"{"body":"hello"}"#)
        .unwrap();
        assert_eq!(
            response.body,
            "POST:https://zap.local/api/echo?tag=one:1:hello"
        );

        let used_error = route_handler(
            r#"const webRequest = new Request('https://zap.local/api/echo', {method: 'POST', body: 'hello'}); return webRequest.text().then(() => webRequest.text());"#,
        )
        .handle_route_response(r#"{}"#)
        .unwrap_err();
        assert!(used_error
            .to_string()
            .contains("Request body has already been read"));
    }

    #[test]
    fn exposes_web_response_helpers() {
        let json = route_handler(
            r#"const response = Response.json({ok: true}); const clone = response.clone(); return clone.json().then(body => new Response(`${response.headers.get('content-type')}:${body.ok}:${response.bodyUsed}:${clone.bodyUsed}`));"#,
        )
        .handle_route_response(r#"{}"#)
        .unwrap();
        assert_eq!(json.body, "application/json:true:false:true");

        let redirect = route_handler(r#"return Response.redirect('/login', 307);"#)
            .handle_route_response(r#"{}"#)
            .unwrap();
        assert_eq!(redirect.status, 307);
        assert_eq!(redirect.headers, vec![("location".into(), "/login".into())]);
        assert_eq!(redirect.body, "");

        let used_error = route_handler(
            r#"const response = new Response('hello'); return response.text().then(() => response.text());"#,
        )
        .handle_route_response(r#"{}"#)
        .unwrap_err();
        assert!(used_error
            .to_string()
            .contains("Response body has already been read"));
    }

    #[test]
    fn handles_route_response_metadata_from_bundle() {
        let response = route_handler(
            r#"return new Response(JSON.stringify({ok: true}), {status: 201, headers: {'content-type': 'application/json'}});"#,
        )
        .handle_route_response(r#"{"method":"POST","path":"/api/echo"}"#)
        .unwrap();
        assert_eq!(response.status, 201);
        assert_eq!(
            response.headers,
            vec![("content-type".into(), "application/json".into())]
        );
        assert_eq!(response.body, r#"{"ok":true}"#);
    }

    #[test]
    fn invokes_action_response_metadata_from_bundle() {
        let response = action_handler(
            r#"return new Response(`saved:${invocation.args[0].id}`, {status: 202, headers: {'x-zap-action': invocation.export}});"#,
        )
        .invoke_action_response(r#"{"export":"save","args":[{"id":7}]}"#)
        .unwrap();
        assert_eq!(response.status, 202);
        assert_eq!(
            response.headers,
            vec![("x-zap-action".into(), "save".into())]
        );
        assert_eq!(response.body, "saved:7");
    }

    #[test]
    fn rejects_invalid_response_metadata() {
        let status_error = route_handler(r#"return new Response("bad", {status: 99});"#)
            .handle_route_response(r#"{"method":"GET","path":"/api/bad"}"#)
            .unwrap_err();
        assert!(status_error.to_string().contains("Invalid response status"));

        let header_name_error = route_handler(
            r#"return new Response("bad", {status: 200, headers: [["bad name", "value"]]});"#,
        )
        .handle_route_response(r#"{"method":"GET","path":"/api/bad"}"#)
        .unwrap_err();
        assert!(header_name_error
            .to_string()
            .contains("Invalid header name"));

        let header_value_error = action_handler(
            r#"return new Response('bad', {status: 200, headers: [['x-zap', 'bad\r\nvalue']]});"#,
        )
        .invoke_action_response(r#"{"export":"save","args":[]}"#)
        .unwrap_err();
        assert!(header_value_error
            .to_string()
            .contains("header value is invalid"));
    }

    #[test]
    fn maps_route_and_action_errors_to_execution_failures() {
        let route = route_handler(r#"throw new Error('secret route token');"#)
            .execute_route(r#"{"method":"POST","path":"/api/echo"}"#);
        assert_eq!(
            route,
            ExecutionOutcome::Failed(ExecutionFailure {
                status: 500,
                public_message: "Route execution failed".into(),
                diagnostic: match route {
                    ExecutionOutcome::Failed(ref failure) => failure.diagnostic.clone(),
                    ExecutionOutcome::Complete(_) => unreachable!(),
                },
            })
        );
        match route {
            ExecutionOutcome::Failed(failure) => {
                assert!(failure.diagnostic.contains("secret route token"));
            }
            ExecutionOutcome::Complete(_) => unreachable!(),
        }

        let action = action_handler(r#"throw new Error('secret action token');"#)
            .execute_action(r#"{"export":"save","args":[]}"#);
        match action {
            ExecutionOutcome::Failed(failure) => {
                assert_eq!(failure.status, 500);
                assert_eq!(failure.public_message, "Action execution failed");
                assert!(failure.diagnostic.contains("secret action token"));
            }
            ExecutionOutcome::Complete(_) => unreachable!(),
        }
    }

    #[test]
    fn exposes_explicit_rust_host_calls_only() {
        let output = renderer(r#"return __zap_call("load", JSON.stringify(request));"#)
            .with_host(Arc::new(|name, input| {
                assert_eq!(name, "load");
                Ok(format!("host:{input}"))
            }))
            .render(r#"{"id":42}"#)
            .unwrap();
        assert_eq!(output, r#"host:{"id":42}"#);

        let error = renderer(r#"return __zap_call("missing", "{}");"#)
            .render("{}")
            .unwrap_err();
        assert!(error.to_string().contains("Unknown Rust host operation"));
    }

    #[test]
    fn omits_ambient_platform_apis() {
        let output = renderer(
            r#"
            const forbidden = [
                "fetch",
                "process",
                "require",
                "module",
                "exports",
                "Buffer",
                "Deno",
                "Bun",
                "WebSocket",
                "XMLHttpRequest",
                "localStorage",
                "sessionStorage",
                "navigator",
                "document",
                "window",
            ];
            return JSON.stringify(Object.fromEntries(
                forbidden.map(name => [name, typeof globalThis[name]])
            ));
            "#,
        )
        .render("{}")
        .unwrap();

        let exposed: HashMap<String, String> = serde_json::from_str(&output).unwrap();
        for name in [
            "fetch",
            "process",
            "require",
            "module",
            "exports",
            "Buffer",
            "Deno",
            "Bun",
            "WebSocket",
            "XMLHttpRequest",
            "localStorage",
            "sessionStorage",
            "navigator",
            "document",
            "window",
        ] {
            assert_eq!(exposed.get(name).map(String::as_str), Some("undefined"));
        }
    }

    #[test]
    fn enforces_output_limits() {
        let error = renderer(r#"return "0123456789";"#)
            .with_limits(Limits {
                output_bytes: 4,
                ..Limits::default()
            })
            .render("{}")
            .unwrap_err();
        assert!(error.to_string().contains("Render output limit exceeded"));
    }

    #[test]
    fn interrupts_cpu_bound_rendering() {
        let error = renderer("while (true) {}")
            .with_limits(Limits {
                timeout: Duration::from_millis(20),
                ..Limits::default()
            })
            .render("{}")
            .unwrap_err();
        assert!(!error.to_string().is_empty());
    }
}
