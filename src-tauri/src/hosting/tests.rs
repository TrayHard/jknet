//! Tests of the session state and of the pure pieces of `mod.rs`.

use super::*;
use crate::online::OnlineUser;

fn settings() -> HostSettings {
    HostSettings {
        client_id: "everyday".into(),
        map: "mp/ffa3".into(),
        gametype: 0,
        max_players: 8,
        time_limit: 0,
        score_limit: 20,
        bots: 0,
        server_name: "Tray's game".into(),
        password: Some("k7m2q9xa".into()),
        network: Network::InternetLan,
        join_policy: JoinPolicy::Friends,
        join_user_ids: Vec::new(),
        invite_user_ids: Vec::new(),
        join_after_start: true,
    }
}

fn session(status: SessionStatus) -> HostSession {
    HostSession {
        id: "5e0b7c1f9a2d4c38".into(),
        status,
        steps: vec![
            HostStep { step: StepId::Server, state: StepState::Done },
            HostStep { step: StepId::Map, state: StepState::Done },
            HostStep { step: StepId::Relay, state: StepState::Done },
        ],
        settings: settings(),
        game: Game::JediAcademy,
        pid: Some(4242),
        port: Some(29070),
        local_address: Some("127.0.0.1:29070".into()),
        lan_addresses: vec!["192.168.1.23:29070".into()],
        relay: HostRelay {
            status: RelayStatus::Active,
            address: Some("203.0.113.5:29210".into()),
            region: Some("eu".into()),
            expires_at: Some("2026-09-25T22:00:00Z".into()),
            error: None,
            error_code: None,
        },
        players: vec![
            HostPlayer { name: "^1Kyle".into(), score: 3, ping: 42, bot: false },
            HostPlayer { name: "Reborn".into(), score: 0, ping: 0, bot: true },
        ],
        invited: Vec::new(),
        joined_count: 1,
        started_at: "2026-09-25T20:00:00Z".into(),
        ready_at: Some("2026-09-25T20:00:01Z".into()),
        empty_since: None,
        auto_stop_at: None,
        stopped_at: None,
        stop_reason: None,
        exit_code: None,
        failure: None,
        log_tail: Vec::new(),
    }
}

fn live(status: SessionStatus) -> Arc<Live> {
    let (commands, _receiver) = mpsc::unbounded_channel();
    let (_finished_tx, finished) = watch::channel(false);
    Arc::new(Live {
        view: Mutex::new(session(status)),
        commands,
        finished,
        rcon_password: "r4n9d0mr4n9d0mr4n9d0mr4".into(),
        fs_game: None,
    })
}

#[test]
fn a_second_start_while_the_first_is_starting_is_refused_with_host_busy() {
    let state = HostState::default();
    let claim = state.claim().expect("the first start claims the slot");
    // The first start is still preparing: nothing is in the slot yet.
    assert!(matches!(state.claim(), Err(AppError::HostBusy)));
    assert!(state.is_active());

    // A start that fails before its session exists gives the slot back.
    drop(claim);
    assert!(!state.is_active());

    let claim = state.claim().expect("free again");
    state.commit(claim, live(SessionStatus::Starting));
    assert!(matches!(state.claim(), Err(AppError::HostBusy)));
    assert!(matches!(state.running(), Err(AppError::HostNotRunning)));

    // The session ends. It leaves the slot to the next start and stays
    // readable until then.
    let current = state.live().expect("the session is in the slot");
    current.update(|view| view.status = SessionStatus::Stopped);
    assert!(!state.is_active());
    assert_eq!(state.live().map(|live| live.status()), Some(SessionStatus::Stopped));
    let next = state.claim().expect("a stopped session does not hold the slot");
    state.commit(next, live(SessionStatus::Running));
    assert!(state.running().is_ok());
}

