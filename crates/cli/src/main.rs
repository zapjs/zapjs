use anyhow::{Context, Result, bail};
use http::{Method, StatusCode};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::ExitCode,
};
use zap_build::{
    ApplicationBuildOptions, BuiltBundleTarget, GraphOptions, build_application_graph,
};
use zap_execute::{
    ActionEndpointInput, ApplicationExecutor, ExecutionResponse, RequestExecutionInput,
};
use zap_runtime::request::InvocationContext;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Build(BuildCommand),
    Check(GraphCommand),
    Serve(ServeCommand),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BuildCommand {
    graph: GraphCommand,
    out_dir: Option<PathBuf>,
    minify: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GraphCommand {
    root: PathBuf,
    app_dir: Option<PathBuf>,
    public_dir: PublicDir,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServeCommand {
    root: PathBuf,
    manifest: Option<PathBuf>,
    public_dir: PublicDir,
    addr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PublicDir {
    Default,
    Path(PathBuf),
    Disabled,
}

impl Default for BuildCommand {
    fn default() -> Self {
        Self {
            graph: GraphCommand::default(),
            out_dir: None,
            minify: true,
        }
    }
}

impl Default for GraphCommand {
    fn default() -> Self {
        Self {
            root: PathBuf::from("."),
            app_dir: None,
            public_dir: PublicDir::Default,
        }
    }
}

impl Default for ServeCommand {
    fn default() -> Self {
        Self {
            root: PathBuf::from("."),
            manifest: None,
            public_dir: PublicDir::Default,
            addr: "127.0.0.1:3000".into(),
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(env::args_os()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: impl IntoIterator<Item = OsString>) -> Result<()> {
    match parse_command(args)? {
        Command::Help => {
            print_usage();
            Ok(())
        }
        Command::Build(command) => run_build(command).await,
        Command::Check(command) => run_check(command),
        Command::Serve(command) => run_serve(command),
    }
}

async fn run_build(command: BuildCommand) -> Result<()> {
    let mut options = ApplicationBuildOptions::new(&command.graph.root);
    apply_graph_options(&mut options.graph, command.graph);
    if let Some(out_dir) = command.out_dir {
        options.graph.out_dir = out_dir;
    }
    options.minify = command.minify;

    let output = zap_build::build_application(&options)
        .await
        .with_context(|| {
            format!(
                "build ZapJS application at {}",
                options.graph.root.display()
            )
        })?;
    print_build_summary(&output);
    Ok(())
}

fn run_serve(command: ServeCommand) -> Result<()> {
    let manifest = command
        .manifest
        .clone()
        .unwrap_or_else(|| command.root.join(".zap/manifest.json"));
    let public_dir = match &command.public_dir {
        PublicDir::Default => command.root.join("public"),
        PublicDir::Path(path) => path.clone(),
        PublicDir::Disabled => command.root.join(".zap/no-public"),
    };
    let executor = ApplicationExecutor::load_from(&command.root, &manifest)
        .with_context(|| format!("load ZapJS artifacts from {}", command.root.display()))?
        .with_public_dir(public_dir);
    let listener = TcpListener::bind(&command.addr)
        .with_context(|| format!("bind ZapJS server at {}", command.addr))?;
    println!("listening=http://{}", listener.local_addr()?);
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if let Err(error) = handle_connection(&executor, stream) {
                    eprintln!("request error: {error:#}");
                }
            }
            Err(error) => eprintln!("accept error: {error}"),
        }
    }
    Ok(())
}

fn run_check(command: GraphCommand) -> Result<()> {
    let mut options = GraphOptions::new(&command.root);
    apply_graph_options(&mut options, command);
    let graph = build_application_graph(&options)
        .with_context(|| format!("check ZapJS application at {}", options.root.display()))?;
    print_check_summary(&graph);
    Ok(())
}

fn apply_graph_options(options: &mut GraphOptions, command: GraphCommand) {
    if let Some(app_dir) = command.app_dir {
        options.app_dir = app_dir;
    }
    match command.public_dir {
        PublicDir::Default => {}
        PublicDir::Path(path) => options.public_dir = Some(path),
        PublicDir::Disabled => options.public_dir = None,
    }
}

fn parse_command(args: impl IntoIterator<Item = OsString>) -> Result<Command> {
    let mut args = args.into_iter();
    let _program = args.next();
    let Some(command) = args.next() else {
        return Ok(Command::Help);
    };
    match command.to_string_lossy().as_ref() {
        "build" => {
            let args = args.collect::<Vec<_>>();
            if has_help(&args) {
                Ok(Command::Help)
            } else {
                parse_build(args).map(Command::Build)
            }
        }
        "check" => {
            let args = args.collect::<Vec<_>>();
            if has_help(&args) {
                Ok(Command::Help)
            } else {
                parse_graph(args, "check").map(Command::Check)
            }
        }
        "serve" => {
            let args = args.collect::<Vec<_>>();
            if has_help(&args) {
                Ok(Command::Help)
            } else {
                parse_serve(args).map(Command::Serve)
            }
        }
        "help" | "--help" | "-h" => Ok(Command::Help),
        other => bail!("unknown command `{other}`"),
    }
}

fn parse_build(args: impl IntoIterator<Item = OsString>) -> Result<BuildCommand> {
    let mut command = BuildCommand::default();
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        match flag.to_string_lossy().as_ref() {
            "--root" => command.graph.root = next_path(&mut args, "--root")?,
            "--app" => command.graph.app_dir = Some(next_path(&mut args, "--app")?),
            "--public" => {
                command.graph.public_dir = PublicDir::Path(next_path(&mut args, "--public")?)
            }
            "--no-public" => command.graph.public_dir = PublicDir::Disabled,
            "--out" => command.out_dir = Some(next_path(&mut args, "--out")?),
            "--no-minify" => command.minify = false,
            other => bail!("unknown build option `{other}`"),
        }
    }
    Ok(command)
}

fn parse_serve(args: impl IntoIterator<Item = OsString>) -> Result<ServeCommand> {
    let mut command = ServeCommand::default();
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        match flag.to_string_lossy().as_ref() {
            "--root" => command.root = next_path(&mut args, "--root")?,
            "--manifest" => command.manifest = Some(next_path(&mut args, "--manifest")?),
            "--public" => command.public_dir = PublicDir::Path(next_path(&mut args, "--public")?),
            "--no-public" => command.public_dir = PublicDir::Disabled,
            "--addr" => command.addr = next_value(&mut args, "--addr")?,
            other => bail!("unknown serve option `{other}`"),
        }
    }
    Ok(command)
}

fn parse_graph(
    args: impl IntoIterator<Item = OsString>,
    command_name: &str,
) -> Result<GraphCommand> {
    let mut command = GraphCommand::default();
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        match flag.to_string_lossy().as_ref() {
            "--root" => command.root = next_path(&mut args, "--root")?,
            "--app" => command.app_dir = Some(next_path(&mut args, "--app")?),
            "--public" => command.public_dir = PublicDir::Path(next_path(&mut args, "--public")?),
            "--no-public" => command.public_dir = PublicDir::Disabled,
            other => bail!("unknown {command_name} option `{other}`"),
        }
    }
    Ok(command)
}

