use anyhow::{Context, Result, bail};
use http::{Method, StatusCode};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
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
    Package(PackageCommand),
    Deploy(DeployCommand),
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
struct PackageCommand {
    root: PathBuf,
    deployment: Option<PathBuf>,
    public_dir: PublicDir,
    out_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeployCommand {
    graph: GraphCommand,
    target: DeployTarget,
    out_dir: Option<PathBuf>,
    minify: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DeployTarget {
    LocalPackage,
    ManagedNative,
    ProviderFs,
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

impl Default for PackageCommand {
    fn default() -> Self {
        Self {
            root: PathBuf::from("."),
            deployment: None,
            public_dir: PublicDir::Default,
            out_dir: None,
        }
    }
}

impl Default for DeployCommand {
    fn default() -> Self {
        Self {
            graph: GraphCommand::default(),
            target: DeployTarget::LocalPackage,
            out_dir: None,
            minify: true,
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
        Command::Package(command) => run_package(command),
        Command::Deploy(command) => run_deploy(command).await,
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

async fn run_deploy(command: DeployCommand) -> Result<()> {
    let mut options = ApplicationBuildOptions::new(&command.graph.root);
    apply_graph_options(&mut options.graph, command.graph.clone());
    options.minify = command.minify;
    let output = zap_build::build_application(&options)
        .await
        .with_context(|| {
            format!(
                "build ZapJS deployment artifacts at {}",
                options.graph.root.display()
            )
        })?;
    print_build_summary(&output);

    match command.target {
        DeployTarget::LocalPackage => {
            let package_dir = command
                .out_dir
                .clone()
                .unwrap_or_else(|| command.graph.root.join(".zap/deploy/local-package"));
            run_package(PackageCommand {
                root: command.graph.root.clone(),
                deployment: Some(output.deployment),
                public_dir: command.graph.public_dir,
                out_dir: Some(package_dir.clone()),
            })?;
            verify_executor_root(&package_dir, "local-package")?;
            println!("deploy_target=local-package");
            println!("deploy_root={}", package_dir.display());
            Ok(())
        }
        DeployTarget::ManagedNative => {
            let deploy_dir = command
                .out_dir
                .clone()
                .unwrap_or_else(|| command.graph.root.join(".zap/deploy/managed-native"));
            run_managed_native_deploy(
                &command.graph.root,
                &output.deployment,
                command.graph.public_dir,
                &deploy_dir,
            )?;
            println!("deploy_target=managed-native");
            println!("deploy_root={}", deploy_dir.display());
            Ok(())
        }
        DeployTarget::ProviderFs => {
            let provider_root = command
                .out_dir
                .clone()
                .unwrap_or_else(|| command.graph.root.join(".zap/deploy/provider-fs"));
            run_provider_fs_deploy(
                &command.graph.root,
                &output.deployment,
                command.graph.public_dir,
                &provider_root,
            )?;
            println!("deploy_target=provider-fs");
            println!("provider_root={}", provider_root.display());
            Ok(())
        }
    }
}

fn run_managed_native_deploy(
    root: &Path,
    deployment_path: &Path,
    public_dir: PublicDir,
    deploy_dir: &Path,
) -> Result<()> {
    let function_root = deploy_dir.join("function");
    let static_root = deploy_dir.join("static");
    run_package(PackageCommand {
        root: root.to_owned(),
        deployment: Some(deployment_path.to_owned()),
        public_dir: public_dir.clone(),
        out_dir: Some(function_root.clone()),
    })?;

    let deployment = read_deployment_manifest(deployment_path)
        .with_context(|| format!("read deployment manifest at {}", deployment_path.display()))?;
    fs::create_dir_all(&static_root)
        .with_context(|| format!("create static deployment root at {}", static_root.display()))?;
    for asset in &deployment.browser_assets {
        copy_relative_file(root, &static_root, asset, "browser asset")?;
    }
    let public_root = match &public_dir {
        PublicDir::Default => root.join("public"),
        PublicDir::Path(path) => path.clone(),
        PublicDir::Disabled => root.join(".zap/no-public"),
    };
    for asset in &deployment.static_assets {
        copy_relative_file(&public_root, &static_root, asset, "static asset")?;
    }

    let managed_manifest = serde_json::json!({
        "schema": "zap.managed-native.v1",
        "entrypoint": {
            "kind": "rust-function",
            "root": "function",
            "manifest": "function/.zap/manifest.json",
            "action_endpoint": deployment.action_endpoint,
        },
        "static": {
            "root": "static",
            "browser_assets": deployment.browser_assets,
            "static_assets": deployment.static_assets,
        },
        "function": {
            "deployment": "function/.zap/deployment.json",
            "package": "function/.zap/package.json",
            "server_bundles": deployment.server_bundles,
        }
    });
    let managed_manifest_path = deploy_dir.join("zap.managed-native.json");
    fs::write(
        &managed_manifest_path,
        serde_json::to_vec_pretty(&managed_manifest)?,
    )
    .with_context(|| {
        format!(
            "write managed-native manifest at {}",
            managed_manifest_path.display()
        )
    })?;

    verify_executor_root(&function_root, "managed-native function")?;
    println!("managed_manifest={}", managed_manifest_path.display());
    println!("function_root={}", function_root.display());
    println!("static_root={}", static_root.display());
    Ok(())
}

fn run_provider_fs_deploy(
    root: &Path,
    deployment_path: &Path,
    public_dir: PublicDir,
    provider_root: &Path,
) -> Result<()> {
    let staging_root = root.join(".zap/deploy/provider-fs-stage");
    if staging_root.exists() {
        fs::remove_dir_all(&staging_root).with_context(|| {
            format!(
                "remove stale provider staging root at {}",
                staging_root.display()
            )
        })?;
    }
    run_managed_native_deploy(root, deployment_path, public_dir, &staging_root)?;
    fs::create_dir_all(provider_root).with_context(|| {
        format!(
            "create provider filesystem upload root at {}",
            provider_root.display()
        )
    })?;
    copy_directory_contents(&staging_root, provider_root, "provider upload artifact")?;
    verify_executor_root(
        &provider_root.join("function"),
        "provider-fs uploaded function",
    )?;

    let receipt = serde_json::json!({
        "schema": "zap.provider-fs-upload.v1",
        "target": "provider-fs",
        "managed_manifest": "zap.managed-native.json",
        "function_root": "function",
        "static_root": "static",
        "verified": true,
    });
    let receipt_path = provider_root.join("zap.provider-fs-upload.json");
    fs::write(&receipt_path, serde_json::to_vec_pretty(&receipt)?).with_context(|| {
        format!(
            "write provider upload receipt at {}",
            receipt_path.display()
        )
    })?;
    println!("provider_receipt={}", receipt_path.display());
    Ok(())
}

fn verify_executor_root(root: &Path, label: &str) -> Result<()> {
    let manifest = root.join(".zap/manifest.json");
    ApplicationExecutor::load_from(root, &manifest)
        .with_context(|| format!("verify {label} deployment at {}", root.display()))?;
    Ok(())
}

fn run_package(command: PackageCommand) -> Result<()> {
    let deployment_path = command
        .deployment
        .clone()
        .unwrap_or_else(|| command.root.join(".zap/deployment.json"));
    let out_dir = command
        .out_dir
        .clone()
        .unwrap_or_else(|| command.root.join(".zap/package"));
    let public_dir = match &command.public_dir {
        PublicDir::Default => command.root.join("public"),
        PublicDir::Path(path) => path.clone(),
        PublicDir::Disabled => command.root.join(".zap/no-public"),
    };

    let deployment = read_deployment_manifest(&deployment_path)
        .with_context(|| format!("read deployment manifest at {}", deployment_path.display()))?;

    fs::create_dir_all(&out_dir)
        .with_context(|| format!("create package output at {}", out_dir.display()))?;
    copy_named_file(
        &deployment_path,
        &out_dir.join(".zap/deployment.json"),
        "deployment manifest",
    )?;
    copy_relative_file(
        &command.root,
        &out_dir,
        &deployment.manifest,
        "application manifest",
    )?;

    for bundle in &deployment.server_bundles {
        copy_relative_file(&command.root, &out_dir, bundle, "server bundle")?;
    }
    for asset in &deployment.browser_assets {
        copy_relative_file(&command.root, &out_dir, asset, "browser asset")?;
    }
    for asset in &deployment.static_assets {
        copy_relative_file(&public_dir, &out_dir.join("public"), asset, "static asset")?;
    }

    let package_manifest = serde_json::json!({
        "schema": "zap.package.v1",
        "deployment": ".zap/deployment.json",
        "manifest": deployment.manifest,
        "action_endpoint": deployment.action_endpoint,
        "server_bundles": deployment.server_bundles,
        "browser_assets": deployment.browser_assets,
        "static_assets": deployment.static_assets,
    });
    let package_manifest_path = out_dir.join(".zap/package.json");
    if let Some(parent) = package_manifest_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!("create package manifest directory at {}", parent.display())
        })?;
    }
    fs::write(
        &package_manifest_path,
        serde_json::to_vec_pretty(&package_manifest)?,
    )
    .with_context(|| {
        format!(
            "write package manifest at {}",
            package_manifest_path.display()
        )
    })?;

    println!("package={}", out_dir.display());
    println!("manifest={}", out_dir.join(&deployment.manifest).display());
    println!(
        "deployment={}",
        out_dir.join(".zap/deployment.json").display()
    );
    println!("server_bundles={}", deployment.server_bundles.len());
    println!("browser_assets={}", deployment.browser_assets.len());
    println!("static_assets={}", deployment.static_assets.len());
    Ok(())
}

#[derive(Debug)]
struct DeploymentManifest {
    manifest: PathBuf,
    action_endpoint: Option<String>,
    server_bundles: Vec<PathBuf>,
    browser_assets: Vec<PathBuf>,
    static_assets: Vec<PathBuf>,
}

fn read_deployment_manifest(path: &Path) -> Result<DeploymentManifest> {
    let source = fs::read_to_string(path)
        .with_context(|| format!("read deployment manifest at {}", path.display()))?;
    let value: Value = serde_json::from_str(&source).context("parse deployment manifest JSON")?;
    let object = value
        .as_object()
        .context("deployment manifest must be a JSON object")?;
    let schema = object
        .get("schema")
        .and_then(Value::as_str)
        .context("deployment manifest is missing schema")?;
    if schema != "zap.deployment.v1" {
        bail!("unsupported deployment manifest schema `{schema}`");
    }

    let manifest = required_relative_field(object.get("manifest"), "manifest")?;
    let action_endpoint = object
        .get("action_endpoint")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let server_bundles = object
        .get("server_bundles")
        .and_then(Value::as_array)
        .context("deployment manifest is missing server_bundles")?
        .iter()
        .map(|entry| {
            let path = entry
                .get("path")
                .context("server bundle entry is missing path")?;
            required_relative_field(Some(path), "server bundle path")
        })
        .collect::<Result<Vec<_>>>()?;
    let browser_assets = object
        .get("browser_assets")
        .and_then(Value::as_array)
        .context("deployment manifest is missing browser_assets")?
        .iter()
        .map(|entry| required_relative_field(Some(entry), "browser asset"))
        .collect::<Result<Vec<_>>>()?;
    let static_assets = object
        .get("static_assets")
        .and_then(Value::as_array)
        .context("deployment manifest is missing static_assets")?
        .iter()
        .map(|entry| {
            let source = entry
                .get("source")
                .context("static asset entry is missing source")?;
            required_relative_field(Some(source), "static asset source")
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(DeploymentManifest {
        manifest,
        action_endpoint,
        server_bundles,
        browser_assets,
        static_assets,
    })
}

fn required_relative_field(value: Option<&Value>, label: &str) -> Result<PathBuf> {
    let value = value
        .and_then(Value::as_str)
        .with_context(|| format!("{label} must be a string"))?;
    safe_relative_path(value, label)
}

fn safe_relative_path(value: &str, label: &str) -> Result<PathBuf> {
    if value.is_empty() {
        bail!("{label} must not be empty");
    }
    let path = PathBuf::from(value);
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => bail!("{label} must not contain current-directory components"),
            Component::ParentDir => bail!("{label} must not contain parent-directory components"),
            Component::RootDir | Component::Prefix(_) => bail!("{label} must be relative"),
        }
    }
    Ok(path)
}

fn copy_relative_file(
    source_root: &Path,
    dest_root: &Path,
    relative: &Path,
    label: &str,
) -> Result<()> {
    copy_named_file(
        &source_root.join(relative),
        &dest_root.join(relative),
        label,
    )
}

fn copy_directory_contents(source: &Path, dest: &Path, label: &str) -> Result<()> {
    for entry in fs::read_dir(source)
        .with_context(|| format!("read {label} directory {}", source.display()))?
    {
        let entry = entry.with_context(|| format!("read {label} entry in {}", source.display()))?;
        let source_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        let file_type = entry
            .file_type()
            .with_context(|| format!("read {label} file type for {}", source_path.display()))?;
        if file_type.is_dir() {
            fs::create_dir_all(&dest_path)
                .with_context(|| format!("create {label} directory at {}", dest_path.display()))?;
            copy_directory_contents(&source_path, &dest_path, label)?;
        } else if file_type.is_file() {
            copy_named_file(&source_path, &dest_path, label)?;
        } else {
            bail!(
                "{label} contains unsupported file type at {}",
                source_path.display()
            );
        }
    }
    Ok(())
}

fn copy_named_file(source: &Path, dest: &Path, label: &str) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create {label} directory at {}", parent.display()))?;
    }
    fs::copy(source, dest).with_context(|| {
        format!(
            "copy {label} from {} to {}",
            source.display(),
            dest.display()
        )
    })?;
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
        "package" => {
            let args = args.collect::<Vec<_>>();
            if has_help(&args) {
                Ok(Command::Help)
            } else {
                parse_package(args).map(Command::Package)
            }
        }
        "deploy" => {
            let args = args.collect::<Vec<_>>();
            if has_help(&args) {
                Ok(Command::Help)
            } else {
                parse_deploy(args).map(Command::Deploy)
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

fn parse_deploy(args: impl IntoIterator<Item = OsString>) -> Result<DeployCommand> {
    let mut command = DeployCommand::default();
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
            "--target" => {
                let target = next_value(&mut args, "--target")?;
                command.target = match target.as_str() {
                    "local-package" => DeployTarget::LocalPackage,
                    "managed-native" => DeployTarget::ManagedNative,
                    "provider-fs" => DeployTarget::ProviderFs,
                    other => bail!("unsupported deploy target `{other}`"),
                };
            }
            other => bail!("unknown deploy option `{other}`"),
        }
    }
    Ok(command)
}

fn parse_package(args: impl IntoIterator<Item = OsString>) -> Result<PackageCommand> {
    let mut command = PackageCommand::default();
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        match flag.to_string_lossy().as_ref() {
            "--root" => command.root = next_path(&mut args, "--root")?,
            "--deployment" => command.deployment = Some(next_path(&mut args, "--deployment")?),
            "--public" => command.public_dir = PublicDir::Path(next_path(&mut args, "--public")?),
            "--no-public" => command.public_dir = PublicDir::Disabled,
            "--out" => command.out_dir = Some(next_path(&mut args, "--out")?),
            other => bail!("unknown package option `{other}`"),
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
    let path = parts[1];
    if !path.starts_with('/') || path.contains('#') {
        bail!("HTTP request target must be absolute-path without a fragment");
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
                headers: request
                    .headers
                    .iter()
                    .map(|(name, value)| (name.clone(), value.clone()))
                    .collect(),
                body: request.body.clone(),
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
        "ZapJS\n\nUSAGE:\n    zap build [--root <path>] [--app <path>] [--public <path>|--no-public] [--out <path>] [--no-minify]\n    zap check [--root <path>] [--app <path>] [--public <path>|--no-public]\n    zap package [--root <path>] [--deployment <path>] [--public <path>|--no-public] [--out <path>]\n    zap deploy [--target <local-package|managed-native|provider-fs>] [--root <path>] [--app <path>] [--public <path>|--no-public] [--out <path>] [--no-minify]\n    zap serve [--root <path>] [--manifest <path>] [--public <path>|--no-public] [--addr <host:port>]\n\nCOMMANDS:\n    build      Build a ZapJS application with the Rust-owned compiler\n    check      Validate the ZapJS application graph without writing build artifacts\n    package    Materialize a deployable artifact tree from the Rust deployment manifest\n    deploy     Build and upload deployable ZapJS artifacts\n    serve      Serve built ZapJS artifacts with the Rust executor\n    help       Print this help\n"
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
    fn parses_explicit_package_paths() {
        assert_eq!(
            parse_command(os_args(&[
                "zap",
                "package",
                "--root",
                "/tmp/app",
                "--deployment",
                "dist/deployment.json",
                "--public",
                "static",
                "--out",
                "dist/package",
            ]))
            .unwrap(),
            Command::Package(PackageCommand {
                root: PathBuf::from("/tmp/app"),
                deployment: Some(PathBuf::from("dist/deployment.json")),
                public_dir: PublicDir::Path(PathBuf::from("static")),
                out_dir: Some(PathBuf::from("dist/package")),
            })
        );
    }

    #[test]
    fn parses_explicit_deploy_paths() {
        assert_eq!(
            parse_command(os_args(&[
                "zap",
                "deploy",
                "--target",
                "local-package",
                "--root",
                "/tmp/app",
                "--app",
                "src/app",
                "--public",
                "static",
                "--out",
                "dist/deploy",
                "--no-minify",
            ]))
            .unwrap(),
            Command::Deploy(DeployCommand {
                graph: GraphCommand {
                    root: PathBuf::from("/tmp/app"),
                    app_dir: Some(PathBuf::from("src/app")),
                    public_dir: PublicDir::Path(PathBuf::from("static")),
                },
                target: DeployTarget::LocalPackage,
                out_dir: Some(PathBuf::from("dist/deploy")),
                minify: false,
            })
        );
    }

    #[test]
    fn parses_managed_native_deploy_target() {
        assert_eq!(
            parse_command(os_args(&[
                "zap",
                "deploy",
                "--target",
                "managed-native",
                "--root",
                "/tmp/app",
            ]))
            .unwrap(),
            Command::Deploy(DeployCommand {
                graph: GraphCommand {
                    root: PathBuf::from("/tmp/app"),
                    ..GraphCommand::default()
                },
                target: DeployTarget::ManagedNative,
                ..DeployCommand::default()
            })
        );
    }

    #[test]
    fn parses_provider_fs_deploy_target() {
        assert_eq!(
            parse_command(os_args(&[
                "zap",
                "deploy",
                "--target",
                "provider-fs",
                "--root",
                "/tmp/app",
                "--out",
                "/tmp/provider",
            ]))
            .unwrap(),
            Command::Deploy(DeployCommand {
                graph: GraphCommand {
                    root: PathBuf::from("/tmp/app"),
                    ..GraphCommand::default()
                },
                target: DeployTarget::ProviderFs,
                out_dir: Some(PathBuf::from("/tmp/provider")),
                ..DeployCommand::default()
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
            parse_command(os_args(&["zap", "package", "--no-public"])).unwrap(),
            Command::Package(PackageCommand {
                public_dir: PublicDir::Disabled,
                ..PackageCommand::default()
            })
        );
        assert_eq!(
            parse_command(os_args(&["zap", "deploy", "--no-public"])).unwrap(),
            Command::Deploy(DeployCommand {
                graph: GraphCommand {
                    public_dir: PublicDir::Disabled,
                    ..GraphCommand::default()
                },
                ..DeployCommand::default()
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
            parse_command(os_args(&["zap", "package", "--help"])).unwrap(),
            Command::Help
        );
        assert_eq!(
            parse_command(os_args(&["zap", "deploy", "--help"])).unwrap(),
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
        let error = parse_command(os_args(&["zap", "package", "--watch"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown package option"), "{error}");
        let error = parse_command(os_args(&["zap", "deploy", "--target", "unknown"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unsupported deploy target"), "{error}");
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

    #[tokio::test]
    async fn package_command_materializes_executable_artifact_root() {
        let temp = minimal_app();
        let package_dir = temp.path().join("dist/package");

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
        run_package(PackageCommand {
            root: temp.path().to_owned(),
            public_dir: PublicDir::Disabled,
            out_dir: Some(package_dir.clone()),
            ..PackageCommand::default()
        })
        .unwrap();

        assert!(package_dir.join(".zap/package.json").is_file());
        assert!(package_dir.join(".zap/deployment.json").is_file());
        assert!(package_dir.join(".zap/manifest.json").is_file());
        assert!(package_dir.join(".zap/server/api/echo/route.js").is_file());

        let package_manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(package_dir.join(".zap/package.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(package_manifest["schema"], "zap.package.v1");
        assert_eq!(package_manifest["manifest"], ".zap/manifest.json");

        let executor = ApplicationExecutor::load(&package_dir).unwrap();
        let response = executor
            .execute_request(&RequestExecutionInput {
                method: &Method::POST,
                path: "/api/echo",
                headers: Vec::new(),
                body: Vec::new(),
                declared_body_bytes: Some(0),
                uses_private_request_state: false,
                context: InvocationContext {
                    request_id: Some("package-test"),
                    authenticated: true,
                    deadline_ms: Some(30_000),
                },
            })
            .unwrap();
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            String::from_utf8(response.body).unwrap(),
            "echo:POST:/api/echo"
        );
    }

    #[tokio::test]
    async fn deploy_command_builds_managed_native_artifacts() {
        let temp = minimal_app();
        let public = temp.path().join("public");
        std::fs::create_dir_all(&public).unwrap();
        std::fs::write(public.join("logo.txt"), "zap").unwrap();
        let deploy_dir = temp.path().join("dist/managed");

        run_deploy(DeployCommand {
            graph: GraphCommand {
                root: temp.path().to_owned(),
                public_dir: PublicDir::Default,
                ..GraphCommand::default()
            },
            target: DeployTarget::ManagedNative,
            out_dir: Some(deploy_dir.clone()),
            minify: false,
        })
        .await
        .unwrap();

        assert!(deploy_dir.join("zap.managed-native.json").is_file());
        assert!(deploy_dir.join("function/.zap/package.json").is_file());
        assert!(deploy_dir.join("function/.zap/manifest.json").is_file());
        assert!(
            deploy_dir
                .join("function/.zap/server/api/echo/route.js")
                .is_file()
        );
        assert!(deploy_dir.join("static/logo.txt").is_file());

        let managed_manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(deploy_dir.join("zap.managed-native.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(managed_manifest["schema"], "zap.managed-native.v1");
        assert_eq!(managed_manifest["entrypoint"]["kind"], "rust-function");
        assert_eq!(
            managed_manifest["entrypoint"]["manifest"],
            "function/.zap/manifest.json"
        );
        assert_eq!(managed_manifest["static"]["root"], "static");
        assert!(
            managed_manifest["function"]["server_bundles"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry == ".zap/server/api/echo/route.js")
        );

        let executor = ApplicationExecutor::load(&deploy_dir.join("function")).unwrap();
        let response = executor
            .execute_request(&RequestExecutionInput {
                method: &Method::POST,
                path: "/api/echo",
                headers: Vec::new(),
                body: Vec::new(),
                declared_body_bytes: Some(0),
                uses_private_request_state: false,
                context: InvocationContext {
                    request_id: Some("managed-native-test"),
                    authenticated: true,
                    deadline_ms: Some(30_000),
                },
            })
            .unwrap();
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            String::from_utf8(response.body).unwrap(),
            "echo:POST:/api/echo"
        );
    }

    #[tokio::test]
    async fn deploy_command_uploads_provider_fs_artifacts() {
        let temp = minimal_app();
        let provider_root = temp.path().join("dist/provider");

        run_deploy(DeployCommand {
            graph: GraphCommand {
                root: temp.path().to_owned(),
                public_dir: PublicDir::Disabled,
                ..GraphCommand::default()
            },
            target: DeployTarget::ProviderFs,
            out_dir: Some(provider_root.clone()),
            minify: false,
        })
        .await
        .unwrap();

        assert!(provider_root.join("zap.managed-native.json").is_file());
        assert!(provider_root.join("zap.provider-fs-upload.json").is_file());
        assert!(provider_root.join("function/.zap/package.json").is_file());
        assert!(provider_root.join("function/.zap/manifest.json").is_file());
        assert!(
            provider_root
                .join("function/.zap/server/api/echo/route.js")
                .is_file()
        );

        let receipt: Value = serde_json::from_str(
            &std::fs::read_to_string(provider_root.join("zap.provider-fs-upload.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt["schema"], "zap.provider-fs-upload.v1");
        assert_eq!(receipt["target"], "provider-fs");
        assert_eq!(receipt["managed_manifest"], "zap.managed-native.json");
        assert_eq!(receipt["function_root"], "function");
        assert_eq!(receipt["verified"], true);

        let executor = ApplicationExecutor::load(&provider_root.join("function")).unwrap();
        let response = executor
            .execute_request(&RequestExecutionInput {
                method: &Method::POST,
                path: "/api/echo",
                headers: Vec::new(),
                body: Vec::new(),
                declared_body_bytes: Some(0),
                uses_private_request_state: false,
                context: InvocationContext {
                    request_id: Some("provider-fs-test"),
                    authenticated: true,
                    deadline_ms: Some(30_000),
                },
            })
            .unwrap();
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            String::from_utf8(response.body).unwrap(),
            "echo:POST:/api/echo"
        );
    }

    #[tokio::test]
    async fn deploy_command_builds_and_verifies_local_package_target() {
        let temp = minimal_app();
        let deploy_dir = temp.path().join("dist/deploy");

        run_deploy(DeployCommand {
            graph: GraphCommand {
                root: temp.path().to_owned(),
                public_dir: PublicDir::Disabled,
                ..GraphCommand::default()
            },
            out_dir: Some(deploy_dir.clone()),
            minify: false,
            ..DeployCommand::default()
        })
        .await
        .unwrap();

        assert!(deploy_dir.join(".zap/package.json").is_file());
        assert!(deploy_dir.join(".zap/manifest.json").is_file());
        let executor = ApplicationExecutor::load(&deploy_dir).unwrap();
        let response = executor
            .execute_request(&RequestExecutionInput {
                method: &Method::POST,
                path: "/api/echo",
                headers: Vec::new(),
                body: Vec::new(),
                declared_body_bytes: Some(0),
                uses_private_request_state: false,
                context: InvocationContext {
                    request_id: Some("deploy-test"),
                    authenticated: true,
                    deadline_ms: Some(30_000),
                },
            })
            .unwrap();
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            String::from_utf8(response.body).unwrap(),
            "echo:POST:/api/echo"
        );
    }

    #[test]
    fn package_command_rejects_unsafe_manifest_paths() {
        let temp = tempfile::tempdir().unwrap();
        let deployment = temp.path().join(".zap/deployment.json");
        std::fs::create_dir_all(deployment.parent().unwrap()).unwrap();
        std::fs::write(
            &deployment,
            r#"{
  "schema": "zap.deployment.v1",
  "manifest": "../manifest.json",
  "server_bundles": [],
  "browser_assets": [],
  "static_assets": []
}
"#,
        )
        .unwrap();

        let error = format!(
            "{:#}",
            run_package(PackageCommand {
                root: temp.path().to_owned(),
                deployment: Some(deployment),
                public_dir: PublicDir::Disabled,
                ..PackageCommand::default()
            })
            .unwrap_err()
        );
        assert!(
            error.contains("manifest must not contain parent-directory components"),
            "{error}"
        );
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