#[test]
fn the_settings_of_a_start_are_checked_and_cleaned() {
    let mut raw = settings();
    raw.server_name = "  ^1Red \"quoted\";  ".into();
    raw.join_user_ids = vec!["a".into(), "a".into(), " ".into(), "b".into()];
    let clean = validate_settings(Game::JediAcademy, &raw).expect("valid");
    assert_eq!(clean.server_name, "^1Red quoted");
    assert_eq!(clean.join_user_ids, ["a", "b"]);

    // Siege keeps no score limit.
    let mut siege = settings();
    siege.gametype = 7;
    siege.map = "mp/siege_hoth".into();
    assert_eq!(validate_settings(Game::JediAcademy, &siege).unwrap().score_limit, 0);

    // A blank password is no password; a bad one is refused.
    let mut open = settings();
    open.password = Some("   ".into());
    assert_eq!(validate_settings(Game::JediAcademy, &open).unwrap().password, None);
    let mut bad = settings();
    bad.password = Some("two words".into());
    assert!(matches!(validate_settings(Game::JediAcademy, &bad), Err(AppError::InvalidInput(_))));

    for broken in [
        HostSettings { gametype: 5, ..settings() },
        HostSettings { max_players: 1, ..settings() },
        HostSettings { max_players: 17, ..settings() },
        HostSettings { bots: 9, ..settings() },
        HostSettings { map: "../x".into(), ..settings() },
        HostSettings { score_limit: 1000, ..settings() },
    ] {
        assert!(validate_settings(Game::JediAcademy, &broken).is_err(), "{broken:?}");
    }
    // Jedi Outcast numbers its modes differently: 7 is CTF there, 6 Saga.
    assert!(validate_settings(Game::JediOutcast, &HostSettings { gametype: 6, ..settings() }).is_err());
    assert!(validate_settings(Game::JediOutcast, &HostSettings { gametype: 7, ..settings() }).is_ok());
}

fn client(id: &str, can_host: bool) -> HostClientOption {
    HostClientOption {
        id: id.into(),
        name: id.into(),
        engine_id: "openjk".into(),
        can_host,
        reason: (!can_host).then_some(ClientBlock::NoDedicatedServer),
    }
}

#[test]
fn the_form_opens_on_what_fits_the_account_and_the_clients() {
    // Signed out: only the local network, a fresh password, a neutral name.
    let signed_out = Settings {
        online_url: "http://127.0.0.1:8787".into(),
        ..Settings::default()
    };
    let options = options_of(&signed_out, Game::JediAcademy, vec![client("demos", false), client("everyday", true)]);
    assert_eq!(options.relay, RelayAvailability { available: false, reason: Some(RelayBlock::SignedOut) });
    assert_eq!(options.defaults.network, Network::Lan);
    assert_eq!(options.defaults.client_id, "everyday", "the first client that can host");
    assert_eq!(options.defaults.server_name, "JKNet game");
    assert_eq!(options.defaults.map, "mp/ffa3");
    assert_eq!(options.defaults.score_limit, 20);
    let password = options.defaults.password.expect("a password by default");
    assert!(server::validate_password(&password).is_ok());
    assert_eq!(password.len(), server::PASSWORD_LEN);
    assert!(options.show_firewall_note);
    assert_eq!((options.port_from, options.port_to), (29070, 29079));
    assert_eq!(options.gametypes[3].label, "Duel");

    // Signed in, with the last settings of this game remembered.
    let mut signed_in = Settings {
        online_url: "http://127.0.0.1:8787".into(),
        online_token: Some("0123456789abcdef".into()),
        online_user: Some(OnlineUser {
            id: "u1".into(),
            display_name: "Tray".into(),
            provider: "dev".into(),
            provider_name: "tray".into(),
            ..OnlineUser::default()
        }),
        host_firewall_note_seen: true,
        ..Settings::default()
    };
    signed_in.default_client_ids.insert(Game::JediAcademy, "everyday".into());
    let options = options_of(&signed_in, Game::JediAcademy, vec![client("everyday", true)]);
    assert!(options.relay.available);
    assert_eq!(options.defaults.network, Network::InternetLan);
    assert_eq!(options.defaults.server_name, "Tray's game");
    assert!(!options.show_firewall_note);

    signed_in.host_defaults.insert(
        Game::JediAcademy,
        HostDefaults {
            client_id: Some("gone".into()),
            map: Some("mp/duel1".into()),
            gametype: 3,
            max_players: 4,
            score_limit: 5,
            server_name: Some("Duels".into()),
            use_password: false,
            network: "internet".into(),
            join_policy: "selected".into(),
            join_user_ids: vec!["u2".into()],
            ..HostDefaults::default()
        },
    );
    let options = options_of(&signed_in, Game::JediAcademy, vec![client("everyday", true)]);
    let defaults = options.defaults;
    // The remembered client is gone: the default client of the game stands in.
    assert_eq!(defaults.client_id, "everyday");
    assert_eq!((defaults.map.as_str(), defaults.gametype, defaults.max_players), ("mp/duel1", 3, 4));
    assert_eq!(defaults.score_limit, 5);
    assert_eq!(defaults.server_name, "Duels");
    assert_eq!(defaults.password, None);
    assert_eq!(defaults.network, Network::Internet);
    assert_eq!(defaults.join_policy, JoinPolicy::Selected);
    assert_eq!(defaults.join_user_ids, ["u2"]);
    assert!(defaults.invite_user_ids.is_empty());

    // A remembered relay mode on a launcher that signed out falls back.
    signed_in.online_token = None;
    let options = options_of(&signed_in, Game::JediAcademy, vec![client("everyday", true)]);
    assert_eq!(options.defaults.network, Network::Lan);
}

