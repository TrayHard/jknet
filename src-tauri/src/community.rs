//! Community API bridge. Credentials stay in the native Online client.
use crate::{error::{AppError, Result}, online::{OnlineClient, OnlineContext}, state::AppState};
use serde_json::Value;

#[tauri::command]
pub async fn community_request(
    state: tauri::State<'_, AppState>, online: tauri::State<'_, OnlineClient>,
    method: String, path: String, body: Option<Value>,
) -> Result<Value> {
    let ctx = OnlineContext::from_settings(&state.settings()?);
    let (method, auth) = route(&method, &path)?;
    online.community(&ctx, method, &format!("/v1/community/{path}"), body, auth).await
}

fn route(method: &str, path: &str) -> Result<(reqwest::Method, bool)> {
    let parts: Vec<_> = path.split('/').collect();
    let id = |value: &str| value.len() == 26 && value.bytes().all(|b| b.is_ascii_alphanumeric());
    let allowed = match (method, parts.as_slice()) {
        ("GET" | "POST", ["servers"]) => true,
        ("GET" | "PUT", ["servers", value]) => id(value),
        ("POST", ["servers", value, "claims"]) => id(value),
        ("POST", ["claims", value, "verify"]) => id(value),
        ("GET", ["me"] | ["admin", "claims"]) => true,
        ("POST", ["admin", "claims", value]) => id(value),
        _ => false,
    };
    if !allowed { return Err(AppError::InvalidInput("Unknown community operation".into())); }
    let auth = !(method == "GET" && parts[0] == "servers");
    Ok((reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| AppError::InvalidInput("Invalid HTTP method".into()))?, auth))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn limits_bridge_to_community_routes() {
        assert!(route("GET","servers").is_ok());
        for path in ["../me", "servers/../../me", "servers?token=x", "https://example.com", "me/extra"] { assert!(route("GET",path).is_err()); }
        assert!(!route("GET","servers").unwrap().1);
        assert!(route("GET","me").unwrap().1);
    }
}
