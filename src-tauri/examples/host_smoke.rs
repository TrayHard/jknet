//! Smoke test of a private server: a real dedicated server, no window.
//!
//! ```text
//! cargo run --example host_smoke -- [--engine <engine dir>] [--game-data <GameData>]
//!                                   [--port 29170] [--map mp/ffa3] [--online http://127.0.0.1:8787]
//! ```
//!
//! Copies the `engine\` folder of a Jedi Academy client into a temporary
//! folder, starts its dedicated server there under a pseudo console with
//! `net_ip 127.0.0.1`, waits for the label of the session, asks it
//! `getstatus` and `getinfo` — the second from `127.77.0.5`, the way the
//! tunnel binds a guest — and stops it with `rcon quit`. With `--online`, a
//! local JKNet Online with its relay and its `dev` provider switched on, the
//! run signs in two accounts, opens a relay session, runs the tunnel, asks
//! the server through the relay's public port, renews the ticket, expects a
//! second session of the account to be refused, and has the second account
//! see the server in the host's presence and get an invite to it.
//!
//! Without `--engine` the run takes the first client of the launcher's data
//! folder whose engine carries `openjkded.x86.exe`, and reads the game folder
//! out of `settings.json`. Nothing there is written: the copy is what runs.
//! Everything listens on loopback, and the temporary folder goes at the end.

use std::path::{Path, PathBuf};
use std::time::Duration;

use jknet_lib::smoke::{self, SmokeConfig, SmokeOnline};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|at| args.get(at + 1).cloned())
}

fn data_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|root| PathBuf::from(root).join("org.jknet.launcher"))
}

/// The first client whose engine has the dedicated server of OpenJK x86.
fn find_engine() -> Option<(PathBuf, &'static str)> {
    let clients = data_root()?.join("clients");
    let mut entries: Vec<PathBuf> = std::fs::read_dir(clients).ok()?.flatten().map(|e| e.path()).collect();
    entries.sort();
    for client in entries {
        let engine = client.join("engine");
        for exe in ["openjkded.x86.exe", "openjkded.x86_64.exe"] {
            if engine.join(exe).is_file() {
                return Some((engine, exe));
            }
        }
    }
    None
}

fn game_data_from_settings() -> Option<PathBuf> {
    let text = std::fs::read_to_string(data_root()?.join("settings.json")).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&text).ok()?;
    doc["gameDataPaths"]["ja"].as_str().map(PathBuf::from)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<u64> {
    std::fs::create_dir_all(to)?;
    let mut bytes = 0;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            bytes += copy_dir(&entry.path(), &target)?;
        } else {
            bytes += std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(bytes)
}

/// Signs in to a local JKNet Online with its `dev` provider as `name` and
/// answers the token.
async fn dev_sign_in(url: &str, name: &str) -> Result<String, String> {
    let http = reqwest::Client::new();
    let session: serde_json::Value = http
        .post(format!("{url}/v1/auth/login-sessions"))
        .header("content-type", "application/json")
        .body(r#"{"provider":"dev","deviceName":"host smoke"}"#)
        .send()
        .await
        .map_err(|e| format!("login session: {e}"))?
        .json_value()
        .await?;
    let id = session["id"].as_str().ok_or("no session id")?.to_string();
    let page = http
        .get(session["url"].as_str().ok_or("no session url")?)
        .send()
        .await
        .map_err(|e| format!("dev form: {e}"))?
        .text()
        .await
        .map_err(|e| format!("dev form: {e}"))?;
    let state = page
        .split("name=\"state\" value=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .ok_or("the dev form carries no state")?
        .to_string();
    // The state is URL-safe as the service makes it; the names have no space.
    http.get(format!("{url}/v1/auth/dev/callback?state={state}&name={name}"))
        .send()
        .await
        .map_err(|e| format!("dev callback: {e}"))?;
    for _ in 0..20 {
        let poll: serde_json::Value = http
            .get(format!("{url}/v1/auth/login-sessions/{id}"))
            .send()
            .await
            .map_err(|e| format!("poll: {e}"))?
            .json_value()
            .await?;
        if let Some(token) = poll["token"].as_str() {
            return Ok(token.to_string());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("the dev sign-in never finished".into())
}

trait JsonValue {
    async fn json_value(self) -> Result<serde_json::Value, String>;
}

impl JsonValue for reqwest::Response {
    async fn json_value(self) -> Result<serde_json::Value, String> {
        let status = self.status();
        let text = self.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| format!("{e}: {text}"))
    }
}

fn main() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (engine, exe) = match arg("--engine") {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            let exe = if dir.join("openjkded.x86.exe").is_file() { "openjkded.x86.exe" } else { "openjkded.x86_64.exe" };
            (dir, exe)
        }
        None => find_engine().expect("no client with an OpenJK dedicated server; pass --engine"),
    };
    let game_data = arg("--game-data")
        .map(PathBuf::from)
        .or_else(game_data_from_settings)
        .expect("no Jedi Academy game folder; pass --game-data");
    let port: u16 = arg("--port").and_then(|p| p.parse().ok()).unwrap_or(29170);
    let map = arg("--map").unwrap_or_else(|| "mp/ffa3".into());

    let temp = tempfile::Builder::new().prefix("jknet-host-smoke-").tempdir().expect("a temp folder");
    let engine_copy = temp.path().join("engine");
    let copied = copy_dir(&engine, &engine_copy).expect("the engine copies");
    println!("engine: {} ({} MB copied into {})", engine.display(), copied / 1_048_576, engine_copy.display());
    println!("game data: {}", game_data.display());

    let online = arg("--online").map(|url| {
        let url = url.trim_end_matches('/').to_string();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let host_token = runtime.block_on(dev_sign_in(&url, "SmokeHost")).expect("the dev sign-in works");
        let guest_token = runtime.block_on(dev_sign_in(&url, "SmokeGuest")).expect("the dev sign-in works");
        println!("signed in to {url} as SmokeHost and SmokeGuest");
        SmokeOnline { url, host_token, guest_token }
    });

    let config = SmokeConfig {
        executable: engine_copy.join(exe),
        engine_dir: engine_copy,
        game_data,
        home_dir: temp.path().join("home"),
        first_port: port,
        map,
        log_file: temp.path().join("host-server.log"),
        online,
    };
    match smoke::run(config) {
        Ok(report) => {
            for line in report {
                println!("ok  {line}");
            }
            println!("host smoke: passed");
        }
        Err(e) => {
            eprintln!("host smoke: FAILED: {e}");
            std::process::exit(1);
        }
    }
}
