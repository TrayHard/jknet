//! JKNet launcher core.
//!
//! Builds the Tauri application: plugins, shared state and the command
//! surface the React frontend calls through `src/lib/ipc.ts`.
//!
//! Module map:
//!
//! | Module           | Responsibility                                  |
//! | ---------------- | ----------------------------------------------- |
//! | `paths`          | data folders under `%LOCALAPPDATA%\org.jknet.launcher` and their command |
//! | `settings`       | `settings.json` and its two commands            |
//! | `state`          | shared state injected into every command        |
//! | `game`           | the two games and every constant that differs between them |
//! | `game_files`     | finding the `GameData` of each game and its archives |
//! | `engines`        | static registry of engine builds                |
//! | `engine_install` | GitHub releases, downloads and archive unpacking |
//! | `clients`        | named engine instances on disk                  |
//! | `client_window`  | the separate window that edits one client       |
//! | `servers`        | master server queries, ping and the server cache |
//! | `launch`         | starting a client and watching it run           |
//! | `launch_tokens`  | one cvar at a time inside a client's argument line |
//! | `library`        | pk3 files of one client, in its `home\` folder  |
//! | `profiles`       | player profiles of one client: nickname, skin, hilts |
//! | `appearance`     | the skins and hilts a client can offer a profile |
//! | `levelshots`     | map pictures extracted from the player's pk3 files |
//! | `online`         | JKNet Online: its wire types and its HTTP client |
//! | `account`        | signing in to the service and owning the account |
//! | `friends`        | friends, presence and invites on top of `online` |
//! | `jkhub`          | browsing jkhub.org and installing its files     |
//! | `bundles`        | bundles on JKNet Online: catalogue, publish, install |
//! | `archive`        | one bounded walk over the entries of a pk3, for the modules that list one |
//! | `pk3_editor`     | one pk3 archive open for editing, and the rewrite that saves it |
//! | `hosting`        | a private server on this PC, its relay tunnel, and joining one |
//! | `chat`           | friends chat: summaries, the send queue, the `chat.*` frames, attachments |

mod account;
// --- slice: bundles ---
// The one walk over the entries of a zip archive that `library`, the listing
// of a bundle and the file preview share, with the one limit on how many
// entries any of them keeps.
mod archive;
// --- slice: bundles ---
// Published recipes of clients on JKNet Online: the catalogue, the publish
// plan, the upload and the install. Its own module rather than a part of
// `clients`: a bundle lives on the service, and a client only keeps a link.
mod bundles;
// --- slice: chat ---
// Friends chat on top of `online` and the live socket of `friends`: the
// summaries of every conversation, the send queue, read markers and the
// `chat.*` frames. The core is the only writer; windows display and report.
mod chat;
mod community;
// --- slice: player profiles ---
// The skins and saber hilts a client can offer a profile, read out of the
// archives it loads. Its own module rather than a part of `library`: that one
// owns the pk3 files of a client, this one looks inside them and inside the
// retail archives of the game, which the library never touches.
mod appearance;
mod model_preview;
mod file_preview;
mod base_game;
mod file_preview_products;
// The files of a previewed archive beyond its finished objects — map
// pictures, translations, fonts, shaders, text — by the taxonomy of
// `docs/jknet/pk3-anatomy.md`, and the commands that read one of them.
mod file_preview_contents;
mod media;
mod user_files;
mod configs;
mod video;
mod video_encoder;
mod video_process;
mod video_settings;
mod video_progress;
// --- slice: client window ---
// Opening, finding and closing the `client-<slug>` windows. Kept apart from
// `clients` because it is about windows, not records, and `clients` has to
// stay callable from a test with no Tauri runtime around it.
mod client_window;
mod clients;
mod engine_install;
mod engines;
mod host_system;
mod error;
mod friends;
mod game;
mod game_files;
// --- slice: play with friends ---
// A private server on this PC: the dedicated server of a client under a
// pseudo console, the tunnel to the relay, and the join of a guest.
mod hosting;
/// The whole chain of a private server without a window, for
/// `examples/host_smoke.rs`. Not an API: nothing outside this repository
/// calls it.
#[doc(hidden)]
pub use hosting::smoke;
// --- slice: jkhub ---
// The public pages of jkhub.org, read behind a limiter and a cache. The module
// owns its own HTTP client because a guest download needs the cookie jar the
// file page was served with, which `online` has no reason to share.
mod jkhub;
mod launch;
// --- slice: client window ---
// Reading and writing one cvar inside the launch arguments of a client, so a
// dropdown and a hand-written command line edit the same string.
mod launch_tokens;
mod levelshots;
mod library;
mod library_preview;
// The one client of JKNet Online API v1. `account` calls its sign-in half and
// `friends` the rest, so a token is attached to a request in one place and
// one connection pool serves both.
mod online;
mod paths;
// --- slice: pk3 editor ---
// One pk3 archive open for editing: the entries of a file of a draft or of the
// library of a client, the edits waiting beside it, and the rewrite that puts
// them into the archive. Kept apart from `library` and from `bundles` because
// it serves both and owns neither.
mod pk3_editor;
// --- slice: player profiles ---
// The fourth entity: who the player is inside the game. Kept apart from
// `clients` for the same reason `client_window` is — one module, one document
// — and it has to stay callable from a test with no Tauri runtime around it.
mod profiles;
mod servers;
mod settings;
mod state;
mod timestamp;