#[test]
fn the_presence_carries_the_relay_only_while_it_is_up_and_the_join_list_only_when_it_decides() {
    let mut view = session(SessionStatus::Running);
    let info = hosting_info(&view, Some("japlus"));
    assert_eq!(info.relay_address.as_deref(), Some("203.0.113.5:29210"));
    assert_eq!(info.lan_addresses, ["192.168.1.23:29070"]);
    assert_eq!(info.players, 1, "bots are not players");
    assert_eq!(info.max_players, 8);
    assert_eq!(info.mod_name.as_deref(), Some("japlus"));
    assert_eq!(info.password.as_deref(), Some("k7m2q9xa"));
    assert_eq!(info.join_policy, "friends");
    assert_eq!(info.join_user_ids, Some(Vec::new()));
    assert_eq!(info.can_join, None, "the service sets it, never the host");

    view.relay.status = RelayStatus::Lost;
    view.settings.join_policy = JoinPolicy::Selected;
    view.settings.join_user_ids = vec!["u2".into()];
    let info = hosting_info(&view, None);
    assert_eq!(info.relay_address, None);
    assert_eq!(info.join_user_ids, Some(vec!["u2".to_string()]));

    let presence = host_presence(&view, None).expect("a running session has a port");
    assert_eq!(presence.local_port, 29070);
    assert_eq!(presence.server_name, "Tray's game");
    view.port = None;
    assert_eq!(host_presence(&view, None), None);

    // The whole object reaches the service in camelCase, `mod` included.
    let json = serde_json::to_value(hosting_info(&session(SessionStatus::Running), None)).unwrap();
    assert_eq!(json["sessionId"], "5e0b7c1f9a2d4c38");
    assert_eq!(json["game"], "ja");
    assert!(json["mod"].is_null());
    assert_eq!(json["maxPlayers"], 8);
    assert_eq!(json["joinPolicy"], "friends");
    assert!(json.get("canJoin").is_none());
}

#[test]
fn no_password_reaches_debug_output() {
    let view = session(SessionStatus::Running);
    let info = hosting_info(&view, None);
    let presence = host_presence(&view, None).expect("a running session is published");
    let invite = crate::online::NewInvite {
        to_user_id: "01J8FRIEND".into(),
        server_address: "203.0.113.5:29210".into(),
        server_name: None,
        message: None,
        hosting: Some(info.clone()),
    };
    // The objects do carry it: the frontend, the service and the engine need it.
    assert_eq!(info.password.as_deref(), Some("k7m2q9xa"));
    for text in [
        format!("{:?}", view.settings),
        format!("{view:?}"),
        format!("{info:?}"),
        format!("{presence:?}"),
        format!("{invite:?}"),
    ] {
        assert!(!text.contains("k7m2q9xa"), "{text}");
        assert!(text.contains("<redacted>"), "{text}");
    }
    let mut open = settings();
    open.password = None;
    assert!(format!("{open:?}").contains("password: None"));
}

