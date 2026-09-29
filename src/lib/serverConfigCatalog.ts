import type { Game } from "./ipc";

export interface ServerConfigOption {
  value: string;
  label: string;
}

export interface ServerConfigFlag {
  value: number;
  label: string;
}

/** One server cvar that the visual editor can write to a cfg document. */
export interface ServerConfigField {
  name: string;
  label: string;
  description?: string;
  type: "number" | "boolean" | "select" | "flags" | "text";
  defaultValue?: string;
  min?: number;
  max?: number;
  options?: ServerConfigOption[];
  flags?: ServerConfigFlag[];
  group: string;
}

/** A known game module and the cvars that are specific to it. */
export interface ServerConfigCatalogEntry {
  id: string;
  name: string;
  games: Game[];
  /** Conventional `fs_game` directory names. They are candidates, not detection rules. */
  modFolders: string[];
  version?: string;
  sourceUrl?: string;
  fields: ServerConfigField[];
}

export interface ServerConfigFieldSections {
  common: ServerConfigField[];
  mod: ServerConfigField[];
}

const JA_GAME_TYPES: ServerConfigOption[] = [
  { value: "0", label: "Free for all" },
  { value: "1", label: "Holocron" },
  { value: "2", label: "Jedi Master" },
  { value: "3", label: "Duel" },
  { value: "4", label: "Power Duel" },
  { value: "6", label: "Team free for all" },
  { value: "7", label: "Siege" },
  { value: "8", label: "Capture the Flag" },
  { value: "9", label: "Capture the Ysalamiri" },
];

/** Private-host modes supplied by JK2MV, not the full single-player enum. */
const JO_GAME_TYPES: ServerConfigOption[] = [
  { value: "0", label: "Free for all" },
  { value: "1", label: "Holocron" },
  { value: "2", label: "Jedi Master" },
  { value: "3", label: "Duel" },
  { value: "5", label: "Team free for all" },
  { value: "7", label: "Capture the Flag" },
  { value: "8", label: "Capture the Ysalamiri" },
];

const FORCE_POWERS: ServerConfigFlag[] = [
  { value: 1, label: "Heal" },
  { value: 2, label: "Jump" },
  { value: 4, label: "Speed" },
  { value: 8, label: "Push" },
  { value: 16, label: "Pull" },
  { value: 32, label: "Mind Trick" },
  { value: 64, label: "Grip" },
  { value: 128, label: "Lightning" },
  { value: 256, label: "Rage" },
  { value: 512, label: "Protect" },
  { value: 1024, label: "Absorb" },
  { value: 2048, label: "Team Heal" },
  { value: 4096, label: "Team Energize" },
  { value: 8192, label: "Drain" },
  { value: 16384, label: "See" },
  { value: 32768, label: "Saber offense" },
  { value: 65536, label: "Saber defense" },
  { value: 131072, label: "Saber throw" },
];

function baseHostFields(gameTypes: ServerConfigOption[]): ServerConfigField[] {
  return [
    {
      name: "map",
      label: "Starting map",
      description: "Map command run when the server starts.",
      type: "text",
      group: "Server",
    },
    {
      name: "sv_hostname",
      label: "Server name",
      description: "Name shown in the server browser.",
      type: "text",
      group: "Server",
    },
    {
      name: "sv_maxclients",
      label: "Maximum clients",
      description: "Players and spectators share these client slots. JKNet private hosting accepts 2–16.",
      type: "number",
      defaultValue: "8",
      min: 2,
      max: 16,
      group: "Server",
    },
    {
      name: "g_gametype",
      label: "Game type",
      type: "select",
      defaultValue: "0",
      options: gameTypes,
      group: "Game rules",
    },
    {
      name: "timelimit",
      label: "Time limit",
      description: "Minutes. Zero disables the limit.",
      type: "number",
      defaultValue: "0",
      min: 0,
      max: 999,
      group: "Limits",
    },
    {
      name: "fraglimit",
      label: "Frag limit",
      type: "number",
      defaultValue: "20",
      min: 0,
      max: 999,
      group: "Limits",
    },
    {
      name: "duel_fraglimit",
      label: "Duel win limit",
      type: "number",
      defaultValue: "10",
      min: 0,
      max: 999,
      group: "Limits",
    },
    {
      name: "capturelimit",
      label: "Capture limit",
      type: "number",
      defaultValue: "8",
      min: 0,
      max: 999,
      group: "Limits",
    },
    {
      name: "bot_minplayers",
      label: "Minimum players with bots",
      description: "Bots use normal client slots. Zero disables automatic bots.",
      type: "number",
      defaultValue: "0",
      min: 0,
      max: 16,
      group: "Bots",
    },
  ];
}

