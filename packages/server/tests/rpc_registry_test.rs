// Integration test for RPC function registry
use zap_server::export;
use serde_json::json;

// Test sync function
#[export]
pub fn get_test_data(id: u64) -> String {
    format!("test_data_{}", id)
}

// Test async function
#[export]
pub async fn async_greet(name: String) -> String {
    format!("Hello, {}!", name)
}

// Test Result return type (sync)
#[export]
pub fn divide(a: f64, b: f64) -> Result<f64, String> {
    if b == 0.0 {
        Err("Division by zero".to_string())
    } else {
        Ok(a / b)
    }
}

// Test Result return type (async)
#[export]
pub async fn async_divide(a: f64, b: f64) -> Result<f64, String> {
    if b == 0.0 {
        Err("Division by zero".to_string())
    } else {
        Ok(a / b)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn test_registry_builds() {
    // Simply building the dispatcher should collect all registered functions
    let dispatcher = zap_server::build_rpc_dispatcher();

    // Test sync function call
    let result = dispatcher(
        "get_test_data".to_string(),
        json!({"id": 123})
    );
    assert!(result.is_ok(), "get_test_data should succeed");
    assert_eq!(result.unwrap(), json!("test_data_123"));
}

#[tokio::test(flavor = "multi_thread")]
async fn test_async_function() {
    let dispatcher = zap_server::build_rpc_dispatcher();

    // Test async function call
    let result = dispatcher(
        "async_greet".to_string(),
        json!({"name": "World"})
    );
    assert!(result.is_ok(), "async_greet should succeed");
    assert_eq!(result.unwrap(), json!("Hello, World!"));
}

#[tokio::test(flavor = "multi_thread")]
async fn test_result_success() {
    let dispatcher = zap_server::build_rpc_dispatcher();

    // Test successful division
    let result = dispatcher(
        "divide".to_string(),
        json!({"a": 10.0, "b": 2.0})
    );
    assert!(result.is_ok(), "divide should succeed");
    assert_eq!(result.unwrap(), json!(5.0));
}

#[tokio::test(flavor = "multi_thread")]
async fn test_result_error() {
    let dispatcher = zap_server::build_rpc_dispatcher();

    // Test division by zero error
    let result = dispatcher(
        "divide".to_string(),
        json!({"a": 10.0, "b": 0.0})
    );
    assert!(result.is_err(), "divide by zero should fail");
    let error_msg = result.unwrap_err();
    assert!(error_msg.contains("Division by zero"), "Error should mention division by zero");
}

#[tokio::test(flavor = "multi_thread")]
async fn test_async_result_success() {
    let dispatcher = zap_server::build_rpc_dispatcher();

    // Test successful async division
    let result = dispatcher(
        "async_divide".to_string(),
        json!({"a": 20.0, "b": 4.0})
    );
    assert!(result.is_ok(), "async_divide should succeed");
    assert_eq!(result.unwrap(), json!(5.0));
}

#[tokio::test(flavor = "multi_thread")]
async fn test_unknown_function() {
    let dispatcher = zap_server::build_rpc_dispatcher();

    // Test calling unknown function
    let result = dispatcher(
        "unknown_function".to_string(),
        json!({})
    );
    assert!(result.is_err(), "unknown function should fail");
    let error_msg = result.unwrap_err();
    assert!(error_msg.contains("not implemented"), "Error should mention function not implemented");
}

#[tokio::test(flavor = "multi_thread")]
async fn test_missing_parameter() {
    let dispatcher = zap_server::build_rpc_dispatcher();

    // Test calling function with missing parameter
    let result = dispatcher(
        "get_test_data".to_string(),
        json!({}) // missing 'id' parameter
    );
    assert!(result.is_err(), "missing parameter should fail");
    let error_msg = result.unwrap_err();
    assert!(error_msg.contains("Missing parameter"), "Error should mention missing parameter");
}

#[tokio::test(flavor = "multi_thread")]
async fn test_wrong_parameter_type() {
    let dispatcher = zap_server::build_rpc_dispatcher();

    // Test calling function with wrong parameter type
    let result = dispatcher(
        "get_test_data".to_string(),
        json!({"id": "not_a_number"}) // string instead of u64
    );
    assert!(result.is_err(), "wrong parameter type should fail");
    let error_msg = result.unwrap_err();
    assert!(error_msg.contains("deserialize"), "Error should mention deserialization failure");
}

#[tokio::test(flavor = "multi_thread")]
async fn test_non_object_params() {
    let dispatcher = zap_server::build_rpc_dispatcher();

    // Test calling function with array params
    let result = dispatcher(
        "get_test_data".to_string(),
        json!([123]) // array instead of object
    );
    assert!(result.is_err(), "non-object params should fail");
    let error_msg = result.unwrap_err();
    assert!(error_msg.contains("must be an object"), "Error should mention params must be object");

    // Test calling function with string params
    let result = dispatcher(
        "get_test_data".to_string(),
        json!("test") // string instead of object
    );
    assert!(result.is_err(), "string params should fail");
    let error_msg = result.unwrap_err();
    assert!(error_msg.contains("must be an object"), "Error should mention params must be object");
}
