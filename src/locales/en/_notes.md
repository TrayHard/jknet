# Notes for translators

Context for the keys where the English text alone is not enough: where the
string appears, how much room it has and what a placeholder holds. Everything
not listed here is an ordinary sentence with no trap in it.

This file is English on purpose: it is read by whoever translates *into* a
language, and English is the source language of the project. The rules of the
architecture — how to add a language, what the check script demands — are in
the localization notes kept outside the repository.

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
  English one wraps, and keep them in order. The check script compares the set
  of tags between your folder and English, so a lost or invented tag fails the
  build.
- **One register through the whole folder.** English «you» is neutral: it is
  neither a friend nor a form. Pick the register your language uses for a tool
  the player runs on their own machine — the polite plural in Russian and
  Ukrainian, `Sie` in German, `vous` in French, `usted` in Spanish, `Ön` in
  Hungarian, the impersonal or the plain imperative in Polish — and hold it in
  every file. Mixing registers within one folder reads as sloppiness even when
  each sentence is right on its own.

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
| `common:actions.delete`, `disable`, `remove` | Three different actions, and they need three different words. `delete` destroys the thing, `disable` switches it off and leaves it in place, `remove` detaches it without destroying it — the button that ends a friendship is `remove`, not `delete`. `common:states.deleting` and `common:states.removing` follow the verb you picked for each. |
| `common:actions.seeAll` | A general «show the whole list», reused by any screen that shortens one. Do not name what is being listed — the screen that needs a specific label has its own key, as `home:topServers.seeAll` does. |
| `common:actions.apply` | The button of a small dialog that puts a typed value in place — the address of a link or a video in the description editor — and closes. One word; it is not `save`, nothing is written to disk by it alone. |
| `home:hero.continueText` | Names two buttons of the same block: use the exact wording you gave `home:hero.connect` and `home:hero.play`, or the sentence describes buttons the player cannot find. `{{client}}` is a name the player typed. |
| `home:hero.lastServer` | The caption over a map picture, under 20 characters. It says what the picture is, so it is a label, not a sentence. |
| `home:hero.otherClients`, `newClient` | A button of the hero and the last line of the menu it opens. Both end in the ellipsis the launcher puts on a control that opens something instead of acting — keep it, and keep it as one character, «…». The button stands beside **Play** in a row that never wraps to a second line: two words at most. |
| `home:hero.launch` | The mark at the right end of a client's line in that menu: pressing the line starts that client. One word, and the same one you gave `clients:engine.launch` — it is the same action on the same client. |
| `home:topServers.favorites`, `history` | Headings of two blocks of server rows on **Home**. They name the same two things as the tabs `servers:tabs.favorites` and `servers:tabs.history` — use the same words. |
| `servers:subtitle.*` | Parts of one line, joined with « · ». Each is a whole clause; none of them may end in a full stop. |
| `servers:columns.players` | Abbreviation of «players» — the column is 76 px. |
| `servers:details.botBadge` | A badge on one player's row, at most four characters. |
| `servers:empty.filteredBots` | `{{count}}` is the number of servers hidden by the bot switch. The sentence names the switch, which is `servers:filters.hideBotOnly` — use the same wording. |
| `clients:card.created`, `clients:card.modFolder` | Two of the parts of the second line of a client card, joined with « · » by the code. Each is a fragment, not a sentence: no capital at the start and no full stop at the end. `{{date}}` is already formatted for the language and `{{mod}}` is a folder name; `fs_game` is an identifier and stays. |
| `clients:removeDialog.*` | The question in front of **Delete** on a client card. The folder of the client is deleted for good, so the body has to say so plainly; do not soften it. `{{client}}` is a name the player typed and `{{engine}}` a project name. Use the same verb here as in `common:actions.delete`. |
| `clients:card.openFolder` | Shows the folder of the client in the file manager. The button is narrow: two words at most. |
| `clients:card.delete`, `clients:card.openFolder`, `clients:engine.checkUpdates`, `clients:engine.install`, `clients:engine.updateTo` | The four buttons of one row at the bottom of a client card, and the row never wraps to a second line. Keep each label as short as the English one; a long label pushes the row past the width of the card. |
| `clients:clientWindow.client.default*`, `makeDefault`, `isDefault` | The row that decides which client the **Play** button of a game starts. Name the button the same way in both places it is mentioned, and keep «Play» as `home:hero.play` prints it in your language. `{{game}}` is Jedi Academy or Jedi Outcast and is never translated. |
| `clients:enginePage.facts.*` | Sentences read from each project’s own README. Project names, cvar names (`s_initsound`), file names (`jamp.exe`) and mod folder names (`base`, `ja+`, `mme`) are identifiers and stay as they are; the words around them are yours. |
| `clients:enginePage.factsExecutable`, `factsModFolder` | `{{file}}` is the name of an executable and `{{folder}}` the name of a folder on disk. Neither is translated. |
| `clients:enginePage.versionsText` | Says where a build is installed from, which is a client and not this page. Do not promise a button the page does not have. |
| `clients:newDialog.details` | A link under an engine tile, one or two words, opening the page about that build. |
| `clients:clientWindow.*` | The separate window behind the gear on a client card. Every label in it ends with a cvar name in brackets — `r_mode`, `s_volume`, `com_maxfps` — and those are identifiers: keep them exactly, translate only the words in front. |
| `clients:clientWindow.client.idHint` | One monospaced span, the folder name. Do not translate what is inside it. |
| `clients:clientWindow.notSet` | Stands where a value would be when the client does not set that cvar at all. Two words at most: it is drawn inside a list the width of a field. |
| `clients:clientWindow.clear` | The accessible name of a button that removes one setting from the command line. `{{setting}}` is the label of the row next to it, brackets and all. |
| `clients:clientWindow.extra.hint` | «The controls above» are the rows of the cards over this field. `+set` and `+exec` are console commands and stay as they are. |
| `clients:clientWindow.profiles.form.nicknamePreview`, `nicknameBytes`, `nicknameTooLong` | The key says «profile», but one control carries these three strings and it stands in two cards: the nickname of a player profile and **Player name** of the **Player** card. Word them about a name, not about a profile. `{{used}}` and `{{max}}` count bytes of UTF-8, not letters. |
| `settings:launch.order` | One monospaced span, `+set`. It sits under `settings:launch.hint` and says which of the two fields wins when both name the same cvar; «a client» is the entity, not a person. |
| `clients:launchWarning.*` | A toast shown after the game has already been started with an argument known to break it. `s_initsound` is a cvar name and `EternalJK` a project name; neither is translated. «The launch arguments» covers both fields that carry them — **Extra launch arguments** on **Settings** and **Launch arguments** in the client window — so keep it general and use the wording of `settings:launch.label`. |
| `settings:jkhub.text` | Names the **Browse JKHub** tab of the **Library** screen, which is `library:tabs.jkhub` — use the same words. `jkhub.org` is a domain and stays as it is. |
| `library:categories.*` vs `library:categoryOne.*` | The first is the plural in the category rail, the second the singular on a card badge. Some languages need different words. |
| `library:conflicts.ruleOrder` | The rule the game itself follows, and the only place the player learns why one file beats another. `dl_` is a file-name prefix and `pk3` an extension; neither is translated. |
| `library:conflicts.kind.*`, `library:conflicts.kindHint.*` | What a shared path holds. The first is a badge of one or two words, the second one sentence for a player who does not know the word — «shader» means nothing to most of them. |
| `library:conflicts.ruleToggle` | The button that opens the rule of the engine inside the conflicts window. One short word: it stands next to a summary line and must not push it onto a second row. |
| `library:conflicts.disableWinner`, `library:conflicts.disableHidden` | Both are hints on the **Disable** button; `{{file}}` and `{{next}}` are pk3 file names. Each tells the player what changes after the click, so keep that half of the sentence: disabling the winner hands the path over, disabling a hidden file changes nothing the game reads. |
| `library:preview.kind.*` | The groups of the object list in the preview window and the rail of the **Base game** tab, one or two words each: they stand in a 232 px column and in a drop-down. `levelshot` is the picture of a map on the loading screen, `splash` the picture the client shows while it starts, `hudImage` the icons and bars of the in-game overlay (`HUD` is an abbreviation players know; keep it), `icon` the portraits of skins and parts, `image` the pictures outside the folders the game reads, `strings` the text of the interface in one language, `menu` the screens of the interface, `data` the descriptions the game reads (`.arena`, `.npc`, `.bot`). `other` is what fits nowhere else — a different word from `library:categoryOne.other` is fine. |
| `library:preview.gallery.*` | Captions under a thumbnail and the enlarged picture, one line each. `{{map}}` is a map name and stays as it is. `mapInArchive` and `mapNotInArchive` say whether the map a level shot stands for is itself inside this archive, not whether it is installed. `640×480` is the screen of the game; keep the `×`. `notPowerOfTwo` warns that a texture whose sides are not 2, 4, 8, … 1024 is refused by the original renderer. |
| `library:preview.text.*` | The facts line over a text file: `{{count}}` lines, and for a menu file the number of `itemDef` blocks (`items`), for an effect file the number of its primitives, for a shader file the number of shaders. Three plural keys, one per unit. `truncated` warns that the core cut a long file. |
| `library:preview.strings.*` | The string package view. `{{language}}` and `{{name}}` of `package` are a folder and a file name. `asTable` and `asText` are two buttons of one row, a word each. In `languageMismatch`, `{{found}}` is one or more identifiers such as `LANG_FRENCH` and `{{folder}}` a folder name; both stay as they are. In `languageMissing`, `{{language}}` is the folder name in capitals, so `LANG_{{language}}` reads `LANG_RUSSIAN`: keep the prefix and the placeholder together. `ENDMARKER` in `noEndMarker` is a keyword of the file and is not translated. |
| `library:preview.font.*` | The font view: `{{value}}` is a number out of the font file, `{{name}}` in `atlas` a font name, in `overridesFallback` the word `russian` or `polish` as the file is called. |
| `library:preview.mode.*`, `library:preview.collapseAll`, `library:preview.expandAll` | The title row of the preview window carries two buttons, `simple` and `advanced`: one word each, the active one is filled. `simpleHint` and `advancedHint` are their tooltips, one line each without a full stop. `onlyFiles` stands in the empty state of Simple when the archive holds nothing a player would see, and `switchAdvanced` is the button under it: name the Advanced mode with the word you gave `advanced`. `collapseAll` and `expandAll` are the tooltips of two icon buttons over the object list that fold and unfold every group: two words each. |
| `library:features.*` | Badges on the card of a library file and on the row of a bundle file: one or two words, at most four in a row. `strings` takes `{{language}}` as a two-letter code, `RU` or `EN`, so «RU strings» is the shape; put the code where your language puts an adjective. `characters`, `hilts`, `weapons`, `npcs`, `vehicles`, `maps`, `music` and `sounds` name what the archive adds to the game, in the plural; `npcs` stays an acronym. `more` is the «+3» that stands for the badges that did not fit; keep it to the sign and the number. `label` names the whole row for a screen reader. |
| `jkhub:details.ratingValue` | `{{value}}` is a rating out of five, already formatted; `{{count}}` is the number of reviews. |
| `jkhub:download.*` | The card that follows one install of a JKHub file, in the corner where the toasts are. `{{client}}` is the name the player gave a client, `{{folder}}` is `base` or the name of a mod folder — neither is translated. `download.openFolder` is a narrow button: two words at most. |
| `jkhub:search.unavailable` | The tooltip of the search box while it is switched off, which happens only while the launcher has no copy of the JKHub catalog. It says why the box refuses words, so keep it to one short sentence; the panel below the bar carries the progress and the buttons. |
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
| `settings:about.engineIcons`, `about.engineIconBy` | The credit line of the About card: the engine icons come from the projects themselves. `{{author}}` is a nickname on a site and is never translated. The list of project names after the first key is built by the launcher. |
| `settings:language.draft` | Shown under the **Language** card while `_status.json` names no reviewer. It describes the folder you are translating, so write it in that language even before the rest is checked. |
| `bundles:*` | A *bundle* is a set of clients another player put together and published to JKNet Online: one or more *components*, each an engine with a release tag, files laid over that release (the *overlay*), pk3 and config files and launch settings, plus files every component shares. Pick one word for *bundle* and hold it through the folder; it is not an engine build. Where your language already used that word for an engine build — Russian did — the engine build is now called a *release*. |
| `bundles:modes.*` | The two ways a client starts, as badges and buttons: `multiplayer` joins servers, `single` is the campaign of the game. One or two words each; `modes.pick` is the accessible name of the pair of buttons over the command-line preview. |
| `bundles:tabs.clients`, `bundles:tabs.bundles` | The two tabs at the top of the **Clients** screen. The first names the same thing as the sidebar item `nav:items.clients`; use the same word. |
| `bundles:drafts.*` | The strip of local drafts above the catalogue. A *draft* is a bundle being put together on this computer; `drafts.newBundle` is a button of two words, `drafts.defaultName` the name a fresh draft opens with. `drafts.empty` names the buttons `drafts.newBundle` and `clientCard.createBundle`: use the same words. |
| `bundles:toolbar.sortBy.*`, `bundles:toolbar.anyEngine` | Options of two dropdowns in one row with the search box: one or two words each. |
| `bundles:card.by`, `bundles:review.by` | One line under a name, «by {{author}}». `{{author}}` is a display name on the service and is never translated. |
| `bundles:card.basedOn` | The line under the name of a card: `{{engines}}` is a list the launcher builds, «EternalJK v1.6.3 · OpenJK · jaMME», and is never translated. |
| `bundles:list.unsupported` | The text of the catalogue error when the service answers 404 because it predates bundles. One or two sentences; **JKNet Online** is the name of the service. |
| `bundles:card.ownerUnknown` | Stands where the author's name would be when the account was deleted; the bundle stays. |
| `bundles:card.download` | A tooltip on the size of the bundle: `{{size}}` is already formatted, «12.4 MB». |
| `bundles:details.version`, `details.published`, `details.engineRelease` | Fragments of one line joined with « · » by the code: no capital at the start, no full stop at the end. `{{label}}` is a version label the author typed, `{{tag}}` a GitHub release tag such as `v1.6.3`. |
| `bundles:details.componentNamed` | The heading of one component's block: `{{label}}` is the label its author gave it, such as «Multiplayer», and comes as it is. |
| `bundles:details.overlay.replaced`, `added`, `removed` | Three counts joined with « · » into one line, «Replaced 5 · Added 2 · Removed 1»: each a capitalised word and a number. `replacedOne`, `addedOne`, `removedOne` are the badges of one file, lowercase. |
| `bundles:details.kind.*`, `bundles:details.source.*` | Badges on a file row. `pk3`, `cfg`, `dll` and `exe` are file extensions and stay as they are; only `other` is a word. `JKHub` and `JKNet` are names. |
| `bundles:details.modified`, `details.modifiedHint`, `details.modifiedOrigin` | A badge of one word on a file that came from JKHub and was changed by the author, and its two tooltips. `{{id}}` is the number of the JKHub record. |
| `bundles:details.folderHome` | The heading of a group of files: `{{folder}}` is a folder name on disk, `base` or the name of a mod, and is never translated. |
| `bundles:details.executableWarning`, `details.install.trust`, `details.install.trustHint` | The line under an exe or dll and the switch a player has to turn on before installing a bundle with one. Say plainly that JKNet cannot check the file; do not soften it. |
| `bundles:details.sha256`, `details.virusTotal` | `SHA-256` is the name of a hash and `VirusTotal` a site; neither is translated. |
| `bundles:details.fsGame`, `details.fsGameBase` | `fs_game` is a cvar and `base` a folder name; both stay. |
| `bundles:details.status.*` | Badges of one or two words: where a version is in its life. `pending` means an administrator has not looked at it yet. |
| `bundles:details.install.baseName`, `baseNameHint`, `baseNameHintOne` | The name field of the install: each ticked component becomes a client called «{{name}} · label». `{{name}}` in the hint is what the player typed; the label after the dot is `modes.multiplayer` translated, so use the same word. |
| `bundles:details.install.openClient` | A small button per installed client: `{{client}}` is the name of the client. Two or three words plus the name. |
| `bundles:details.install.failedIn` | Stands before the reason of a failure: `{{component}}` is the label of the component being written. Ends with a colon. |
| `bundles:details.install.phase.files`, `bundles:publish.upload.file` | `{{index}}` and `{{count}}` are «file 3 of 12»; `{{file}}` is a file name. |
| `bundles:editor.*` | The editor of a draft: a page with a navigation column (`editor.nav.*`, one or two words each), four tabs of a component (`editor.tabs.*`), and forms. `editor.saving`, `editor.saved` and `editor.notSaved` stand in the subtitle of the page; `editor.autosave` is the same place before the first edit. |
| `bundles:editor.origin.*` | Badges of one word on a file row of the editor: where the file was taken from. `disk` is the computer of the author, `client` one of their clients, `release` the engine release a file replaces. |
| `bundles:editor.overview.*Hint`, `editor.overview.invalid.*` | The hint sits under the field, the `invalid` sentence replaces it when the value is wrong: keep the limits as numbers. `https://`, `discord.gg` and `discord.com` are addresses and stay. |
| `bundles:editor.components.labelHint` | Gives three example labels in quotation marks; translate them as you translated `modes.*`, and use the marks of your language. |
| `bundles:editor.components.latestRelease`, `releaseHint` | The first option of the release list and the hint under it: the two quote each other, so use the same words. |
| `bundles:editor.engineFiles.summary` | Three counts the launcher fills in from `details.overlay.replaced`, `added` and `removed`, joined by « · »: nothing to translate but the separators. |
| `bundles:editor.engineFiles.replace`, `exclude`, `include`, `restore` | Four small buttons on a file row, one word each. `exclude` deletes the release file on install, `include` takes that back, `restore` takes a replacement or an addition back. |
| `bundles:editor.files.folder` | The label in front of a dropdown of folder names: «Into base». One short word. |
| `bundles:editor.files.pick` | What the button of a JKHub card says in the editor instead of **Install**: two or three words, it has to fit a card 216 px wide. |
| `bundles:editor.configs.untitled` | The name of a config document added empty: `{{index}}` is its number in the list. |
| `bundles:editor.launch.argsPlaceholder` | An example command line: `+set cg_fov 97` stays as it is. |
| `bundles:editor.preview.you` | Stands where the author's name would be while nobody is signed in. |
| `bundles:editor.issue.*` | Whole sentences in a notice box, one per code the draft check answers with. `passwordsStripped` carries `{{count}}` lines. `summaryTooLong` is about the one-line summary (`editor.overview.summary`); `descriptionTooLong` and `imageMissing` are about the description: the second is followed by the hash of the picture the launcher appends in brackets, so do not name the picture in the sentence. A finding about a translation gets the code of its language appended in the same brackets, so do not name a language either. |
| `bundles:editor.test.title` | `{{draft}}` is the name of the draft. |
| `bundles:publish.upload.publishedText`, `pendingText` | `{{bundle}}` is a name the author typed and `{{label}}` its version label; both come as they are. **Bundles** and **My bundles** name a tab and a button of the launcher: use the words you gave `tabs.bundles` and `toolbar.myBundles`. |
| `bundles:publish.upload.failedDraftRetry` | Under the reason of a failed upload, when the bundle itself was created before the failure. **My bundles**, **Retry** and **Start over** name the button `toolbar.myBundles` and the two buttons `publish.upload.retry` and `publish.upload.startOver`: use the same words. |
| `bundles:clientCard.fromBundle`, `clientCard.fromDraft`, `clientCard.customBuild` | Badges on the first line of a client card, next to **Default** and **Running**: one or two words. `customBuild` says the engine folder carries files of a bundle, so the update check is off; the reason is in `customBuildHint`. |
| `bundles:clientCard.linkHint`, `linkHintDraft` | Tooltips of those badges: `{{bundle}}` is the name of the bundle or the draft, `{{component}}` the label of the component, `{{version}}` a version label. All three come as they are. |
| `bundles:clientCard.groupHeading` | The heading over the clients of one bundle on the Clients screen: `{{bundle}}` is its name. |
| `bundles:clientCard.busyInstall` | The tooltip on the buttons of a client card while a bundle is being installed into the client: it says why the button is off. One short sentence, no full stop. |
| `bundles:clientCard.incomplete`, `clientCard.incompleteHint`, `clientCard.resume`, `clientCard.resumeHint` | A client whose bundle install stopped halfway: a badge of two words on the first line of the card, its tooltip, a small button that carries the install on in the same client, and the tooltip of that button. Files already in place are kept, so the button promises continuation, not a fresh start. |
| `bundles:clientCard.playSingle` | The large button beside **Launch** on a client that also plays the campaign, and in its place on a client that plays nothing else: two or three words, as short as `clients:engine.launch`. |
| `bundles:clientCard.createBundle`, `createBundleMenu` | A small button of the client card and the same line in its context menu: the button is two words, the menu line may be longer and ends with «…». |
| `bundles:mine.edit`, `mine.editing`, `mine.editHint`, `mine.editHintFetch` | A button of one word on each bundle of the **My bundles** list, what it says while it works, and its two tooltips: the second is for a bundle with no draft on this computer, whose files are downloaded first. |
| `bundles:mine.quota` | `{{used}}` and `{{quota}}` are sizes already formatted for the language. |
| `bundles:review.sharedPart` | A badge of one word on an executable that belongs to no component but to the shared part of the bundle. |
| `bundles:editor.overview.tool.*`, `editor.overview.toolbar` | The buttons of the formatting toolbar over the description, read out by a screen reader and shown on hover: one or two words each, the way a word processor names them. `heading2` and `heading3` are the two levels the toolbar offers; call them «Heading» and «Subheading» rather than by number. The three with «…» open a dialog. `taskList` is a list whose items carry a box to tick. `table` inserts a table; `addRow`, `addColumn`, `deleteRow`, `deleteColumn` and `deleteTable` appear only while the cursor is inside one and act on the row or column the cursor is in. |
| `bundles:editor.overview.taskItem`, `taskEmpty` | The accessible name of the box of one task-list item, read out by a screen reader and never shown: `{{text}}` is the text of the item as the author typed it. `taskEmpty` stands in for an item with no text yet. |
| `bundles:editor.overview.descriptionHint`, `descriptionPlaceholder` | The description is Markdown now: the hint names the size limit and what the toolbar adds, the placeholder is one line of grey text inside the empty field. `Markdown`, `KiB` and the three host names stay as they are. |
| `bundles:editor.overview.link*`, `video*`, `addressPlaceholder`, `invalid.link`, `invalid.video` | The two address dialogs of the toolbar: title, one sentence of body, the accessible name of the field, and the sentence shown for a refused address; the button that applies is `common:actions.apply`. `http://`, `https://`, `YouTube`, `Twitch` and `VK Video` are addresses and names and stay. |
| `bundles:editor.overview.image*` | The system file dialog that adds a picture (`imageTitle` is its title, `imageFilter` the name of the file-type filter) and the line under the editor when the core refused one: `{{reason}}` is the refusal, already translated. |
| `bundles:editor.issue.unusedImages`, `editor.publish.removeImages`, `removingImages`, `removeImagesFailed` | A warning of the draft check: pictures were added to the draft but the description no longer points at them. They cost nothing and are skipped at publish time; say so in one sentence. Under it stands a button that takes those pictures out of the draft: `removeImages` carries `{{count}}` pictures, `removingImages` is what it says while it works, and `removeImagesFailed` is the line under it when the core refused, with `{{reason}}` already translated. |
| `bundles:description.*` | The description as the catalogue draws it. `play` is the accessible name of the play button over the still of a YouTube video; `videoOn` names the player frame and `watchOn` is the card of a Twitch or VK Video link, with `{{host}}` one of the three names, never translated. `openPicture` is the tooltip of a picture, `pictureFailed` stands where a picture could not be loaded, `pictureTitle` is the title of the enlarged picture when it has no caption. |
| `bundles:contents.*` | The **Contents** dialog of one file of a bundle: `action` and `preview` are icon buttons at the end of a file row (`{{file}}` is its name), `title` heads the dialog. `entries` counts what a pk3 holds, `matches` what the search found; `moreMatches` carries two numbers. `showMore` is a small button at the end of a long folder: pressing it draws the next `{{count}}` files. `noListing` is for a bundle published before archives had a table of contents; `downloading` is shown while the listing or the text comes from JKNet Online. `previewNeedsLauncher` is the tooltip of a **Preview** button that is off in a browser. |
| `bundles:review.description` | The line that opens the description of a bundle on the review queue: one word. |
| `bundles:editor.overview.languages.*` | The strip over the name, the summary and the description of a draft: the bundle is written in one *default language* and may carry a *translation* into each other language the launcher speaks. `default` is a badge of one word on the chip of the default language; `defaultLanguage` is the label inside a dropdown, uppercased by the code, so keep it to two words; `add` is what the dropdown of languages to add says on its face and `addLabel` its accessible name. `translation` stands under the strip while a translation is shown: `{{language}}` and `{{default}}` are native names of languages — «Русский», «Deutsch» — and are never translated. `copyFromDefault` and `remove` are two small buttons on that line; `removeTitle`, `removeBody` and `removeConfirm` are the question in front of **Remove** on a translation that says something. |
| `bundles:editor.overview.nameHintTranslation`, `editor.overview.invalid.translationName` | The hint under the name field of a translation and the sentence that replaces it: an empty translated name is allowed and means «show the default language», a name that says something is held to 2–64 characters like the default one. |
| `bundles:card.languages`, `bundles:details.language` | The tooltip of the «EN · RU» badge on a card — `{{languages}}` is a list of native names the launcher builds, never translated — and the accessible name of the row of code buttons over the record of a bundle that picks the language of its text. |

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

Seven of the eight folders wait for a reviewer: six are machine drafts and the
Russian one was written by hand, but nobody has read any of them end to end.
Their `_status.json` says so with `"reviewer": null`, and that is what puts the
warning under the **Language** card.

If you are a native speaker and you have read the whole folder, put your name in
`reviewer` and set `date` to the day you finished. The warning goes away with
it. Leave `reviewer` as `null` if you only fixed a few strings — a folder claims
to be checked once, and it should be true.
