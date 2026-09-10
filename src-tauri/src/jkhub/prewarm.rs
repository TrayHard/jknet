//! Building the catalogue index before anybody searches for anything.
//!
//! The index used to be built by the first search that needed it. On a machine
//! whose index was missing that meant a full crawl of jkhub.org under a player
//! who had already typed a word — a minute and a half of an empty grid with
//! one progress line under it.
//!
//! So the launcher pays for it up front instead. A few seconds after the
//! window appears, the index of the active game is brought up to date, and the
//! other game follows once that is done. Both go through
//! [`super::ensure_index`], which is the same work `jkhub_index_status` starts
//! behind its answer: the same plan ([`super::index::plan`]), the same
//! once-a-day guard per game, the same events. Nothing here shortens the
//! interval — a launcher started twice in an hour reads the site once.
//!
//! The delays are not about the site, which never sees a request until the
//! plan calls for one. They are about the first frame: a crawl started in the
//! same instant as the window would compete with reading the settings, the
//! clients and the server cache for the same async workers.

use std::time::Duration;

use tauri::{AppHandle, Listener, Manager};

use crate::game::Game;
use crate::settings::{ActiveGameChanged, ACTIVE_GAME_EVENT};
use crate::state::AppState;

/// How long after the launcher starts the active game is warmed.
pub const FIRST_DELAY: Duration = Duration::from_secs(2);

/// How long after the first one finishes the other game follows.
pub const NEXT_DELAY: Duration = Duration::from_secs(5);

/// Which games to warm, in order, and how long to wait before each.
///
/// The active game first, because it is the catalogue the tab will open on;
/// the other one after it, because a player who switches games should not wait
/// for a crawl either. The second delay is counted from the moment the first
/// game is done, not from the start: one crawl at a time keeps the whole
/// launcher inside the four requests the limiter allows.
///
/// Pure, so the order is a test rather than a stopwatch.
pub fn schedule(active: Game) -> [(Game, Duration); 2] {
    let other = Game::ALL
        .into_iter()
        .find(|game| *game != active)
        .unwrap_or(active);
    [(active, FIRST_DELAY), (other, NEXT_DELAY)]
}

/// Starts the pre-warm and the watch on the game switch.
///
/// Returns at once: everything below runs on the async runtime, and nothing in
/// it touches the window.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let active = handle
            .state::<AppState>()
            .settings()
            .map(|settings| settings.active_game)
            .unwrap_or_default();
        for (game, wait) in schedule(active) {
            tokio::time::sleep(wait).await;
            super::ensure_index(&handle, game).await;
        }
    });
    watch_the_active_game(app);
}

/// Warms the game the player just switched to.
///
/// Both games are warmed at startup, so this normally finds the once-a-day
/// guard already set and returns without a request. It matters on the launcher
/// that was started while the site was unreachable, and on the one whose
/// switch happens a day later without a restart.
fn watch_the_active_game(app: &AppHandle) {
    let handle = app.clone();
    app.listen(ACTIVE_GAME_EVENT, move |event| {
        let Ok(payload) = serde_json::from_str::<ActiveGameChanged>(event.payload()) else {
            log::debug!("jkhub: cannot read {ACTIVE_GAME_EVENT}, skipping the pre-warm");
            return;
        };
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            super::ensure_index(&handle, payload.game).await;
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_active_game_is_warmed_first_and_the_other_one_follows() {
        let [(first, first_wait), (second, second_wait)] = schedule(Game::JediAcademy);
        assert_eq!(first, Game::JediAcademy);
        assert_eq!(second, Game::JediOutcast);
        assert_eq!(first_wait, FIRST_DELAY);
        assert_eq!(second_wait, NEXT_DELAY);

        let [(first, _), (second, _)] = schedule(Game::JediOutcast);
        assert_eq!(first, Game::JediOutcast);
        assert_eq!(second, Game::JediAcademy);
    }

    /// Every game is warmed, and none of them twice.
    #[test]
    fn the_schedule_covers_both_games_exactly_once() {
        for active in Game::ALL {
            let games: Vec<Game> = schedule(active).into_iter().map(|(game, _)| game).collect();
            assert_eq!(games.len(), Game::ALL.len());
            for game in Game::ALL {
                assert_eq!(
                    games.iter().filter(|entry| **entry == game).count(),
                    1,
                    "{} is warmed once when {} is active",
                    game.id(),
                    active.id()
                );
            }
        }
    }

    /// The window has to be on screen before the launcher starts reading
    /// another project's site, and the two games must not crawl at once.
    #[test]
    fn the_delays_leave_the_first_frame_alone() {
        assert!(FIRST_DELAY >= Duration::from_secs(1));
        assert!(NEXT_DELAY >= FIRST_DELAY);
    }
}
