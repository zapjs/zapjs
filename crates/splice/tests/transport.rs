use bytes::Bytes;
use std::{
    future::Future,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    net::{UnixListener, UnixStream},
    task::JoinHandle,
};
use zap_splice::{serve, Client, Config, Error, ErrorKind, Invocation, RemoteError};

async fn connection<H, F>(config: Config, handler: H) -> (Client, JoinHandle<Result<(), Error>>)
where
    H: Fn(Invocation) -> F + Send + Sync + 'static,
    F: Future<Output = Result<Bytes, RemoteError>> + Send + 'static,
{
    let (host, worker) = UnixStream::pair().unwrap();
    let server_config = config.clone();
    let server = tokio::spawn(serve(worker, server_config, handler));
    (Client::connect(host, config).await.unwrap(), server)
}

#[tokio::test]
async fn successful_requests_release_capacity_and_errors_are_typed() {
    let config = Config {
        max_in_flight: 1,
        ..Config::default()
    };
    let (client, server) = connection(config, |call| async move {
        if call.function == "fail" {
            Err(RemoteError::application("user failure"))
        } else {
            Ok(call.payload)
        }
    })
    .await;
    for value in 0..300u32 {
        let bytes = Bytes::copy_from_slice(&value.to_be_bytes());
        assert_eq!(
            client
                .invoke("echo", bytes.clone(), Duration::from_secs(1))
                .await
                .unwrap(),
            bytes
        );
    }
    assert!(matches!(
        client
            .invoke("fail", Bytes::new(), Duration::from_secs(1))
            .await,
        Err(Error::Remote(RemoteError {
            kind: ErrorKind::Application,
            ..
        }))
    ));
    assert!(client
        .invoke("echo", Bytes::new(), Duration::from_secs(1))
        .await
        .is_ok());
    drop(client);
    tokio::time::timeout(Duration::from_secs(1), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

struct InFlight {
    active: Arc<AtomicUsize>,
    cancelled: Arc<AtomicUsize>,
    token: tokio_util::sync::CancellationToken,
}
impl Drop for InFlight {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
        if self.token.is_cancelled() {
            self.cancelled.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[tokio::test]
async fn deadlines_call_drop_and_disconnect_cancel_handlers() {
    let active = Arc::new(AtomicUsize::new(0));
    let cancelled = Arc::new(AtomicUsize::new(0));
    let handler_active = active.clone();
    let handler_cancelled = cancelled.clone();
    let (client, server) = connection(Config::default(), move |call| {
        let active = handler_active.clone();
        let cancelled = handler_cancelled.clone();
        async move {
            active.fetch_add(1, Ordering::SeqCst);
            let _guard = InFlight {
                active,
                cancelled,
                token: call.cancellation,
            };
            std::future::pending().await
        }
    })
    .await;
    let result = client
        .invoke("wait", Bytes::new(), Duration::from_millis(30))
        .await;
    assert!(matches!(
        result,
        Err(Error::Deadline)
            | Err(Error::Remote(RemoteError {
                kind: ErrorKind::Deadline,
                ..
            }))
    ));
    wait_count(&cancelled, 1).await;
    let task_client = client.clone();
    let task = tokio::spawn(async move {
        task_client
            .invoke("wait", Bytes::new(), Duration::from_secs(10))
            .await
    });
    wait_count(&active, 1).await;
    task.abort();
    let _ = task.await;
    wait_count(&cancelled, 2).await;
    let task_client = client.clone();
    let task = tokio::spawn(async move {
        task_client
            .invoke("wait", Bytes::new(), Duration::from_secs(10))
            .await
    });
    wait_count(&active, 1).await;
    client.close();
    assert!(matches!(task.await.unwrap(), Err(Error::Disconnected)));
    wait_count(&cancelled, 3).await;
    server.await.unwrap().unwrap();
}

async fn wait_count(value: &AtomicUsize, expected: usize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while value.load(Ordering::SeqCst) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn concurrent_calls_have_independent_responses_and_bounded_admission() {
    let active = Arc::new(AtomicUsize::new(0));
    let handler_active = active.clone();
    let (client, server) = connection(
        Config {
            max_in_flight: 2,
            ..Config::default()
        },
        move |call| {
            let active = handler_active.clone();
            async move {
                active.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(call.payload[0] as u64)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(call.payload)
            }
        },
    )
    .await;
    let slow_client = client.clone();
    let slow = tokio::spawn(async move {
        slow_client
            .invoke("echo", Bytes::from_static(&[120]), Duration::from_secs(1))
            .await
            .unwrap()
    });
    wait_count(&active, 1).await;
    let fast_client = client.clone();
    let fast = tokio::spawn(async move {
        fast_client
            .invoke("echo", Bytes::from_static(&[20]), Duration::from_secs(1))
            .await
            .unwrap()
    });
    wait_count(&active, 2).await;
    assert!(matches!(
        client
            .invoke("overflow", Bytes::new(), Duration::from_secs(1))
            .await,
        Err(Error::Overloaded)
    ));
    assert_eq!(fast.await.unwrap().as_ref(), &[20]);
    assert!(
        !slow.is_finished(),
        "one slow call must not serialize the entire connection"
    );
    assert_eq!(slow.await.unwrap().as_ref(), &[120]);
    drop(client);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn negotiated_frame_limit_rejects_large_input_without_poisoning_connection() {
    let (host, worker) = UnixStream::pair().unwrap();
    let server = tokio::spawn(serve(
        worker,
        Config {
            max_frame_bytes: 512,
            ..Config::default()
        },
        |call| async move { Ok(call.payload) },
    ));
    let client = Client::connect(host, Config::default()).await.unwrap();
    assert!(matches!(
        client
            .invoke("echo", Bytes::from(vec![0; 513]), Duration::from_secs(1))
            .await,
        Err(Error::FrameTooLarge)
    ));
    assert_eq!(
        client
            .invoke("echo", Bytes::from_static(b"ok"), Duration::from_secs(1))
            .await
            .unwrap()
            .as_ref(),
        b"ok"
    );
    drop(client);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn absent_peer_handshake_has_a_deadline() {
    let (host, _worker) = UnixStream::pair().unwrap();
    let config = Config {
        handshake_timeout: Duration::from_millis(10),
        ..Config::default()
    };
    assert!(matches!(
        Client::connect(host, config).await,
        Err(Error::Deadline)
    ));
}

#[tokio::test]
async fn crashing_worker_fails_every_pending_call() {
    let (client, server) = connection(Config::default(), |_call| async move {
        std::future::pending().await
    })
    .await;
    let first_client = client.clone();
    let first = tokio::spawn(async move {
        first_client
            .invoke("pending", Bytes::new(), Duration::from_secs(10))
            .await
    });
    tokio::task::yield_now().await;
    server.abort();
    let _ = server.await;
    assert!(tokio::time::timeout(Duration::from_secs(1), first)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(client
        .invoke("later", Bytes::new(), Duration::from_secs(1))
        .await
        .is_err());
}

#[test]
fn subprocess_multiplexing_and_process_exit() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let path = std::env::temp_dir().join(format!(
            "zap-splice-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let listener = UnixListener::bind(&path).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "subprocess_worker", "--nocapture"])
            .env("ZAP_SPLICE_TEST_SOCKET", &path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap();
        let (stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let client = Client::connect(stream, Config::default()).await.unwrap();
        let mut calls = tokio::task::JoinSet::new();
        for value in 1..=32u8 {
            let client = client.clone();
            calls.spawn(async move {
                let bytes = Bytes::from(vec![value]);
                assert_eq!(
                    client
                        .invoke("echo", bytes.clone(), Duration::from_secs(2))
                        .await
                        .unwrap(),
                    bytes
                );
            });
        }
        while let Some(result) = calls.join_next().await {
            result.unwrap();
        }
        let pending_client = client.clone();
        let pending = tokio::spawn(async move {
            pending_client
                .invoke("pending", Bytes::new(), Duration::from_secs(10))
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        assert!(tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        std::fs::remove_file(path).unwrap();
    });
}

#[test]
#[ignore = "subprocess fixture: invoked by subprocess_multiplexing_and_process_exit"]
fn subprocess_worker() {
    let Some(path) = std::env::var_os("ZAP_SPLICE_TEST_SOCKET") else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let stream = UnixStream::connect(path).await.unwrap();
        serve(stream, Config::default(), |call| async move {
            if call.function == "pending" {
                std::future::pending().await
            } else {
                tokio::time::sleep(Duration::from_millis((33 - call.payload[0]) as u64)).await;
                Ok(call.payload)
            }
        })
        .await
        .unwrap();
    });
}
