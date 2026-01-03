use zap_server::splice_worker;

// Import the library to ensure all exports are linked
extern crate test_server;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Run the splice worker (handles protocol, dispatch, etc.)
    // Worker connects to Splice supervisor via ZAP_SOCKET env var
    splice_worker::run().await?;

    Ok(())
}