#[test]
fn a_refusal_of_the_relay_api_names_its_cause() {
    // The details decide; the words only stand in when there are none.
    let quota = |message: &str, kind: Option<&str>| AppError::RelayQuota {
        message: message.into(),
        quota: kind.map(str::to_string),
        resets_at: None,
    };
    assert_eq!(
        relay_error_of(&quota("You already use the relay for another server", Some("active_session"))).0,
        RelayErrorCode::QuotaActive
    );
    assert_eq!(
        relay_error_of(&quota("Your relay time for today is used up", Some("daily_time"))).0,
        RelayErrorCode::QuotaDaily
    );
    assert_eq!(
        relay_error_of(&quota("time for another server", Some("active_session"))).0,
        RelayErrorCode::QuotaActive
    );
    assert_eq!(
        relay_error_of(&quota("the account already has an active relay session", None)).0,
        RelayErrorCode::QuotaActive
    );
    assert_eq!(
        relay_error_of(&quota("the daily relay time is used up", None)).0,
        RelayErrorCode::QuotaDaily
    );
    assert_eq!(
        relay_error_of(&AppError::RelayUnavailable("off".into())).0,
        RelayErrorCode::Unavailable
    );
    let limited = AppError::Online { code: "rate_limited".into(), message: "slow down".into() };
    assert_eq!(relay_error_of(&limited).0, RelayErrorCode::RateLimited);
    assert_eq!(relay_error_of(&AppError::SignedOut).0, RelayErrorCode::SignedOut);
    assert_eq!(relay_error_of(&AppError::Network("refused".into())).0, RelayErrorCode::Network);
}

#[test]
fn the_session_reaches_the_frontend_in_the_shape_of_ipc_ts() {
    let mut view = session(SessionStatus::Failed);
    view.stop_reason = Some(StopReason::StartFailed);
    view.failure = Some(HostFailure {
        code: FailureCode::PortsBusy,
        message: "no free port between 29070 and 29079".into(),
        port_from: Some(29070),
        port_to: Some(29079),
    });
    view.relay.error_code = Some(RelayErrorCode::NodeSilent);
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["status"], "failed");
    assert_eq!(json["stopReason"], "start_failed");
    assert_eq!(json["failure"]["code"], "ports_busy");
    assert_eq!(json["failure"]["portFrom"], 29070);
    assert_eq!(json["relay"]["errorCode"], "node_silent");
    assert_eq!(json["relay"]["status"], "active");
    assert_eq!(json["steps"][2], serde_json::json!({ "step": "relay", "state": "done" }));
    assert_eq!(json["settings"]["network"], "internet_lan");
    assert_eq!(json["settings"]["joinPolicy"], "friends");
    assert_eq!(json["joinedCount"], 1);
    assert_eq!(json["localAddress"], "127.0.0.1:29070");
    assert_eq!(json["players"][1]["bot"], true);

    // What the frontend sends reads back, the three lists optional.
    let sent: HostSettings = serde_json::from_value(serde_json::json!({
        "clientId": "everyday", "map": "mp/ffa3", "gametype": 0, "maxPlayers": 8,
        "timeLimit": 0, "scoreLimit": 20, "bots": 0, "serverName": "x",
        "password": null, "network": "internet", "joinPolicy": "invite"
    }))
    .expect("the settings of the form parse");
    assert_eq!(sent.network, Network::Internet);
    assert_eq!(sent.join_policy, JoinPolicy::Invite);
    assert!(sent.join_user_ids.is_empty() && !sent.join_after_start);
}
