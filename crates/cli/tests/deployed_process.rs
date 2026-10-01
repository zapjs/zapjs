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
            "--no-public",
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
    assert!(deploy_root.join("zap.managed-native.json").is_file());

    let mut child = Command::new(binary)
        .args([
            "serve",
            "--root",
            function_root.to_str().unwrap(),
            "--no-public",
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

    let mut stream = TcpStream::connect(&address).expect("connect to zap serve");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");
    stream
        .write_all(
            b"POST /api/echo HTTP/1.1\r\nhost: zap.local\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .expect("write request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    assert!(
        response.starts_with("HTTP/1.1 200 OK"),
        "unexpected response:\n{response}"
    );
    assert!(
        response.ends_with("echo:POST:/api/echo"),
        "unexpected response body:\n{response}"
    );

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
            "--no-public",
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
    assert_served_echo(binary, &provider_root.join("function"));
}

fn assert_served_echo(binary: &str, function_root: &Path) {
    let mut child = Command::new(binary)
        .args([
            "serve",
            "--root",
            function_root.to_str().unwrap(),
            "--no-public",
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

    let mut stream = TcpStream::connect(&address).expect("connect to zap serve");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");
    stream
        .write_all(
            b"POST /api/echo HTTP/1.1\r\nhost: zap.local\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .expect("write request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    assert!(
        response.starts_with("HTTP/1.1 200 OK"),
        "unexpected response:\n{response}"
    );
    assert!(
        response.ends_with("echo:POST:/api/echo"),
        "unexpected response body:\n{response}"
    );

    let _ = guard.0.kill();
    assert!(guard.0.wait().expect("wait for serve").success() == false);
}

fn write_minimal_app(root: &Path) {
    let app = root.join("app/api/echo");
    fs::create_dir_all(&app).expect("create app route");
    fs::write(
        root.join("app/page.tsx"),
        "export default function Page(){ return 'home'; }\n",
    )
    .expect("write page");
    fs::write(
        app.join("route.ts"),
        "export function POST(request){ return `echo:${request.method}:${request.path}`; }\n",
    )
    .expect("write route");
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
