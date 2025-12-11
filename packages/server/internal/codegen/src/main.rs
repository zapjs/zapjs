use clap::Parser;
use std::fs;
use std::path::PathBuf;
use zap_codegen::{
    find_exported_functions, find_exported_structs, generate_namespaced_server,
    generate_typescript_definitions, generate_typescript_interfaces, generate_typescript_runtime,
};

#[derive(Parser, Debug)]
#[command(
    name = "zap-codegen",
    about = "Generate TypeScript bindings from Rust #[zap::export] functions"
)]
struct Args {
    /// Path to the Cargo project
    #[arg(short, long, default_value = ".")]
    project_dir: PathBuf,

    /// Output directory for generated TypeScript files
    #[arg(short, long, default_value = "./src/api")]
    output_dir: PathBuf,

    /// Input JSON file with exported function metadata
    #[arg(short, long)]
    input: Option<PathBuf>,

    /// Generate type definitions (.d.ts)
    #[arg(long, default_value_t = true)]
    definitions: bool,

    /// Generate runtime bindings (.ts)
    #[arg(long, default_value_t = true)]
    runtime: bool,

    /// Generate namespaced server client (server.users.get() style)
    #[arg(long, default_value_t = true)]
    server: bool,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // Create output directory if it doesn't exist
    fs::create_dir_all(&args.output_dir)?;

    // Load exported functions from input file or scan Rust source
    let functions = if let Some(input_path) = args.input {
        let json_content = fs::read_to_string(&input_path)?;
        serde_json::from_str(&json_content)?
    } else {
        // Scan Rust source files for #[export] functions
        println!("Scanning {} for #[export] functions...", args.project_dir.display());
        find_exported_functions(&args.project_dir)?
    };

    // Scan for serializable structs
    println!("Scanning {} for serializable structs...", args.project_dir.display());
    let structs = find_exported_structs(&args.project_dir)?;

    // Generate TypeScript interfaces from Rust structs
    if !structs.is_empty() {
        let interfaces = generate_typescript_interfaces(&structs);
        let interfaces_path = args.output_dir.join("types.ts");
        fs::write(&interfaces_path, interfaces)?;
        println!("Generated: {} ({} types)", interfaces_path.display(), structs.len());
    }

    // Generate TypeScript definitions
    if args.definitions {
        let defs = generate_typescript_definitions(&functions);
        let defs_path = args.output_dir.join("backend.d.ts");
        fs::write(&defs_path, defs)?;
        println!("Generated: {}", defs_path.display());
    }

    // Generate runtime bindings
    if args.runtime {
        let runtime = generate_typescript_runtime(&functions);
        let runtime_path = args.output_dir.join("backend.ts");
        fs::write(&runtime_path, runtime)?;
        println!("Generated: {}", runtime_path.display());
    }

    // Generate namespaced server client
    if args.server {
        let server = generate_namespaced_server(&functions);
        let server_path = args.output_dir.join("server.ts");
        fs::write(&server_path, server)?;
        println!("Generated: {}", server_path.display());
    }

    println!("Successfully generated TypeScript bindings for {} functions and {} types", functions.len(), structs.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_args_parsing() {
        let args = Args::parse_from(&["zap-codegen"]);
        assert_eq!(args.project_dir, PathBuf::from("."));
        assert_eq!(args.output_dir, PathBuf::from("./src/api"));
    }
}
