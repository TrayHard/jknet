//! Invariants of the updater section of `tauri.conf.json`.
//!
//! The updater is the one feature whose failure is invisible until it is too
//! late: a launcher shipped with an empty `pubkey` or a plain-HTTP endpoint
//! installs fine and then never updates again, on every machine that already
//! has it. These checks fail the build instead, while the mistake is still one
//! commit old.

use serde_json::Value;

/// Reads the config next to this test, whatever the working directory is.
fn config() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
    let text = std::fs::read_to_string(path).expect("tauri.conf.json is readable");
    serde_json::from_str(&text).expect("tauri.conf.json is valid JSON")
}

#[test]
fn bundles_the_updater_artifacts() {
    let config = config();
    assert_eq!(
        config["bundle"]["createUpdaterArtifacts"],
        Value::Bool(true),
        "without createUpdaterArtifacts the build produces no .sig and the \
         release has nothing to publish",
    );
}

#[test]
fn carries_a_minisign_public_key() {
    let config = config();
    let pubkey = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("plugins.updater.pubkey is a string");
    assert!(
        !pubkey.trim().is_empty(),
        "an empty pubkey disables signature checking and the plugin refuses \
         to start",
    );
    // The value is the base64 of the whole `.pub` file, comment line included.
    let decoded = base64_decode(pubkey).expect("pubkey is base64");
    let decoded = String::from_utf8(decoded).expect("pubkey decodes to text");
    assert!(
        decoded.contains("minisign public key"),
        "pubkey must be the content of the generated .pub file, not a path: {decoded}",
    );
}

#[test]
fn every_endpoint_uses_tls() {
    let config = config();
    let endpoints = config["plugins"]["updater"]["endpoints"]
        .as_array()
        .expect("plugins.updater.endpoints is an array");
    assert!(!endpoints.is_empty(), "an updater with no endpoint never checks");
    for endpoint in endpoints {
        let url = endpoint.as_str().expect("every endpoint is a string");
        assert!(
            url.starts_with("https://"),
            "the plugin rejects a non-TLS endpoint in a release build: {url}",
        );
    }
}

#[test]
fn installs_without_administrator_rights() {
    let config = config();
    assert_eq!(
        config["bundle"]["windows"]["nsis"]["installMode"],
        Value::String("currentUser".to_string()),
        "perMachine asks for elevation, and a passive update installer that \
         asks for elevation stops on a UAC prompt nobody sees",
    );
}

/// Decodes standard base64. Small enough to keep the test free of a crate.
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = ALPHABET.iter().position(|c| *c == byte)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}