fn has_help(args: &[OsString]) -> bool {
    args.iter()
        .any(|arg| matches!(arg.to_string_lossy().as_ref(), "--help" | "-h"))
}

fn next_path(args: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<PathBuf> {
    let Some(value) = args.next() else {
        bail!("{flag} requires a path");
    };
    if value.to_string_lossy().starts_with('-') {
        bail!("{flag} requires a path, got `{}`", value.to_string_lossy());
    }
    Ok(PathBuf::from(value))
}

fn next_value(args: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<String> {
    let Some(value) = args.next() else {
        bail!("{flag} requires a value");
    };
    if value.to_string_lossy().starts_with('-') {
        bail!("{flag} requires a value, got `{}`", value.to_string_lossy());
    }
    Ok(value.to_string_lossy().into_owned())
}

#[derive(Debug)]
struct HttpRequest {
    method: Method,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn handle_connection(executor: &ApplicationExecutor, mut stream: TcpStream) -> Result<()> {
    let request = read_http_request(&mut stream)?;
    let response = execute_http_request(executor, &request)?;
    write_http_response(&mut stream, response)?;
    Ok(())
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .context("read request line")?;
    let parts = request_line.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 3 {
        bail!("malformed HTTP request line");
    }
    let method = Method::from_bytes(parts[0].as_bytes())
        .with_context(|| format!("unsupported HTTP method `{}`", parts[0]))?;
    let path = parts[1].split_once('?').map_or(parts[1], |(path, _)| path);
    if !path.starts_with('/') {
        bail!("HTTP request target must be absolute-path");
    }

    let mut headers = BTreeMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).context("read request header")?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            bail!("malformed HTTP header");
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }

    let content_length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>())
        .transpose()
        .context("parse content-length")?
        .unwrap_or(0);
    let mut body = vec![0; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).context("read request body")?;
    }

    Ok(HttpRequest {
        method,
        path: path.to_owned(),
        headers,
        body,
    })
}

