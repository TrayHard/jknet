//! Build script of the launcher core.
//!
//! `tauri_build::build()` copies everything `bundle.resources` names into the
//! folder next to the binary, and prints a `cargo:rerun-if-changed` line for
//! each file it copied. That covers a file that changed; it does not cover a
//! file that appeared. A snapshot added to `resources/jkhub/` after the last
//! run of this script is never copied, because cargo has no reason to run the
//! script again — which is exactly how a development build ended up resolving
//! a resource folder that held the category trees and no catalogue index, and
//! crawling jkhub.org from scratch on the first search.
//!
//! So the folder is watched as a whole — cargo walks it, so a file appearing
//! or disappearing re-runs this script — and every snapshot is watched by name
//! as well.

/// Snapshots the launcher ships. Named one by one on top of the folder above
/// them, because a directory stamp is not preserved by every checkout.
const SNAPSHOT_DIR: &str = "resources/jkhub";

fn main() {
    println!("cargo:rerun-if-changed=resources");
    if let Ok(entries) = std::fs::read_dir(SNAPSHOT_DIR) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".json") {
                println!("cargo:rerun-if-changed={SNAPSHOT_DIR}/{name}");
            }
        }
    }
    tauri_build::build()
}
