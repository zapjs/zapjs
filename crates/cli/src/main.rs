use anyhow::{Context, Result, bail};
use std::{env, ffi::OsString, path::PathBuf, process::ExitCode};
use zap_build::{
    ApplicationBuildOptions, BuiltBundleTarget, GraphOptions, build_application_graph,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Build(BuildCommand),
    Check(GraphCommand),
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

fn print_usage() {
    println!(
        "ZapJS\n\nUSAGE:\n    zap build [--root <path>] [--app <path>] [--public <path>|--no-public] [--out <path>] [--no-minify]\n    zap check [--root <path>] [--app <path>] [--public <path>|--no-public]\n\nCOMMANDS:\n    build    Build a ZapJS application with the Rust-owned compiler\n    check    Validate the ZapJS application graph without writing build artifacts\n    help     Print this help\n"
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
