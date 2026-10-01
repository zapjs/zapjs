use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn local_package_artifact_serves_from_real_zap_process() {
    let temp = TempDir::new("zap-cli-local-package-process");
    write_minimal_app(temp.path());
    let package_root = temp.path().join("dist/local-package");

    let binary = env!("CARGO_BIN_EXE_zap");
    let deploy = Command::new(binary)
        .args([
            "deploy",
            "--target",
            "local-package",
            "--root",
            temp.path().to_str().unwrap(),
            "--out",
            package_root.to_str().unwrap(),
            "--no-minify",
        ])
        .output()
        .expect("run zap local-package deploy");
    assert!(
        deploy.status.success(),
        "local-package deploy failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&deploy.stdout),
        String::from_utf8_lossy(&deploy.stderr)
    );

    assert!(package_root.join(".zap/package.json").is_file());
    assert!(package_root.join(".zap/deployment.json").is_file());
    assert!(package_root.join(".zap/manifest.json").is_file());
    assert!(package_root.join("public/logo.txt").is_file());
    assert_served_framework(binary, &package_root);
}

#[test]
fn managed_native_artifact_serves_from_real_zap_process() {
    let temp = TempDir::new("zap-cli-process");
    write_minimal_app(temp.path());
    let deploy_root = temp.path().join("dist/managed");

    let binary = env!("CARGO_BIN_EXE_zap");
    let deploy = Command::new(binary)
        .args([
            "deploy",
            "--target",
            "managed-native",
            "--root",
            temp.path().to_str().unwrap(),
            "--out",
            deploy_root.to_str().unwrap(),
            "--no-minify",
        ])
        .output()
        .expect("run zap deploy");
    assert!(
        deploy.status.success(),
        "deploy failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&deploy.stdout),
        String::from_utf8_lossy(&deploy.stderr)
    );

    let function_root = deploy_root.join("function");
    assert!(function_root.join(".zap/manifest.json").is_file());
    assert!(function_root.join("public/logo.txt").is_file());
    assert!(deploy_root.join("static/logo.txt").is_file());
    assert!(deploy_root.join("zap.managed-native.json").is_file());

    let mut child = Command::new(binary)
        .args([
            "serve",
            "--root",
            function_root.to_str().unwrap(),
            "--addr",
            "127.0.0.1:0",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn zap serve");

    let stdout = child.stdout.take().expect("serve stdout");
    let mut guard = ChildGuard(child);
    let mut reader = BufReader::new(stdout);
    let mut listening = String::new();
    reader
        .read_line(&mut listening)
        .expect("read serve address");
    let address = listening
        .trim()
        .strip_prefix("listening=http://")
        .expect("serve printed listening address")
        .to_owned();

    assert_served_framework_responses(&address);

    let _ = guard.0.kill();
    assert!(guard.0.wait().expect("wait for serve").success() == false);
}

#[test]
fn provider_fs_upload_serves_from_real_zap_process() {
    let temp = TempDir::new("zap-cli-provider-process");
    write_minimal_app(temp.path());
    let provider_root = temp.path().join("dist/provider");

    let binary = env!("CARGO_BIN_EXE_zap");
    let deploy = Command::new(binary)
        .args([
            "deploy",
            "--target",
            "provider-fs",
            "--root",
            temp.path().to_str().unwrap(),
            "--out",
            provider_root.to_str().unwrap(),
            "--no-minify",
        ])
        .output()
        .expect("run zap provider-fs deploy");
    assert!(
        deploy.status.success(),
        "provider deploy failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&deploy.stdout),
        String::from_utf8_lossy(&deploy.stderr)
    );

    assert!(provider_root.join("zap.provider-fs-upload.json").is_file());
    assert!(provider_root.join("function/.zap/manifest.json").is_file());
    assert!(provider_root.join("function/public/logo.txt").is_file());
    assert!(provider_root.join("static/logo.txt").is_file());
    assert_served_framework(binary, &provider_root.join("function"));
}

fn assert_served_framework(binary: &str, function_root: &Path) {
    let mut child = Command::new(binary)
        .args([
            "serve",
            "--root",
            function_root.to_str().unwrap(),
            "--addr",
            "127.0.0.1:0",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn zap serve");

    let stdout = child.stdout.take().expect("serve stdout");
    let mut guard = ChildGuard(child);
    let mut reader = BufReader::new(stdout);
    let mut listening = String::new();
    reader
        .read_line(&mut listening)
        .expect("read serve address");
    let address = listening
        .trim()
        .strip_prefix("listening=http://")
        .expect("serve printed listening address")
        .to_owned();

    assert_served_framework_responses(&address);

    let _ = guard.0.kill();
    assert!(guard.0.wait().expect("wait for serve").success() == false);
}

fn assert_served_framework_responses(address: &str) {
    let route = http_exchange(
        address,
        b"POST /api/echo HTTP/1.1\r\nhost: zap.local\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    );
    assert!(
        route.starts_with("HTTP/1.1 200 OK"),
        "unexpected route response:\n{route}"
    );
    assert!(
        route.ends_with("echo:POST:/api/echo"),
        "unexpected route response body:\n{route}"
    );

    let get_head_route = http_exchange(
        address,
        b"GET /api/ping HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        get_head_route.starts_with("HTTP/1.1 200 OK"),
        "unexpected GET-to-HEAD route GET response:\n{get_head_route}"
    );
    assert!(
        get_head_route.contains("x-zap-route: ping"),
        "GET-to-HEAD route GET response missed route header:\n{get_head_route}"
    );
    assert!(
        get_head_route.ends_with("ping:GET:/api/ping"),
        "GET-to-HEAD route GET response missed body:\n{get_head_route}"
    );

    let get_head_route_head = http_exchange(
        address,
        b"HEAD /api/ping HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        get_head_route_head.starts_with("HTTP/1.1 200 OK"),
        "unexpected GET-to-HEAD route HEAD response:\n{get_head_route_head}"
    );
    assert!(
        get_head_route_head.contains("x-zap-route: ping"),
        "GET-to-HEAD route HEAD response missed route header:\n{get_head_route_head}"
    );
    assert!(
        get_head_route_head.contains("content-length: 0"),
        "GET-to-HEAD route HEAD response must advertise an empty body:\n{get_head_route_head}"
    );
    assert!(
        get_head_route_head.ends_with("\r\n\r\n"),
        "GET-to-HEAD route HEAD response must not include a body:\n{get_head_route_head}"
    );

    let static_asset = http_exchange(
        address,
        b"GET /logo.txt HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        static_asset.starts_with("HTTP/1.1 200 OK"),
        "unexpected static asset response:\n{static_asset}"
    );
    assert!(
        static_asset.ends_with("zap-static"),
        "static asset response missed public file body:\n{static_asset}"
    );

    let static_asset_head = http_exchange(
        address,
        b"HEAD /logo.txt HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        static_asset_head.starts_with("HTTP/1.1 200 OK"),
        "unexpected static asset HEAD response:\n{static_asset_head}"
    );
    assert!(
        static_asset_head.contains("content-length: 0"),
        "static asset HEAD response must advertise an empty body:\n{static_asset_head}"
    );
    assert!(
        static_asset_head.ends_with("\r\n\r\n"),
        "static asset HEAD response must not include a body:\n{static_asset_head}"
    );

    let cached_page = http_exchange(
        address,
        b"GET /cached HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        cached_page.starts_with("HTTP/1.1 200 OK"),
        "unexpected cached page response:\n{cached_page}"
    );
    assert!(
        cached_page.contains("cache-control: public, max-age=0, s-maxage=60, stale-while-revalidate"),
        "cached page response missed public revalidation policy:\n{cached_page}"
    );
    assert!(
        cached_page.contains(r#"<div id="__zap_root">cached-page</div>"#),
        "cached page response missed body:\n{cached_page}"
    );

    let cached_route = http_exchange(
        address,
        b"GET /api/cached HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        cached_route.starts_with("HTTP/1.1 200 OK"),
        "unexpected cached route response:\n{cached_route}"
    );
    assert!(
        cached_route.contains("cache-control: public, immutable"),
        "cached route response missed force-static immutable policy:\n{cached_route}"
    );
    assert!(
        cached_route.ends_with("cached-route"),
        "cached route response missed body:\n{cached_route}"
    );

    let missing = http_exchange(
        address,
        b"GET /missing HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        missing.starts_with("HTTP/1.1 404 Not Found"),
        "missing routes must return the runtime not-found contract:\n{missing}"
    );
    assert!(
        missing.ends_with("\r\n\r\n"),
        "missing route responses must not leak route internals:\n{missing}"
    );

    let page_wrong_method = http_exchange(
        address,
        b"POST / HTTP/1.1\r\nhost: zap.local\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    );
    assert!(
        page_wrong_method.starts_with("HTTP/1.1 405 Method Not Allowed"),
        "page wrong-method requests must return method-not-allowed:\n{page_wrong_method}"
    );
    assert!(
        page_wrong_method.contains("allow: GET, HEAD"),
        "page wrong-method responses must expose allowed methods:\n{page_wrong_method}"
    );

    let static_wrong_method = http_exchange(
        address,
        b"DELETE /logo.txt HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        static_wrong_method.starts_with("HTTP/1.1 405 Method Not Allowed"),
        "static asset wrong-method requests must return method-not-allowed:\n{static_wrong_method}"
    );
    assert!(
        static_wrong_method.contains("allow: GET, HEAD"),
        "static asset wrong-method responses must expose allowed methods:\n{static_wrong_method}"
    );

    let route_wrong_method = http_exchange(
        address,
        b"GET /api/echo HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        route_wrong_method.starts_with("HTTP/1.1 405 Method Not Allowed"),
        "route handler wrong-method requests must return method-not-allowed:\n{route_wrong_method}"
    );
    assert!(
        route_wrong_method.contains("allow: POST"),
        "route handler wrong-method responses must expose allowed methods:\n{route_wrong_method}"
    );

    let action_body = br#"{"action_id":"action:actions#save","args":[{"id":9}]}"#;
    let action_request = format!(
        "POST /_zap/action HTTP/1.1\r\nhost: zap.local\r\norigin: http://zap.local\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        action_body.len(),
        String::from_utf8_lossy(action_body)
    );
    let action = http_exchange(address, action_request.as_bytes());
    assert!(
        action.starts_with("HTTP/1.1 203 "),
        "unexpected server action endpoint response:\n{action}"
    );
    assert!(
        action.contains("x-zap-action: save"),
        "server action endpoint response missed action header:\n{action}"
    );
    assert!(
        action.ends_with("saved:9"),
        "server action endpoint response missed body:\n{action}"
    );

    let action_wrong_method = http_exchange(
        address,
        b"GET /_zap/action HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        action_wrong_method.starts_with("HTTP/1.1 405 Method Not Allowed"),
        "server action endpoint must reject non-POST methods:\n{action_wrong_method}"
    );
    assert!(
        action_wrong_method.contains("allow: POST"),
        "server action endpoint wrong-method response must expose POST:\n{action_wrong_method}"
    );

    let malformed_action = http_exchange(
        address,
        b"POST /_zap/action HTTP/1.1\r\nhost: zap.local\r\norigin: http://zap.local\r\ncontent-type: application/json\r\ncontent-length: 1\r\nconnection: close\r\n\r\n{",
    );
    assert!(
        malformed_action.starts_with("HTTP/1.1 400 Bad Request"),
        "server action endpoint must reject malformed payloads:\n{malformed_action}"
    );

    let unknown_action_body = br#"{"action_id":"action:actions#missing","args":[]}"#;
    let unknown_action_request = format!(
        "POST /_zap/action HTTP/1.1\r\nhost: zap.local\r\norigin: http://zap.local\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        unknown_action_body.len(),
        String::from_utf8_lossy(unknown_action_body)
    );
    let unknown_action = http_exchange(address, unknown_action_request.as_bytes());
    assert!(
        unknown_action.starts_with("HTTP/1.1 404 Not Found"),
        "server action endpoint must reject unknown action ids:\n{unknown_action}"
    );

    let cross_origin_action_request = format!(
        "POST /_zap/action HTTP/1.1\r\nhost: zap.local\r\norigin: http://evil.local\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        action_body.len(),
        String::from_utf8_lossy(action_body)
    );
    let cross_origin_action = http_exchange(address, cross_origin_action_request.as_bytes());
    assert!(
        cross_origin_action.starts_with("HTTP/1.1 403 Forbidden"),
        "server action endpoint must reject cross-origin calls before dispatch:\n{cross_origin_action}"
    );

    let page = http_exchange(
        address,
        b"GET / HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        page.starts_with("HTTP/1.1 200 OK"),
        "unexpected page response:\n{page}"
    );
    assert!(
        page.contains("content-type: text/html; charset=utf-8"),
        "page response did not carry HTML content type:\n{page}"
    );
    assert!(
        page.contains(r#"<div id="__zap_root">home</div>"#),
        "unexpected page response body:\n{page}"
    );
    assert!(
        page.contains(r#""action_proxy":"/.zap/browser/actions.js""#),
        "page response did not include action proxy hydration metadata:\n{page}"
    );

    let action_proxy = http_exchange(
        address,
        b"GET /.zap/browser/actions.js HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        action_proxy.starts_with("HTTP/1.1 200 OK"),
        "unexpected browser action proxy response:\n{action_proxy}"
    );
    assert!(
        action_proxy.contains("content-type: text/javascript; charset=utf-8"),
        "browser action proxy did not carry JavaScript content type:\n{action_proxy}"
    );
    assert!(
        action_proxy.contains("/_zap/action"),
        "browser action proxy did not target the Rust action endpoint:\n{action_proxy}"
    );
    assert!(
        action_proxy.contains("action:actions#save"),
        "browser action proxy did not expose the manifest action id:\n{action_proxy}"
    );

    let action_proxy_head = http_exchange(
        address,
        b"HEAD /.zap/browser/actions.js HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        action_proxy_head.starts_with("HTTP/1.1 200 OK"),
        "unexpected browser action proxy HEAD response:\n{action_proxy_head}"
    );
    assert!(
        action_proxy_head.contains("content-length: 0"),
        "browser action proxy HEAD response must advertise an empty body:\n{action_proxy_head}"
    );
    assert!(
        action_proxy_head.ends_with("\r\n\r\n"),
        "browser action proxy HEAD response must not include a body:\n{action_proxy_head}"
    );

    let action_proxy_wrong_method = http_exchange(
        address,
        b"PUT /.zap/browser/actions.js HTTP/1.1\r\nhost: zap.local\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    );
    assert!(
        action_proxy_wrong_method.starts_with("HTTP/1.1 405 Method Not Allowed"),
        "browser action proxy wrong-method requests must return method-not-allowed:\n{action_proxy_wrong_method}"
    );
    assert!(
        action_proxy_wrong_method.contains("allow: GET, HEAD"),
        "browser action proxy wrong-method responses must expose allowed methods:\n{action_proxy_wrong_method}"
    );

    let browser_bootstrap = http_exchange(
        address,
        b"GET /.zap/browser/bootstrap.js HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        browser_bootstrap.starts_with("HTTP/1.1 200 OK"),
        "unexpected browser bootstrap response:\n{browser_bootstrap}"
    );
    assert!(
        browser_bootstrap.contains("content-type: text/javascript; charset=utf-8"),
        "browser bootstrap did not carry JavaScript content type:\n{browser_bootstrap}"
    );
    assert!(
        browser_bootstrap.contains("zap:navigation-state"),
        "browser bootstrap did not include navigation state publication:\n{browser_bootstrap}"
    );
    assert!(
        browser_bootstrap.contains("hydrate"),
        "browser bootstrap did not include hydration dispatch code:\n{browser_bootstrap}"
    );

    let flight = http_exchange(
        address,
        b"GET / HTTP/1.1\r\nhost: zap.local\r\nrsc: 1\r\naccept: text/x-component\r\nconnection: close\r\n\r\n",
    );
    assert!(
        flight.starts_with("HTTP/1.1 200 OK"),
        "unexpected Flight response:\n{flight}"
    );
    assert!(
        flight.contains("content-type: text/x-component; charset=utf-8"),
        "Flight response did not carry RSC content type:\n{flight}"
    );
    assert!(
        flight.contains("ZAP_FLIGHT 1"),
        "Flight response did not carry Zap Flight envelope:\n{flight}"
    );
    assert!(
        flight.contains(r#""content":"home""#),
        "Flight response did not carry page content:\n{flight}"
    );

    let catch_all = http_exchange(
        address,
        b"GET /docs/a/b/c?view=full&tag=one&tag=two HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        catch_all.starts_with("HTTP/1.1 200 OK"),
        "unexpected catch-all page response:\n{catch_all}"
    );
    assert!(
        catch_all.contains(r#"<div id="__zap_root">docs:a/b/c:full:one|two</div>"#),
        "catch-all page did not receive decoded params and query data:\n{catch_all}"
    );

    let catch_all_flight = http_exchange(
        address,
        b"GET /docs/a/b/c?view=full&tag=one&tag=two HTTP/1.1\r\nhost: zap.local\r\nrsc: 1\r\naccept: text/x-component\r\nconnection: close\r\n\r\n",
    );
    assert!(
        catch_all_flight.starts_with("HTTP/1.1 200 OK"),
        "unexpected catch-all Flight response:\n{catch_all_flight}"
    );
    assert!(
        catch_all_flight.contains(r#""content":"docs:a/b/c:full:one|two""#),
        "catch-all Flight response did not carry decoded params and query data:\n{catch_all_flight}"
    );

    let optional_root = http_exchange(
        address,
        b"GET /files?mode=root HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        optional_root.starts_with("HTTP/1.1 200 OK"),
        "unexpected optional catch-all root response:\n{optional_root}"
    );
    assert!(
        optional_root.contains(r#"<div id="__zap_root">files:<root>:root</div>"#),
        "optional catch-all root did not receive empty params and query data:\n{optional_root}"
    );

    let optional_nested = http_exchange(
        address,
        b"GET /files/a/b?mode=nested HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        optional_nested.starts_with("HTTP/1.1 200 OK"),
        "unexpected optional catch-all nested response:\n{optional_nested}"
    );
    assert!(
        optional_nested.contains(r#"<div id="__zap_root">files:a/b:nested</div>"#),
        "optional catch-all nested route did not receive params and query data:\n{optional_nested}"
    );

    let optional_nested_flight = http_exchange(
        address,
        b"GET /files/a/b?mode=nested HTTP/1.1\r\nhost: zap.local\r\nrsc: 1\r\naccept: text/x-component\r\nconnection: close\r\n\r\n",
    );
    assert!(
        optional_nested_flight.starts_with("HTTP/1.1 200 OK"),
        "unexpected optional catch-all Flight response:\n{optional_nested_flight}"
    );
    assert!(
        optional_nested_flight.contains(r#""content":"files:a/b:nested""#),
        "optional catch-all Flight response did not carry params and query data:\n{optional_nested_flight}"
    );

    let failed_page = http_exchange(
        address,
        b"GET /broken HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        failed_page.starts_with("HTTP/1.1 500 Internal Server Error"),
        "render failures must return a bounded 500 response:\n{failed_page}"
    );
    assert!(
        failed_page.ends_with("Internal Server Error"),
        "500 response must not leak renderer internals:\n{failed_page}"
    );

    let malformed_request = http_exchange(
        address,
        b"GET /broken HTTP/1.1\r\nhost zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        malformed_request.starts_with("HTTP/1.1 400 Bad Request"),
        "malformed requests must return a bounded 400 response:\n{malformed_request}"
    );
    assert!(
        malformed_request.ends_with("Bad Request"),
        "400 response must not leak parser internals:\n{malformed_request}"
    );

    let invalid_target = http_exchange(
        address,
        b"GET http://zap.local/ HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
    );
    assert!(
        invalid_target.starts_with("HTTP/1.1 400 Bad Request"),
        "invalid request targets must return a bounded 400 response:\n{invalid_target}"
    );
    assert!(
        invalid_target.ends_with("Bad Request"),
        "400 target response must not leak parser internals:\n{invalid_target}"
    );

    let oversized_body = http_exchange(
        address,
        b"POST /api/echo HTTP/1.1\r\nhost: zap.local\r\ncontent-length: 1048577\r\nconnection: close\r\n\r\n",
    );
    assert!(
        oversized_body.starts_with("HTTP/1.1 413 Payload Too Large"),
        "oversized requests must return a bounded 413 response before body allocation:\n{oversized_body}"
    );
    assert!(
        oversized_body.ends_with("Payload Too Large"),
        "413 response must not leak admission internals:\n{oversized_body}"
    );

    let long_path = format!(
        "GET /{} HTTP/1.1\r\nhost: zap.local\r\nconnection: close\r\n\r\n",
        "x".repeat(8192)
    );
    let long_uri = http_exchange(address, long_path.as_bytes());
    assert!(
        long_uri.starts_with("HTTP/1.1 414 URI Too Long"),
        "oversized request targets must return a bounded 414 response:\n{long_uri}"
    );
    assert!(
        long_uri.ends_with("URI Too Long"),
        "414 response must not leak parser internals:\n{long_uri}"
    );

    let large_header = format!(
        "GET / HTTP/1.1\r\nhost: zap.local\r\nx-zap-large: {}\r\nconnection: close\r\n\r\n",
        "x".repeat(64 * 1024)
    );
    let large_header_response = http_exchange(address, large_header.as_bytes());
    assert!(
        large_header_response.starts_with("HTTP/1.1 431 Request Header Fields Too Large"),
        "oversized headers must return a bounded 431 response:\n{large_header_response}"
    );
    assert!(
        large_header_response.ends_with("Request Header Fields Too Large"),
        "431 response must not leak parser internals:\n{large_header_response}"
    );
}

fn http_exchange(address: &str, request: &[u8]) -> String {
    let mut stream = TcpStream::connect(address).expect("connect to zap serve");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");
    stream.write_all(request).expect("write request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    response
}

fn write_minimal_app(root: &Path) {
    let app = root.join("app/api/echo");
    fs::create_dir_all(&app).expect("create app route");
    fs::create_dir_all(root.join("public")).expect("create public directory");
    fs::create_dir_all(root.join("app/api/ping")).expect("create ping route");
    fs::create_dir_all(root.join("app/api/cached")).expect("create cached route");
    fs::create_dir_all(root.join("app/cached")).expect("create cached page");
    fs::create_dir_all(root.join("app/broken")).expect("create broken route");
    fs::create_dir_all(root.join("app/docs/[...slug]")).expect("create docs catch-all route");
    fs::create_dir_all(root.join("app/files/[[...path]]"))
        .expect("create files optional catch-all route");
    fs::write(
        root.join("app/page.tsx"),
        "export default function Page(){ return 'home'; }\n",
    )
    .expect("write page");
    fs::write(root.join("public/logo.txt"), "zap-static").expect("write static asset");
    fs::write(
        root.join("app/actions.ts"),
        "'use server';\nexport async function save(input){ return new Response(`saved:${input.id}`, { status: 203, headers: { 'x-zap-action': 'save' } }); }\n",
    )
    .expect("write server action");
    fs::write(
        root.join("app/cached/page.tsx"),
        "export const dynamic = 'force-static';\nexport const revalidate = 60;\nexport default function Cached(){ return 'cached-page'; }\n",
    )
    .expect("write cached page");
    fs::write(
        root.join("app/docs/[...slug]/page.tsx"),
        "export default function Docs({ params, searchParams }){ return `docs:${params.slug.join('/')}:${searchParams.view[0]}:${searchParams.tag.join('|')}`; }\n",
    )
    .expect("write docs page");
    fs::write(
        root.join("app/files/[[...path]]/page.tsx"),
        "export default function Files({ params, searchParams }){ const path = params.path.length ? params.path.join('/') : '<root>'; return `files:${path}:${searchParams.mode[0]}`; }\n",
    )
    .expect("write files page");
    fs::write(
        root.join("app/broken/page.tsx"),
        "export default function Broken(){ throw new Error('broken page'); }\n",
    )
    .expect("write broken page");
    fs::write(
        app.join("route.ts"),
        "export function POST(request){ return `echo:${request.method}:${request.path}`; }\n",
    )
    .expect("write route");
    fs::write(
        root.join("app/api/ping/route.ts"),
        "export function GET(request){ return new Response(`ping:${request.method}:${request.path}`, { headers: { 'x-zap-route': 'ping' } }); }\n",
    )
    .expect("write ping route");
    fs::write(
        root.join("app/api/cached/route.ts"),
        "export const dynamic = 'force-static';\nexport function GET(){ return 'cached-route'; }\n",
    )
    .expect("write cached route");
}

struct TempDir {
    path: std::path::PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
