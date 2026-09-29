/**
 * The release order and the translation keys shown on the Changelog screen.
 *
 * Copy belongs to stable keys in the locale catalogs. A key does not move
 * when its change leaves the unreleased section: publishing a version only
 * moves the key between the arrays below. Keeping version metadata here makes
 * a release one small, reviewable edit and lets tests reject duplicate or
 * out-of-order entries before the page reaches a build.
 */
export const CHANGELOG_RELEASES = [
  {
    key: "unreleased",
    version: null,
    date: null,
    items: [],
  },
  {
    key: "v0_10_0",
    version: "0.10.0",
    date: "2026-09-30",
    items: [
      "entries.v0_10_0_webApp",
      "entries.v0_10_0_signIn",
      "entries.v0_10_0_attachments",
      "entries.v0_10_0_featuredMods",
      "entries.v0_10_0_fixes",
    ],
  },
  {
    key: "v0_9_0",
    version: "0.9.0",
    date: "2026-09-29",
    items: [
      "entries.clientImport",
      "entries.profileImport",
      "entries.changelog",
    ],
  },
  {
    key: "v0_8_0",
    version: "0.8.0",
    date: "2026-09-29",
    items: [
      "entries.v0_8_0_portableClients",
      "entries.v0_8_0_dedicatedServers",
      "entries.v0_8_0_serverTools",
      "entries.v0_8_0_compatibility",
      "entries.v0_8_0_friendPresence",
    ],
  },
  {
    key: "v0_7_1",
    version: "0.7.1",
    date: "2026-09-27",
    items: ["entries.v0_7_1_chatSending"],
  },
  {
    key: "v0_7_0",
    version: "0.7.0",
    date: "2026-09-26",
    items: [
      "entries.v0_7_0_conversations",
      "entries.v0_7_0_windows",
      "entries.v0_7_0_messages",
      "entries.v0_7_0_sharing",
      "entries.v0_7_0_notifications",
    ],
  },
  {
    key: "v0_6_0",
    version: "0.6.0",
    date: "2026-09-25",
    items: [
      "entries.v0_6_0_hosting",
      "entries.v0_6_0_network",
      "entries.v0_6_0_invites",
      "entries.v0_6_0_status",
    ],
  },
  {
    key: "v0_5_0",
    version: "0.5.0",
    date: "2026-09-24",
    items: [
      "entries.v0_5_0_bundles",
      "entries.v0_5_0_catalog",
      "entries.v0_5_0_editor",
      "entries.v0_5_0_preview",
      "entries.v0_5_0_management",
    ],
  },
  {
    key: "v0_4_0",
    version: "0.4.0",
    date: "2026-09-13",
    items: [
      "entries.v0_4_0_architecture",
      "entries.v0_4_0_communities",
      "entries.v0_4_0_installAll",
      "entries.v0_4_0_maps",
    ],
  },
  {
    key: "v0_3_0",
    version: "0.3.0",
    date: "2026-09-13",
    items: [
      "entries.v0_3_0_languages",
      "entries.v0_3_0_jediOutcast",
      "entries.v0_3_0_library",
      "entries.v0_3_0_previews",
      "entries.v0_3_0_playerTools",
      "entries.v0_3_0_serverBrowser",
    ],
  },
  {
    key: "v0_2_0",
    version: "0.2.0",
    date: "2026-09-10",
    items: [
      "entries.v0_2_0_players",
      "entries.v0_2_0_filters",
      "entries.v0_2_0_levelshots",
      "entries.v0_2_0_refresh",
    ],
  },
  {
    key: "v0_1_1",
    version: "0.1.1",
    date: "2026-09-10",
    items: ["entries.v0_1_1_updaterTest"],
  },
  {
    key: "v0_1_0",
    version: "0.1.0",
    date: "2026-09-10",
    items: [
      "entries.v0_1_0_setup",
      "entries.v0_1_0_clients",
      "entries.v0_1_0_servers",
      "entries.v0_1_0_library",
      "entries.v0_1_0_updates",
    ],
  },
] as const;

export const LATEST_CHANGELOG_RELEASE = CHANGELOG_RELEASES[1];