fn execute_http_request(
    executor: &ApplicationExecutor,
    request: &HttpRequest,
) -> Result<ExecutionResponse> {
    let host = request.headers.get("host").map(String::as_str);
    let expected_origin = host.map(|host| format!("http://{host}"));
    let origin = request.headers.get("origin").map(String::as_str);
    let request_id = format!("serve:{}:{}", request.method, request.path);
    let context = InvocationContext {
        request_id: Some(request_id.as_str()),
        authenticated: true,
        deadline_ms: Some(30_000),
    };

    if request.path == "/_zap/action" {
        executor
            .execute_action_endpoint(&ActionEndpointInput {
                method: &request.method,
                path: &request.path,
                origin,
                expected_origin: expected_origin.as_deref(),
                body: &request.body,
                context,
            })
            .context("execute action endpoint")
    } else {
        executor
            .execute_request(&RequestExecutionInput {
                method: &request.method,
                path: &request.path,
                declared_body_bytes: Some(request.body.len() as u64),
                uses_private_request_state: false,
                context,
            })
            .context("execute request")
    }
}

fn write_http_response(stream: &mut TcpStream, response: ExecutionResponse) -> Result<()> {
    write!(
        stream,
        "HTTP/1.1 {} {}\r\n",
        response.status.as_u16(),
        status_reason(response.status)
    )
    .context("write response status")?;
    let mut has_content_length = false;
    let mut has_connection = false;
    for (name, value) in &response.headers {
        if name.eq_ignore_ascii_case("content-length") {
            has_content_length = true;
        }
        if name.eq_ignore_ascii_case("connection") {
            has_connection = true;
        }
        write!(stream, "{name}: {value}\r\n").context("write response header")?;
    }
    if !has_content_length {
        write!(stream, "content-length: {}\r\n", response.body.len())
            .context("write content-length")?;
    }
    if !has_connection {
        write!(stream, "connection: close\r\n").context("write connection header")?;
    }
    write!(stream, "\r\n").context("finish response headers")?;
    stream
        .write_all(&response.body)
        .context("write response body")?;
    stream.flush().context("flush response")?;
    Ok(())
}

fn status_reason(status: StatusCode) -> &'static str {
    status.canonical_reason().unwrap_or("Unknown")
}

fn print_usage() {
    println!(
        "ZapJS\n\nUSAGE:\n    zap build [--root <path>] [--app <path>] [--public <path>|--no-public] [--out <path>] [--no-minify]\n    zap check [--root <path>] [--app <path>] [--public <path>|--no-public]\n    zap serve [--root <path>] [--manifest <path>] [--public <path>|--no-public] [--addr <host:port>]\n\nCOMMANDS:\n    build    Build a ZapJS application with the Rust-owned compiler\n    check    Validate the ZapJS application graph without writing build artifacts\n    serve    Serve built ZapJS artifacts with the Rust executor\n    help     Print this help\n"
    );
}