const BASE_JA_FIELDS: ServerConfigField[] = [
  ...baseHostFields(JA_GAME_TYPES),
  {
    name: "g_friendlyFire",
    label: "Friendly fire",
    type: "boolean",
    defaultValue: "0",
    group: "Game rules",
  },
  {
    name: "g_saberLocking",
    label: "Saber locks",
    type: "boolean",
    defaultValue: "1",
    group: "Combat",
  },
  {
    name: "g_maxForceRank",
    label: "Maximum Force rank",
    type: "select",
    defaultValue: "7",
    options: [
      { value: "0", label: "Uninitiated" },
      { value: "1", label: "Initiate" },
      { value: "2", label: "Padawan" },
      { value: "3", label: "Jedi" },
      { value: "4", label: "Jedi Guardian" },
      { value: "5", label: "Jedi Adept" },
      { value: "6", label: "Jedi Knight" },
      { value: "7", label: "Jedi Master" },
    ],
    group: "Force",
  },
  {
    name: "g_forcePowerDisable",
    label: "Disabled Force powers",
    type: "flags",
    defaultValue: "0",
    flags: FORCE_POWERS,
    group: "Force",
  },
];

const BASE_JO_FIELDS: ServerConfigField[] = baseHostFields(JO_GAME_TYPES);

