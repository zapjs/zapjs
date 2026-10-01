use anyhow::{Context, Result, bail};
use std::{env, ffi::OsString, path::PathBuf, process::ExitCode};
use zap_build::{ApplicationBuildOptions, BuiltBundleTarget};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Build(BuildCommand),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BuildCommand {
    root: PathBuf,
    app_dir: Option<PathBuf>,
    public_dir: PublicDir,
    out_dir: Option<PathBuf>,
    minify: bool,
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
            root: PathBuf::from("."),
            app_dir: None,
            public_dir: PublicDir::Default,
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
    }
}

async fn run_build(command: BuildCommand) -> Result<()> {
    let mut options = ApplicationBuildOptions::new(&command.root);
    if let Some(app_dir) = command.app_dir {
        options.graph.app_dir = app_dir;
    }
    match command.public_dir {
        PublicDir::Default => {}
        PublicDir::Path(path) => options.graph.public_dir = Some(path),
        PublicDir::Disabled => options.graph.public_dir = None,
    }
    if let Some(out_dir) = command.out_dir {
        options.graph.out_dir = out_dir;
    }
    options.minify = command.minify;

    let output = zap_build::build_application(&options)
        .await
        .with_context(|| format!("build ZapJS application at {}", command.root.display()))?;
    print_build_summary(&output);
    Ok(())
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
            if args
                .iter()
                .any(|arg| matches!(arg.to_string_lossy().as_ref(), "--help" | "-h"))
            {
                Ok(Command::Help)
            } else {
                parse_build(args).map(Command::Build)
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
            "--root" => command.root = next_path(&mut args, "--root")?,
            "--app" => command.app_dir = Some(next_path(&mut args, "--app")?),
            "--public" => command.public_dir = PublicDir::Path(next_path(&mut args, "--public")?),
            "--no-public" => command.public_dir = PublicDir::Disabled,
            "--out" => command.out_dir = Some(next_path(&mut args, "--out")?),
            "--no-minify" => command.minify = false,
            other => bail!("unknown build option `{other}`"),
        }
    }
    Ok(command)
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
        "ZapJS\n\nUSAGE:\n    zap build [--root <path>] [--app <path>] [--public <path>|--no-public] [--out <path>] [--no-minify]\n\nCOMMANDS:\n    build    Build a ZapJS application with the Rust-owned compiler\n    help     Print this help\n"
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
                root: PathBuf::from("/tmp/app"),
                app_dir: Some(PathBuf::from("src/app")),
                public_dir: PublicDir::Path(PathBuf::from("static")),
                out_dir: Some(PathBuf::from("dist/zap")),
                minify: false,
            })
        );
    }

    #[test]
    fn parses_disabled_public_assets() {
        assert_eq!(
            parse_command(os_args(&["zap", "build", "--no-public"])).unwrap(),
            Command::Build(BuildCommand {
                public_dir: PublicDir::Disabled,
                ..BuildCommand::default()
            })
        );
    }

    #[test]
    fn build_help_prints_top_level_help() {
        assert_eq!(
            parse_command(os_args(&["zap", "build", "--help"])).unwrap(),
            Command::Help
        );
    }

    #[test]
    fn rejects_missing_option_values() {
        let error = parse_command(os_args(&["zap", "build", "--root"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("--root requires a path"), "{error}");
    }

    #[test]
    fn rejects_unknown_options() {
        let error = parse_command(os_args(&["zap", "build", "--watch"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown build option"), "{error}");
    }

    #[tokio::test]
    async fn build_command_writes_manifest_and_server_bundle() {
        let temp = tempfile::tempdir().unwrap();
        let route = temp.path().join("app/api/echo");
        std::fs::create_dir_all(&route).unwrap();
        std::fs::write(
            route.join("route.ts"),
            "export function POST(request){ return `echo:${request.method}:${request.path}`; }\n",
        )
        .unwrap();

        run_build(BuildCommand {
            root: temp.path().to_owned(),
            public_dir: PublicDir::Disabled,
            minify: false,
            ..BuildCommand::default()
        })
        .await
        .unwrap();

        assert!(temp.path().join(".zap/manifest.json").is_file());
        assert!(temp.path().join(".zap/server/api/echo/route.js").is_file());
    }
}