fn print_build_summary(output: &zap_build::ApplicationBuildOutput) {
    let server_bundles = output
        .bundles
        .iter()
        .filter(|bundle| bundle.target == BuiltBundleTarget::Server)
        .count();
    let browser_bundles = output
        .bundles
        .iter()
        .filter(|bundle| bundle.target == BuiltBundleTarget::Browser)
        .count();
    let total_bytes = output
        .bundles
        .iter()
        .map(|bundle| bundle.bytes)
        .sum::<usize>();
    let warning_count = output
        .bundles
        .iter()
        .map(|bundle| bundle.warnings.len())
        .sum::<usize>();

    println!("manifest={}", output.manifest.display());
    println!("deployment={}", output.deployment.display());
    if let Some(action_proxy) = &output.action_proxy {
        println!("action_proxy={}", action_proxy.display());
    }
    println!("routes={}", output.graph.routes.len());
    println!("modules={}", output.graph.modules.len());
    println!("server_bundles={server_bundles}");
    println!("browser_bundles={browser_bundles}");
    println!("total_bundle_bytes={total_bytes}");
    println!("warnings={warning_count}");

    for bundle in &output.bundles {
        for warning in &bundle.warnings {
            eprintln!("warning[{}]: {warning}", bundle.module);
        }
    }
}