export const MOD_CATALOG: ServerConfigCatalogEntry[] = [
  {
    id: "base",
    name: "Base",
    games: ["ja", "jo"],
    modFolders: [],
    sourceUrl: "https://github.com/JACoders/OpenJK/blob/master/codemp/game/g_xcvar.h",
    fields: BASE_JA_FIELDS,
  },
  {
    id: "japlus",
    name: "JA+",
    games: ["ja"],
    modFolders: ["japlus"],
    version: "2.4 Build 7",
    sourceUrl: "https://jkhub.org/tutorials/specific-mods/japlus/ja-command-list-r218/",
    fields: [
      {
        name: "jp_allowHook",
        label: "Grappling hook",
        type: "select",
        options: [
          { value: "0", label: "Disabled" },
          { value: "1", label: "All players" },
          { value: "2", label: "Mercenaries only in Jedi vs Merc" },
        ],
        group: "Items",
      },
      {
        name: "jp_hookFloodProtect",
        label: "Hook cooldown",
        description: "Milliseconds between hook shots.",
        type: "number",
        defaultValue: "750",
        group: "Items",
      },
      {
        name: "jp_hookSpeed",
        label: "Hook speed",
        type: "number",
        defaultValue: "800",
        group: "Items",
      },
      {
        name: "jp_newGLAAnims",
        label: "JA+ animations",
        type: "select",
        defaultValue: "1",
        options: [
          { value: "0", label: "Disabled" },
          { value: "1", label: "Enabled" },
          { value: "2", label: "Require all players to have the plugin" },
        ],
        group: "Movement",
      },
      {
        name: "jp_allowSPForces",
        label: "Single-player Force moves",
        type: "select",
        defaultValue: "2",
        options: [
          { value: "0", label: "Disabled" },
          { value: "1", label: "Except Sith kiss" },
          { value: "2", label: "All moves" },
        ],
        group: "Force",
      },
      {
        name: "jp_allowTeamDuel",
        label: "Private duels in team modes",
        type: "boolean",
        defaultValue: "1",
        group: "Duels",
      },
      {
        name: "jp_duelStartArmor",
        label: "Duel starting armor",
        type: "number",
        defaultValue: "100",
        min: 0,
        max: 100,
        group: "Duels",
      },
      {
        name: "jp_DuelAlpha",
        label: "Duel isolation visibility",
        description: "-1 disables isolation; 0–255 sets dueller visibility.",
        type: "number",
        defaultValue: "100",
        min: -1,
        max: 255,
        group: "Duels",
      },
      {
        name: "jp_votesDisable",
        label: "Disabled vote types",
        description: "Takes effect only while g_allowVote permits voting.",
        type: "flags",
        defaultValue: "0",
        flags: [
          { value: 2, label: "Map restart" },
          { value: 4, label: "Next map" },
          { value: 8, label: "Map" },
          { value: 16, label: "Game type" },
          { value: 32, label: "Kick" },
          { value: 64, label: "Warmup" },
          { value: 128, label: "Time limit" },
          { value: 256, label: "Frag limit" },
          { value: 512, label: "Sleep" },
          { value: 1024, label: "Admin poll" },
          { value: 2048, label: "Silence" },
        ],
        group: "Voting",
      },
      {
        name: "jp_onlyVotingClients",
        label: "Count only voting clients",
        type: "boolean",
        defaultValue: "1",
        group: "Voting",
      },
      {
        name: "jp_voteTimer",
        label: "Vote cooldown",
        description: "Minutes. Zero disables the cooldown.",
        type: "number",
        defaultValue: "10",
        group: "Voting",
      },
      {
        name: "jp_startMapVoteTimer",
        label: "Initial map-vote delay",
        description: "Seconds. Zero disables the delay.",
        type: "number",
        defaultValue: "60",
        group: "Voting",
      },
      {
        name: "jp_teamLock",
        label: "Locked teams",
        type: "flags",
        defaultValue: "0",
        flags: [
          { value: 2, label: "Spectator" },
          { value: 4, label: "Free for all" },
          { value: 8, label: "Blue" },
          { value: 16, label: "Red" },
        ],
        group: "Teams",
      },
      {
        name: "jp_allowTeamKill",
        label: "Allow /kill in team modes",
        type: "boolean",
        defaultValue: "0",
        group: "Teams",
      },
      {
        name: "jp_siegeItemTime",
        label: "Siege objective time",
        description: "Minutes before a carried objective returns. Zero disables it.",
        type: "number",
        defaultValue: "3",
        group: "Teams",
      },
    ],
  },
  {
    id: "japro",
    name: "JAPro",
    games: ["ja"],
    modFolders: ["japro"],
    sourceUrl: "https://github.com/eternalcodes/EternalJK/blob/master/japro_docs.md",
    fields: [
      {
        name: "g_raceMode",
        label: "Race mode",
        type: "select",
        defaultValue: "0",
        options: [
          { value: "0", label: "Disabled" },
          { value: "1", label: "Forced" },
          { value: "2", label: "Players can toggle it" },
        ],
        group: "Race",
      },
      {
        name: "g_allowRaceTele",
        label: "Race teleport permissions",
        type: "select",
        defaultValue: "0",
        options: [
          { value: "0", label: "Disabled" },
          { value: "1", label: "Allow amtele" },
          { value: "2", label: "Allow amtele and noclip" },
        ],
        group: "Race",
      },
      {
        name: "g_movementStyle",
        label: "Movement style",
        type: "select",
        defaultValue: "1",
        options: [
          { value: "0", label: "Siege" },
          { value: "1", label: "Jedi Academy" },
          { value: "2", label: "QuakeWorld" },
          { value: "3", label: "CPM" },
          { value: "4", label: "Quake III" },
          { value: "5", label: "PJK" },
          { value: "6", label: "Warsow" },
        ],
        group: "Movement",
      },
      {
        name: "g_unlagged",
        label: "Unlagged calculations",
        type: "flags",
        defaultValue: "0",
        flags: [
          { value: 1, label: "Projectiles" },
          { value: 2, label: "Hitscan weapons" },
          { value: 4, label: "Push and pull" },
        ],
        group: "Network",
      },
      {
        name: "g_fixGroundStab",
        label: "Ground-stab behaviour",
        type: "select",
        defaultValue: "0",
        options: [
          { value: "0", label: "Base game" },
          { value: "1", label: "Damage grounded players" },
          { value: "2", label: "Damage grounded players less" },
        ],
        group: "Combat",
      },
      {
        name: "g_allowGrapple",
        label: "Grappling hook",
        type: "select",
        defaultValue: "0",
        options: [
          { value: "0", label: "Disabled" },
          { value: "1", label: "Tarzan style" },
          { value: "2", label: "JA+ style" },
        ],
        group: "Movement",
      },
      {
        name: "g_hookSpeed",
        label: "Hook speed",
        type: "number",
        defaultValue: "2400",
        group: "Movement",
      },
      {
        name: "g_hookStrength",
        label: "Hook pull speed",
        type: "number",
        defaultValue: "800",
        group: "Movement",
      },
      {
        name: "g_hookFloodProtect",
        label: "Hook cooldown",
        description: "Milliseconds between hook shots.",
        type: "number",
        defaultValue: "600",
        group: "Movement",
      },
      {
        name: "g_showHealth",
        label: "Show health bars",
        description: "Requires a map restart.",
        type: "boolean",
        defaultValue: "0",
        group: "Display",
      },
      {
        name: "g_eloRanking",
        label: "Duel Elo ranking",
        type: "boolean",
        defaultValue: "0",
        group: "Duels",
      },
      {
        name: "bot_maxbots",
        label: "Maximum bots",
        description: "Bots occupy regular client slots.",
        type: "number",
        defaultValue: "0",
        group: "Bots",
      },
    ],
  },
  {
    id: "mbii",
    name: "Movie Battles II",
    games: ["ja"],
    modFolders: ["MBII"],
    sourceUrl: "https://servers.moviebattles.org/api",
    fields: [
      {
        name: "g_gametype",
        label: "Game type",
        description: "Movie Battles uses 7. Duel and Power Duel use the base game values.",
        type: "select",
        defaultValue: "7",
        options: [
          { value: "7", label: "Movie Battles" },
          { value: "3", label: "Duel" },
          { value: "4", label: "Power Duel" },
        ],
        group: "Game rules",
      },
      {
        name: "fraglimit",
        label: "Match win limit",
        type: "number",
        group: "Limits",
      },
      {
        name: "g_authenticity",
        label: "Movie Battles mode",
        type: "select",
        options: [
          { value: "0", label: "Open" },
          { value: "1", label: "Semi-authentic" },
          { value: "2", label: "Full-authentic" },
          { value: "3", label: "Duel" },
          { value: "4", label: "Legends" },
        ],
        group: "Game rules",
      },
      {
        name: "g_competitive",
        label: "Competitive settings",
        type: "number",
        group: "Game rules",
      },
      {
        name: "g_anticheat",
        label: "Anti-cheat",
        type: "boolean",
        group: "Security",
      },
      {
        name: "g_duelfriendlyteam",
        label: "Friendly duel team",
        type: "boolean",
        group: "Duels",
      },
      {
        name: "g_dueltimelimit",
        label: "Duel time limit",
        type: "number",
        group: "Duels",
      },
      {
        name: "g_hidehudfromspecs",
        label: "Hide HUD from spectators",
        type: "boolean",
        group: "Spectators",
      },
      {
        name: "g_shuffletimer",
        label: "Team shuffle timer",
        type: "number",
        group: "Teams",
      },
      {
        name: "g_spin",
        label: "Spin event",
        type: "boolean",
        group: "Events",
      },
      {
        name: "g_teamswap",
        label: "Team swap",
        type: "boolean",
        group: "Teams",
      },
      {
        name: "tk_spec",
        label: "Team-kill points to spectator",
        type: "number",
        group: "Moderation",
      },
      {
        name: "tk_kick",
        label: "Team-kill points to kick",
        type: "number",
        group: "Moderation",
      },
      {
        name: "rtvrtm",
        label: "Rock the Vote / Rock the Mode",
        type: "text",
        group: "Voting",
      },
    ],
  },
  {
    id: "lugormod",
    name: "Lugormod",
    games: ["ja"],
    modFolders: ["lugormod"],
    sourceUrl: "https://github.com/NexiloDev/Lugormod-v3",
    fields: [
      {
        name: "g_gameMode",
        label: "Lugormod game mode",
        description: "0 normal; 1–6 choose a mode. Add 8, 16, 32, 64, or 128 for documented modifiers.",
        type: "number",
        defaultValue: "0",
        group: "Game rules",
      },
      {
        name: "g_privateDuel",
        label: "Private duel rules",
        type: "flags",
        defaultValue: "289",
        flags: [
          { value: 1, label: "Enable private duels" },
          { value: 2, label: "Allow multiple duels" },
          { value: 4, label: "Full health at start" },
          { value: 8, label: "Full armor at start" },
          { value: 16, label: "Full Force at start" },
          { value: 32, label: "Restore health after duel" },
          { value: 64, label: "Restore armor after duel" },
          { value: 128, label: "Restore Force after duel" },
          { value: 256, label: "Force saber on at start" },
          { value: 512, label: "Force bow at start" },
          { value: 2048, label: "Score frags only in duels in FFA" },
          { value: 4096, label: "Disable severing in duels" },
        ],
        group: "Duels",
      },
      {
        name: "g_grapplingHook",
        label: "Grappling hook",
        type: "select",
        defaultValue: "0",
        options: [
          { value: "0", label: "Disabled" },
          { value: "1", label: "Stun baton alternate fire" },
          { value: "2", label: "Always fire the hook" },
        ],
        group: "Items",
      },
      {
        name: "g_disableSpec",
        label: "Spectator restrictions",
        type: "flags",
        defaultValue: "0",
        flags: [
          { value: 1, label: "Prevent movement" },
          { value: 4, label: "Prevent following players" },
        ],
        group: "Spectators",
      },
      {
        name: "lmd_startingCr",
        label: "Starting credits",
        type: "number",
        defaultValue: "0",
        group: "Economy",
      },
      {
        name: "lmd_stashRate",
        label: "Stash spawn check interval",
        description: "Milliseconds. A check does not guarantee a stash spawn.",
        type: "number",
        defaultValue: "60000",
        group: "Economy",
      },
      {
        name: "lmd_stashCr",
        label: "Default stash credits",
        type: "number",
        defaultValue: "10",
        group: "Economy",
      },
      {
        name: "lmd_chatDisable",
        label: "Disabled chat modes",
        type: "flags",
        defaultValue: "0",
        flags: [
          { value: 1, label: "Normal" },
          { value: 2, label: "Team" },
          { value: 4, label: "Tell" },
          { value: 8, label: "Admin" },
          { value: 16, label: "Close" },
          { value: 32, label: "Buddies" },
          { value: 64, label: "Friends" },
        ],
        group: "Chat",
      },
      {
        name: "lmd_vehcloaking",
        label: "Cloak in vehicles",
        type: "boolean",
        defaultValue: "0",
        group: "Items",
      },
      {
        name: "lmd_loginSecurity",
        label: "Account login security",
        type: "select",
        defaultValue: "2",
        options: [
          { value: "0", label: "Optional security code" },
          { value: "1", label: "Require code from a new IP" },
          { value: "2", label: "Require code for administrators only" },
        ],
        group: "Accounts",
      },
      {
        name: "lmd_enableCorpseDrag",
        label: "Drag corpses",
        description: "Experimental.",
        type: "boolean",
        defaultValue: "0",
        group: "Game rules",
      },
      {
        name: "lmd_rewardcr_kill",
        label: "Credits for player kills",
        type: "boolean",
        defaultValue: "0",
        group: "Economy",
      },
    ],
  },
  {
    id: "makermod",
    name: "MakerMod",
    games: ["ja"],
    modFolders: ["makermod"],
    sourceUrl: "https://github.com/xScooper/Makermod",
    fields: [
      {
        name: "g_allowMapVote",
        label: "Map voting",
        type: "boolean",
        defaultValue: "1",
        group: "Voting",
      },
      {
        name: "g_forbiddenNPCs",
        label: "Forbidden NPC types",
        description: "Space-separated NPC type names.",
        type: "text",
        defaultValue: "ragnos saber_droid rosh rosh_dark eopie saber_droid_training",
        group: "Building",
      },
      {
        name: "g_forbiddenVehicles",
        label: "Forbidden vehicle types",
        description: "Space-separated vehicle type names.",
        type: "text",
        defaultValue: "stap ar_deceptor droideka gunshipx n2 maulspeeder eopie hailfire_droid k1-enforcer swoop_bike1 swoop_bike3 swoop_bike5 yt-1300 mrjay-assassin eopie_wild",
        group: "Building",
      },
      {
        name: "g_objectMargin",
        label: "Object margin",
        type: "number",
        defaultValue: "64",
        group: "Building",
      },
      {
        name: "g_npcLimit",
        label: "NPC limit",
        type: "number",
        defaultValue: "100",
        group: "Building",
      },
      {
        name: "g_antiNPCCrash",
        label: "NPC crash protection",
        type: "boolean",
        defaultValue: "1",
        group: "Building",
      },
      {
        name: "g_teleDelay",
        label: "Teleport delay",
        description: "Milliseconds.",
        type: "number",
        defaultValue: "1000",
        group: "Building",
      },
      {
        name: "g_serverMessages",
        label: "Server messages",
        type: "boolean",
        defaultValue: "1",
        group: "Chat",
      },
      {
        name: "g_ServerName",
        label: "Server chat name",
        type: "text",
        defaultValue: "^7Server:",
        group: "Chat",
      },
      {
        name: "g_antiChatFlood",
        label: "Chat flood protection",
        type: "boolean",
        defaultValue: "1",
        group: "Security",
      },
      {
        name: "g_antiUserinfoFlood",
        label: "Userinfo flood protection",
        type: "boolean",
        defaultValue: "1",
        group: "Security",
      },
      {
        name: "g_maxClientsfromIP",
        label: "Maximum clients per IP",
        type: "number",
        defaultValue: "3",
        group: "Security",
      },
      {
        name: "g_JoinMOTD",
        label: "Join message",
        type: "text",
        defaultValue: "Welcome\\nPlease type /minfo in the console for help",
        group: "Chat",
      },
    ],
  },
];

