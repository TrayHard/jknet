# Notes for translators

Context for the keys where the English text alone is not enough: where the
string appears, how much room it has and what a placeholder holds. Everything
not listed here is an ordinary sentence with no trap in it.

This file is English on purpose: it is read by whoever translates *into* a
language, and English is the source language of the project. The rules of the
architecture — how to add a language, what the check script demands — are in
[docs/i18n.md](../../../docs/i18n.md), in Russian.

## Rules that hold for every key

- **Placeholders travel.** `{{name}}` has to appear in the translation exactly
  as it appears in English, spelled the same way. The check script refuses a
  message that loses one or invents one. Their order may change freely: that is
  the whole point of naming them.
- **Plurals are not two forms.** A key with `_one` and `_other` in English gets
  the forms your language actually uses — `_one`, `_few`, `_many`, `_other` in
  Russian, Ukrainian and Polish; `_one`, `_many`, `_other` in French and
  Spanish; two in German and Hungarian. `npm run i18n:seed <lang>` writes the
  right set for you.
- **Names are not translated.** JKNet, JKNet Online, JKHub, Discord, Steam,
  GOG, GitHub, Jedi Academy, Jedi Outcast, OpenJK, EternalJK, TaystJK, jaMME,
  JK2MV. Neither are `pk3`, `fs_game`, `GameData`, `base` or a cvar name.
- **Screen names inside a sentence** — «Open the Clients screen», «from
  Settings» — name the item in the sidebar. Translate the sentence and keep the
  screen name as the sidebar prints it in your language: those come from
  `nav.json`, so translate `nav.json` first.
- **Server data is never translated.** A server name, a map name, a mod folder
  and a JKHub file title are what somebody typed; the launcher prints them as
  they are.
- **`<0>` and `<1>` are markup, not text.** They wrap a piece of the sentence in
  a link or in a monospaced span. Keep the pair around the same words the
  English one wraps, and keep them in order.

## Length

The window is 1280×800 and never narrower than 1100×700. Three places have less
room than the English text suggests:

| Where | Key | Room |
| --- | --- | --- |
| Sidebar navigation | `nav:items.*` | about 160 px, one line, truncated with an ellipsis |
| Game switcher | `nav:gameSwitch.label` and the game names | half of 232 px each; the names come from the core and are not translated |
| Server table headings | `servers:columns.*` | 56–116 px, uppercase, no wrapping |
| Mode badges | `games:gametypesShort.*` | 60 px, uppercase; keep them to 5–6 characters |
| Filter labels | `servers:filters.mode/mod/players/version` | a word each, in a row that has to fit on one line |

Everything else wraps.

## Keys worth a note

| Key | Note |
| --- | --- |
| `common:units.*` | The number arrives already formatted for the language in `{{value}}`. Translate only the unit and keep the space before it. |
| `common:values.empty` | An em dash standing in for a number that is not there. Leave it as it is. |
| `servers:subtitle.*` | Parts of one line, joined with « · ». Each is a whole clause; none of them may end in a full stop. |
| `servers:columns.players` | Abbreviation of «players» — the column is 76 px. |
| `servers:details.botBadge` | A badge on one player's row, at most four characters. |
| `servers:empty.filteredBots` | `{{count}}` is the number of servers hidden by the bot switch. The sentence names the switch, which is `servers:filters.hideBotOnly` — use the same wording. |
| `clients:card.meta` | `{{id}}` is a folder name, `{{date}}` is already formatted. Both are monospaced; keep the « · » between them. |
| `clients:settingsDialog.modFolderHint` | Five monospaced spans: `+set fs_game`, `_`, `-`, `+` and the folder name. Do not translate what is inside them. |
| `library:subtitleClient` | One line under the screen title, joined with « · ». It is truncated on a narrow window, so put the client name first. |
| `library:categories.*` vs `library:categoryOne.*` | The first is the plural in the category rail, the second the singular on a card badge. Some languages need different words. |
| `jkhub:details.ratingValue` | `{{value}}` is a rating out of five, already formatted; `{{count}}` is the number of reviews. |
| `friends:status.lastSeen*` | `{{count}}` is minutes, hours or days. The three keys exist so each unit can take its own plural. |
| `friends:requests.handle` | `jkhub:kyle_k`. Do not translate; it is an identifier. |
| `onboarding:client.nameDefault` | The name suggested for a player's first client. Pick a short, ordinary word — it becomes a folder name after transliteration. |
| `onboarding:gameFiles.text` | Contains `base\assets0.pk3`, a path. Keep the backslash. |
| `errors:*` | Printed when a command fails. `{{reason}}` and `{{context}}` hold text written by the operating system or by a library and stay in English; the sentence around them is yours. |
| `errors:io`, `errors:json` | Two placeholders and no words: the core already writes a whole sentence there. Leave the shape alone. |
| `errors:engineFile` | `{{file}}` is a path inside the client, `base/assetsmv.pk3`. Do not translate it and keep the slash. |
| `errors:basepathOccupied` | `{{path}}` is a full Windows path ending in `basepath\base`. Do not translate it; the sentence has to read well with a long path in the middle of it. |
| `account:providers.dev` | Used inside a sentence («signed in with …»), so it is lowercase. `account:providers.devLabel` is the same thing as a badge and is capitalised. |
| `settings:language.systemWith` | `{{language}}` is the native name of the language the system would pick — «Русский», «Deutsch». It is never translated. |
| `settings:language.draft` | Shown under the **Language** card while `_status.json` names no reviewer. It describes the folder you are translating, so write it in that language even before the rest is checked. |

## How to check your work

From the repository root:

```
npm run i18n:seed <lang>
npm run i18n:check
```

The first writes any key you are missing with the English text in it; the second
fails on a missing key, an empty value, a lost placeholder or a plural form your
language does not use.

## When you are done

Six of the eight folders are machine drafts: every key is filled and nobody has
read them. Their `_status.json` says so with `"reviewer": null`, and that is
what puts the warning under the **Language** card.

If you are a native speaker and you have read the whole folder, put your name in
`reviewer` and set `date` to the day you finished. The warning goes away with
it. Leave `reviewer` as `null` if you only fixed a few strings — a folder claims
to be checked once, and it should be true.