fn print_check_summary(graph: &zap_build::ApplicationGraph) {
    println!("routes={}", graph.routes.len());
    println!("modules={}", graph.modules.len());
    println!("layouts={}", graph.layouts.len());
    println!("actions={}", graph.actions.len());
    println!("client_references={}", graph.client_references.len());
    println!("assets={}", graph.assets.len());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os_args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_default_build_command() {
        assert_eq!(
            parse_command(os_args(&["zap", "build"])).unwrap(),
            Command::Build(BuildCommand::default())
        );
    }

    #[test]
    fn parses_default_check_command() {
        assert_eq!(
            parse_command(os_args(&["zap", "check"])).unwrap(),
            Command::Check(GraphCommand::default())
        );
    }

    #[test]
    fn parses_explicit_build_paths() {
        assert_eq!(
            parse_command(os_args(&[
                "zap",
                "build",
                "--root",
                "/tmp/app",
                "--app",
                "src/app",
                "--public",
                "static",
                "--out",
                "dist/zap",
                "--no-minify",
            ]))
            .unwrap(),
            Command::Build(BuildCommand {
                graph: GraphCommand {
                    root: PathBuf::from("/tmp/app"),
                    app_dir: Some(PathBuf::from("src/app")),
                    public_dir: PublicDir::Path(PathBuf::from("static")),
                },
                out_dir: Some(PathBuf::from("dist/zap")),
                minify: false,
            })
        );
    }

    #[test]
    fn parses_explicit_check_paths() {
        assert_eq!(
            parse_command(os_args(&[
                "zap", "check", "--root", "/tmp/app", "--app", "src/app", "--public", "static",
            ]))
            .unwrap(),
            Command::Check(GraphCommand {
                root: PathBuf::from("/tmp/app"),
                app_dir: Some(PathBuf::from("src/app")),
                public_dir: PublicDir::Path(PathBuf::from("static")),
            })
        );
    }

    #[test]
    fn parses_explicit_serve_paths() {
        assert_eq!(
            parse_command(os_args(&[
                "zap",
                "serve",
                "--root",
                "/tmp/app",
                "--manifest",
                "dist/manifest.json",
                "--public",
                "static",
                "--addr",
                "127.0.0.1:8080",
            ]))
            .unwrap(),
            Command::Serve(ServeCommand {
                root: PathBuf::from("/tmp/app"),
                manifest: Some(PathBuf::from("dist/manifest.json")),
                public_dir: PublicDir::Path(PathBuf::from("static")),
                addr: "127.0.0.1:8080".into(),
            })
        );
    }

    #[test]
    fn parses_disabled_public_assets() {
        assert_eq!(
            parse_command(os_args(&["zap", "build", "--no-public"])).unwrap(),
            Command::Build(BuildCommand {
                graph: GraphCommand {
                    public_dir: PublicDir::Disabled,
                    ..GraphCommand::default()
                },
                ..BuildCommand::default()
            })
        );
        assert_eq!(
            parse_command(os_args(&["zap", "check", "--no-public"])).unwrap(),
            Command::Check(GraphCommand {
                public_dir: PublicDir::Disabled,
                ..GraphCommand::default()
            })
        );
        assert_eq!(
            parse_command(os_args(&["zap", "serve", "--no-public"])).unwrap(),
            Command::Serve(ServeCommand {
                public_dir: PublicDir::Disabled,
                ..ServeCommand::default()
            })
        );
    }

    #[test]
    fn command_help_prints_top_level_help() {
        assert_eq!(
            parse_command(os_args(&["zap", "build", "--help"])).unwrap(),
            Command::Help
        );
        assert_eq!(
            parse_command(os_args(&["zap", "check", "--help"])).unwrap(),
            Command::Help
        );
        assert_eq!(
            parse_command(os_args(&["zap", "serve", "--help"])).unwrap(),
            Command::Help
        );
    }

    #[test]
    fn rejects_missing_option_values() {
        let error = parse_command(os_args(&["zap", "build", "--root"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("--root requires a path"), "{error}");
        let error = parse_command(os_args(&["zap", "check", "--app"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("--app requires a path"), "{error}");
    }

    #[test]
    fn rejects_unknown_options() {
        let error = parse_command(os_args(&["zap", "build", "--watch"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown build option"), "{error}");
        let error = parse_command(os_args(&["zap", "check", "--out"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown check option"), "{error}");
        let error = parse_command(os_args(&["zap", "serve", "--watch"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown serve option"), "{error}");
    }

    #[tokio::test]
    async fn build_command_writes_manifest_and_server_bundle() {
        let temp = minimal_app();

        run_build(BuildCommand {
            graph: GraphCommand {
                root: temp.path().to_owned(),
                public_dir: PublicDir::Disabled,
                ..GraphCommand::default()
            },
            minify: false,
            ..BuildCommand::default()
        })
        .await
        .unwrap();

        assert!(temp.path().join(".zap/manifest.json").is_file());
        assert!(temp.path().join(".zap/deployment.json").is_file());
        assert!(temp.path().join(".zap/server/api/echo/route.js").is_file());
    }

    #[test]
    fn check_command_validates_graph_without_writing_artifacts() {
        let temp = minimal_app();

        run_check(GraphCommand {
            root: temp.path().to_owned(),
            public_dir: PublicDir::Disabled,
            ..GraphCommand::default()
        })
        .unwrap();

        assert!(!temp.path().join(".zap/manifest.json").exists());
        assert!(!temp.path().join(".zap/server/api/echo/route.js").exists());
    }

    #[test]
    fn check_command_rejects_invalid_graph() {
        let temp = tempfile::tempdir().unwrap();
        let route = temp.path().join("app/api/echo");
        std::fs::create_dir_all(&route).unwrap();
        std::fs::write(route.join("route.ts"), "export const value = 1;\n").unwrap();

        let error = run_check(GraphCommand {
            root: temp.path().to_owned(),
            public_dir: PublicDir::Disabled,
            ..GraphCommand::default()
        })
        .unwrap_err()
        .to_string();

        assert!(error.contains("check ZapJS application"), "{error}");
    }

    fn minimal_app() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let route = temp.path().join("app/api/echo");
        std::fs::create_dir_all(&route).unwrap();
        std::fs::write(
            route.join("route.ts"),
            "export function POST(request){ return `echo:${request.method}:${request.path}`; }\n",
        )
        .unwrap();
        temp
    }
}