/**
 * Returns the base Jedi Academy fields and the selected module's fields.
 *
 * A module can replace a base cvar, as Movie Battles II does for
 * `g_gametype`. Unknown modules deliberately get only the safe base set.
 */
export function serverConfigFieldSections(
  game: Game,
  modId?: string | null,
): ServerConfigFieldSections {
  const base = MOD_CATALOG.find((entry) => entry.id === "base");
  const selected = MOD_CATALOG.find((entry) => entry.id === modId);
  const excludedBaseFields = selected?.id === "mbii"
    ? new Set(["bot_minplayers", "duel_fraglimit", "capturelimit"])
    : new Set<string>();
  const baseFields = game === "ja" ? BASE_JA_FIELDS : game === "jo" ? BASE_JO_FIELDS : [];
  const mod = selected && selected.id !== "base" && selected.games.includes(game)
    ? selected.fields
    : [];
  const modNames = new Set(mod.map((field) => field.name.toLowerCase()));
  const common = base?.games.includes(game)
    ? baseFields.filter((field) => !excludedBaseFields.has(field.name) && !modNames.has(field.name.toLowerCase()))
    : [];
  return { common, mod };
}

export function serverConfigFields(
  game: Game,
  modId?: string | null,
): ServerConfigField[] {
  const sections = serverConfigFieldSections(game, modId);
  return [...sections.common, ...sections.mod];
}