use std::path::PathBuf;

use bundles::BundlesState;
use engine_install::InstallState;
use friends::FriendsState;
use launch::LaunchState;
use levelshots::LevelshotState;
use servers::RefreshState;
use state::AppState;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

/// Keeps a log file small enough to attach to a bug report.
const MAX_LOG_FILE_SIZE: u128 = 2 * 1024 * 1024;

/// Reqwest enables aws-lc-rs and the updater enables ring. Select one before
/// any client builds its TLS configuration; otherwise secure WebSockets panic.
fn configure_tls() {
    // A process may already have selected its provider (for example in tests).
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

/// Resolves the folder that holds `settings.json`.
///
/// Tauri answers `%LOCALAPPDATA%\org.jknet.launcher`, the folder named after
/// the bundle identifier. That is on purpose: the NSIS installer owns
/// `%LOCALAPPDATA%\JKNet`, and its uninstaller offers to delete exactly the
/// folder resolved here. The two fallbacks cover a machine where the resolver
/// finds nothing, and go to stderr because the log file lives under the path
/// this function returns.
fn resolve_config_root(app: &tauri::App) -> PathBuf {
    match app.path().app_local_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("jknet: {e}, resolving the data folder from the environment");
            paths::config_root().unwrap_or_else(|e| {
                eprintln!("jknet: {e}, falling back to the temp folder");
                std::env::temp_dir().join("org.jknet.launcher")
            })
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_tls();
    tauri::Builder::default()
        .manage(video::VideoState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // --- slice: i18n ---
        // `locale()` alone: a launcher set to «System language» has to know
        // which language Windows is in before the first screen paints.
        .plugin(tauri_plugin_os::init())
        // --- slice: installer ---
        // `relaunch()` after the update installer hands control back.
        .plugin(tauri_plugin_process::init())
        // --- slice: client window ---
        // The launcher is one application with one way out. A client window
        // has no navigation of its own, so a `main` that closed while two of
        // them stayed open would leave a process alive behind windows that
        // cannot reach anything else. Only actual destruction closes secondary
        // windows: the main frontend can cancel a close over an unsaved draft.
        //
        // Both are logged for every window, not only for `main`. A window that
        // refuses to close and a window that closed without the frontend
        // noticing look the same from outside; the log tells them apart,
        // because a click on the close button that reached the core leaves a
        // `close requested` line with the label of the window it came from.
        .on_window_event(|window, event| {
            let label = window.label();
            // --- slice: chat window ---
            // The chat window keeps its own bounds for each of its two
            // modes, and writes them when it goes; see `chat::window`.
            if label == chat::window::LABEL {
                chat::window::track(window, event);
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    log::info!("window {label}: close requested");
                    // --- slice: play with friends ---
                    // Closing JKNet stops the private server, so the window
                    // asks first. The frontend guard of unsaved drafts holds
                    // every close of `main` anyway; this covers a window that
                    // has no such guard.
                    if label == "main" && hosting::hold_close(window.app_handle()) {
                        api.prevent_close();
                        return;
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    log::info!("window {label}: destroyed");
                    // --- slice: chat ---
                    // A closed window no longer shows a conversation, so
                    // messages there count as unread again.
                    chat::forget_window(window.app_handle(), label);
                }
                // --- slice: chat ---
                // Files dropped on `main` or `chat` while that window reports
                // an open composer become attachments; the window hears
                // `chat:files-staged`. Any other drop is the screen's own.
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    chat::files::dropped(window.app_handle(), label, paths);
                    return;
                }
                _ => return,
            }
            if label != "main" || !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            video::cancel_all(&window.state::<video::VideoState>());
            // --- slice: play with friends ---
            // The window went without asking: stop the server on the way out
            // rather than leave it to the Job Object.
            hosting::shutdown_on_exit(window.app_handle());
            // Best effort by design: `close_all` logs whatever refuses to
            // close and never panics, so the way out of the launcher cannot be
            // blocked by a window that is already gone.
            client_window::close_all(window.app_handle());
        })
        .setup(|app| {
            // Everything below needs the config root, and the config root needs
            // an `AppHandle`, so the whole bootstrap lives in `setup`. Nothing
            // from the webview can arrive first: Tauri runs `setup` inside
            // `build()`, before the event loop starts pumping messages.
            let config_root = resolve_config_root(app);
            // Earlier builds wrote into `%LOCALAPPDATA%\JKNet`. Their files
            // move here once, before anything reads `settings.json`. The report
            // waits for the log plugin a few lines down.
            let migration = match paths::legacy_config_root() {
                Ok(legacy_root) => {
                    let report = paths::migrate_legacy_root(&legacy_root, &config_root);
                    Some((legacy_root, report))
                }
                Err(e) => {
                    eprintln!("jknet: {e}, skipping the move out of the old data folder");
                    None
                }
            };

            let app_state = AppState::bootstrap(config_root);
            let log_dir = app_state
                .paths()
                .map(|paths| paths.logs)
                .unwrap_or_else(|_| std::env::temp_dir().join("org.jknet.launcher").join("logs"));

            // Stdout and a file, and deliberately no `TargetKind::Webview`:
            // `src/main.tsx` mirrors the frontend console into this plugin, so
            // a webview target would send every line straight back to it.
            //
            // `targets` replaces the plugin's own list, and `target` would
            // extend it. The default list holds `TargetKind::LogDir`, which
            // writes `JKNet.log` into `app_log_dir()` — the same folder, and on
            // a case-insensitive disk the same file, as the folder target
            // below. Two appenders on one file wrote every line twice.
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .level(log::LevelFilter::Info)
                    .max_file_size(MAX_LOG_FILE_SIZE)
                    .targets([
                        Target::new(TargetKind::Stdout),
                        Target::new(TargetKind::Folder {
                            path: log_dir,
                            file_name: Some("jknet".to_string()),
                        }),
                    ])
                    .build(),
            )?;
            if let Some((legacy_root, report)) = &migration {
                report.report(legacy_root, &app_state.config_root);
            }
            // --- slice: maps ---
            // The asset protocol serves `cache\levelshots\` to the webview.
            // `tauri.conf.json` scopes it to the folder under `$APPLOCALDATA`;
            // this adds the resolved one, which differs when the player moved
            // the data folder with `dataDirOverride`.
            // The pictures of the description of a bundle draft are not
            // added here: `bundles::images` opens the `images\` folder of
            // one draft when a picture of it is added or asked for.
            if let Ok(paths) = app_state.paths() {
                levelshots::allow_cache_folder(app.handle(), &paths);
            }
            app.manage(app_state);

            #[cfg(desktop)]
            {
                // --- slice: chat window ---
                // The plugin keeps one set of bounds per label; the chat
                // window has two, one per mode, and keeps them itself.
                app.handle().plugin(
                    tauri_plugin_window_state::Builder::default()
                        .with_denylist(&[chat::window::LABEL])
                        .build(),
                )?;
                // --- slice: installer ---
                // The updater is desktop only: it has no mobile backend.
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            // --- slice: account ---
            // From here on a service that refuses the stored token signs the
            // launcher out, instead of leaving a signed-in sidebar over a
            // screen where every call fails. The client reports the refusal,
            // `account` owns what it means.
            let signed_out = app.handle().clone();
            app.state::<online::OnlineClient>()
                .report_refusals_to(move |token| {
                    account::expire_session(&signed_out, token);
                });
            // --- slice: friends ---
            // The heartbeat and the live socket. Both start signed out and
            // cost nothing until a token appears, and neither of them touches
            // the window, so nothing here can hold up the first frame.
            friends::start(app.handle());
            // --- slice: chat ---
            // The sync task: it follows the account and the epochs of the
            // live socket that `friends::start` has just set up.
            chat::start(app.handle());
            // --- slice: jkhub ---
            // One client, one cookie jar and one limiter for the whole run.
            // Built here rather than per call: the session a `csrfKey` belongs
            // to is the session that jar holds.
            jkhub::manage(app.handle());
            // --- slice: jkhub index startup ---
            // Which folder the bundled category trees and catalogue indexes
            // come from, and what is missing from it. A build that shipped
            // without one used to be noticed as a crawl the day somebody
            // searched; now it is a line in the first page of the log.
            jkhub::snapshot::check(app.handle());
            // And the index itself, a few seconds from now: building it under
            // a player who has already typed a word is what this replaces.
            // Nothing here blocks the window — the work is a spawned task, and
            // the plan is usually «nothing».
            jkhub::prewarm::start(app.handle());
            // --- review: downloads of failed installs are never removed ---
            // An install that ended yesterday cannot be resumed by any screen
            // open today, so its archive goes. A scan of a folder with a
            // handful of entries, and a failure inside is a line in the log.
            if let Ok(paths) = app.state::<AppState>().paths() {
                jkhub::download::sweep(&paths, jkhub::download::KEPT_FOR);
            }

            log::info!("JKNet {} started", app.package_info().version);
            // --- slice: online gate ---
            // The first question a report about a missing Friends screen has
            // to answer: this build has no service, or it has one and cannot reach
            // it. The address is not a secret; the token never appears here.
            match app.state::<AppState>().settings() {
                Ok(settings) => {
                    let url = online::normalize_online_url(&settings.online_url);
                    if online::online_configured(&url) {
                        log::info!("online: {url}");
                    } else {
                        log::info!(
                            "online: not configured in this build, so the account and friends screens stay switched off"
                        );
                    }
                }
                Err(e) => log::warn!("cannot read the service address: {e}"),
            }
            Ok(())
        })
        // --- slice: launch ---
        // The running game lives in its own managed value: a process handle
        // has no business sitting behind the settings lock. The set of clients
        // with an install in flight is separate for the same reason.
        .manage(LaunchState::default())
        .manage(InstallState::default())
        // --- slice: maps ---
        // One rebuild of the levelshot index at a time, and the set of maps
        // nothing on this disk has a picture for.
        .manage(LevelshotState::default())
        // --- slice: account ---
        // One connection pool for every call to the service. Where to call and
        // who to call as come from the settings at the moment of the call, so
        // nothing here goes stale when the player signs in or points the
        // launcher at another service.
        .manage(online::OnlineClient::new())
        // --- slice: friends ---
        // The presence the launcher reports and whether the live socket is
        // up. Kept apart from `AppState` for the same reason as the two above:
        // a background task must not queue behind a settings write.
        .manage(FriendsState::default())
        // --- slice: chat ---
        // The summaries, drafts, send queue and read markers of chat. Memory
        // only: the service keeps the history.
        .manage(chat::ChatState::default())
        // --- slice: chat window ---
        // The one chat window: its build lock and its mode, bounds and
        // switches between writes of `settings.json`.
        .manage(chat::window::ChatWindowState::default())
        // --- slice: servers browser ---
        // Which tabs of which game have a scan in flight. Two tabs may scan at
        // once, one tab may not scan twice: the guard lives here rather than in
        // a disabled button, because a reloaded window would press it again.
        .manage(RefreshState::default())
        // --- slice: bundles ---
        // The clients a plan, a publish or an install of a bundle is running
        // for, and the versions an install has started for. Separate from
        // `InstallState`, because an install of a bundle holds this claim
        // while it takes that one for the engine step; `install_engine` and
        // `delete_client` claim it too, so neither runs under a bundle.
        .manage(BundlesState::default())
        // --- slice: pk3 editor ---
        // The archives open in the editor. One session per archive, and the
        // folder each one keeps its unsaved bytes in goes with the session.
        .manage(pk3_editor::Pk3EditorState::default())
        // --- slice: play with friends ---
        // The one private server, its session and its supervisor.
        .manage(hosting::HostState::default())
        .invoke_handler(tauri::generate_handler![
            video::list_video_jobs,
            video::export_demo_video,
            video::cancel_video_job,
            video_settings::video_preferences,
            video_settings::save_video_preset,
            video_settings::delete_video_preset,
            video::prepare_video_preview,
            configs::list_configs,
            configs::save_config,
            configs::delete_config,
            configs::set_config_layers,
            configs::config_conflicts,
            configs::merge_configs,
            configs::client_config_files,
            configs::client_config_context,
            configs::set_default_config,
            configs::profile_bind_command,
            media::list_media,
            media::update_media,
            media::delete_media,
            media::delete_media_batch,
            media::open_media_folder,
            media::copy_screenshot,
            media::play_media_demo,
            model_preview::get_preview_assets,
            file_preview::preview_library_file,
            base_game::preview_base_game,
            file_preview::get_file_preview_assets,
            file_preview::release_file_preview,
            file_preview_contents::get_file_preview_image,
            file_preview_contents::get_file_preview_text,
            jkhub::jkhub_preview,
            settings::get_settings,
            settings::update_settings,
            paths::get_data_paths,
            game_files::detect_game_files,
            // --- slice: game core ---
            // The two games and the names the interface prints for them.
            game::list_games,
            // `inspect_game_files` became `validate_game_data`: the same work
            // for one folder, plus the game it is being checked against.
            game_files::validate_game_data,
            engines::list_engines,
            clients::list_clients,
            clients::create_client,
            clients::update_client,
            clients::delete_client,
            // --- slice: clients page ---
            clients::client_dir,
            // --- slice: client window ---
            client_window::open_client_window,
            launch_tokens::read_launch_cvars,
            launch_tokens::write_launch_cvar,
            launch::preview_launch_args,
            launch::launch_client,
            // --- slice: player profiles ---
            profiles::list_profiles,
            profiles::save_profile,
            profiles::delete_profile,
            profiles::set_default_profile,
            appearance::list_player_models,
            appearance::list_saber_hilts,
            // --- slice: skins and hilts ---
            appearance::assembled_skin_preview,
            // --- slice: library ---
            library::list_library,
            library::inspect_pk3,
            library::add_library_files,
            library::set_library_item_enabled,
            library::remove_library_item,
            library::rename_library_item,
            library::find_library_conflicts,
            // --- slice: launch ---
            engines::list_engine_releases,
            engines::install_engine,
            engines::check_engine_update,
            launch::get_running_game,
            launch::stop_game,
            // --- slice: servers ---
            servers::get_cached_servers,
            servers::refresh_servers,
            servers::refresh_addresses,
            servers::refresh_lan,
            servers::get_server_status,
            servers::set_server_favorite,
            servers::add_server_history,
            // --- slice: server actions ---
            servers::set_server_hidden,
            // --- slice: maps ---
            levelshots::get_levelshot,
            levelshots::rebuild_levelshots,
            levelshots::list_levelshots,
            // --- slice: account ---
            account::get_account_state,
            community::community_request,
            account::begin_sign_in,
            account::poll_sign_in,
            account::sign_out,
            account::update_display_name,
            account::delete_account,
            // --- slice: friends ---
            friends::get_friends_state,
            friends::send_friend_request,
            friends::accept_friend_request,
            friends::decline_friend_request,
            friends::remove_friend,
            friends::send_invite,
            friends::dismiss_invite,
            friends::join_friend,
            // --- slice: play with friends ---
            friends::accept_invite,
            hosting::host_get_options,
            hosting::host_list_maps,
            hosting::host_start,
            hosting::host_stop,
            hosting::host_get_session,
            hosting::host_join_own,
            hosting::host_change_map,
            hosting::host_set_join_policy,
            hosting::host_retry_relay,
            hosting::host_invite,
            hosting::host_open_log,
            // --- slice: chat ---
            chat::chat_get_state,
            chat::chat_get_messages,
            chat::chat_open_direct,
            chat::chat_send,
            chat::chat_retry,
            chat::chat_discard,
            chat::chat_set_viewing,
            chat::chat_mark_read,
            chat::chat_typing,
            chat::chat_react,
            chat::chat_create_group,
            chat::chat_rename_group,
            chat::chat_set_history_for_new_members,
            chat::chat_add_members,
            chat::chat_remove_member,
            chat::chat_leave,
            chat::chat_answer_group_invite,
            chat::chat_set_notify,
            chat::chat_search,
            chat::chat_get_privacy,
            chat::chat_update_privacy,
            chat::chat_get_draft,
            chat::chat_set_draft,
            // Attachments: staged through the core, downloaded into its cache,
            // saved and imported by it.
            chat::files::chat_pick_files,
            chat::files::chat_stage_media,
            chat::files::chat_stage_clipboard_image,
            chat::files::chat_unstage,
            chat::files::chat_file_local,
            chat::files::chat_file_save,
            chat::files::chat_file_import,
            // Cards, built and checked by the rules of the service and turned
            // into the input of the existing editors; links; the danger scan.
            chat::cards::chat_build_card,
            chat::cards::chat_check_card,
            chat::cards::chat_card_from_profile,
            chat::cards::chat_card_to_profile,
            chat::cards::chat_card_to_config,
            chat::cards::chat_scan_commands,
            chat::links::chat_open_link,
            // The chat of a private server: joined from a host invite card.
            // The host opens and closes it from the hosting hooks, guests
            // join it from `join_private`, without a command of their own.
            chat::server::chat_join_host_card,
            // --- slice: chat window ---
            // The separate chat window and its compact mode over a game.
            chat::window::open_chat_window,
            chat::window::chat_window_state,
            chat::window::chat_window_set_compact,
            chat::window::chat_window_set_always_on_top,
            chat::window::chat_window_set_opacity,
            // --- slice: jkhub ---
            jkhub::jkhub_categories,
            jkhub::jkhub_list,
            jkhub::jkhub_file,
            jkhub::jkhub_comments,
            jkhub::jkhub_resolve_download,
            jkhub::jkhub_install,
            jkhub::jkhub_open,
            jkhub::jkhub_clear_cache,
            // --- slice: jkhub index ---
            jkhub::jkhub_search,
            jkhub::jkhub_index_status,
            jkhub::jkhub_refresh_index,
            // --- slice: jkhub index startup ---
            jkhub::jkhub_cancel_index,
            // --- slice: bundles ---
            bundles::list_bundles,
            bundles::get_bundle,
            bundles::get_bundle_version,
            bundles::install_bundle,
            bundles::install_bundle_draft,
            bundles::publish_bundle_draft,
            bundles::like_bundle,
            bundles::my_bundles,
            bundles::delete_bundle,
            bundles::list_pending_bundle_versions,
            bundles::review_bundle_version,
            bundles::set_bundle_flags,
            // The drafts of bundles, edited one command at a time.
            bundles::draft::list_bundle_drafts,
            bundles::draft::create_bundle_draft,
            bundles::draft::create_bundle_draft_from_bundle,
            bundles::draft::get_bundle_draft,
            bundles::draft::update_bundle_draft,
            bundles::draft::delete_bundle_draft,
            bundles::draft::draft_add_component,
            bundles::draft::draft_update_component,
            bundles::draft::draft_remove_component,
            bundles::draft::draft_add_files_from_disk,
            bundles::draft::draft_add_file_from_jkhub,
            bundles::draft::draft_add_files_from_client,
            bundles::draft::draft_remove_file,
            bundles::draft::draft_set_configs,
            bundles::draft::draft_engine_files,
            bundles::draft::draft_replace_engine_file,
            bundles::draft::draft_add_engine_files,
            bundles::draft::draft_exclude_engine_file,
            bundles::draft::draft_restore_engine_file,
            bundles::draft::validate_bundle_draft,
            // The pictures of the description of a draft.
            bundles::images::draft_add_image,
            bundles::images::draft_remove_image,
            bundles::images::draft_image_path,
            // What is inside a file: the listing of a pk3, the text of a cfg.
            bundles::listing::draft_file_listing,
            bundles::listing::bundle_file_listing,
            bundles::listing::draft_file_text,
            bundles::listing::bundle_file_text,
            // The Library preview on a pk3 of a draft or of the catalogue.
            bundles::preview::preview_draft_file,
            bundles::preview::preview_bundle_file,
            // --- slice: pk3 editor ---
            // One open archive: the session, the reads of its entries and the
            // edits, ending in the rewrite that also updates the owner.
            pk3_editor::pk3_editor_open,
            pk3_editor::pk3_editor_state,
            pk3_editor::pk3_editor_read_text,
            pk3_editor::pk3_editor_read_image,
            pk3_editor::pk3_editor_write_text,
            pk3_editor::pk3_editor_replace,
            pk3_editor::pk3_editor_add_files,
            pk3_editor::pk3_editor_remove,
            pk3_editor::pk3_editor_rename,
            pk3_editor::pk3_editor_extract,
            pk3_editor::pk3_editor_save,
            pk3_editor::pk3_editor_discard,
            pk3_editor::pk3_editor_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
