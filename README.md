# JKNet

JKNet is a Windows launcher for Star Wars Jedi Knight multiplayer. It installs engines, runs clients, keeps the pk3 files of every client apart and lists servers. Steam is not required: the launcher only reads the `base\assets*.pk3` archives of your copy of the game and never writes into the game folder.

The launcher serves two games. Jedi Academy is played through OpenJK, EternalJK, TaystJK and jaMME. Jedi Outcast is played through JK2MV, the only living multiplayer client of that game. It understands versions 1.02, 1.03 and 1.04, and almost every server runs 1.04. The game is an attribute of an engine, a client and a server row; the entities are still three: engine, client, library file.

The game switch sits at the very top of the sidebar: each game has its own clients, its own server list and its own default client. The choice is saved, so the launcher opens on the game you finished with.

All five screens work: **Home**, **Servers**, **Library**, **Clients** and **Friends**.

In **Library**, the card of an installed file opens a preview of the finished objects inside the package: characters, hilts, weapons, vehicles, music and maps. Maps render their geometry with textures and lighting; the mouse and keyboard drive a free camera. On JKHub use **Download for preview**.

The **Base game** tab lists the finished objects of the stock Jedi Academy or Jedi Outcast archives on their own. The catalog supports search, categories, a per-archive filter and the preview. It works without a client as long as the game folder is set in the settings.

The launcher speaks eight languages: English, Russian, Ukrainian, German, French, Spanish, Polish and Hungarian. The **Language** card on the **Settings** screen picks one; the default is the system language. English is the source language, Russian was translated by hand and awaits proofreading, the other six are machine drafts that also await native speakers. The **Language** card says so itself.

## What works

- **Game discovery.** The launcher finds the `GameData` folders of both games in Steam and GOG installations, checks the asset archives, detects the Jedi Outcast version and accepts a folder picked by hand.
- **Clients.** A client is a named instance of an engine with its own files and settings. The launcher creates, renames and deletes clients, assigns a default client per game, sets the `fs_game` mod folder and per-client launch arguments.
- **Engines.** A registry of five builds: OpenJK, EternalJK, TaystJK and jaMME for Jedi Academy, JK2MV for Jedi Outcast. The launcher reads GitHub releases, downloads the Windows archive, unpacks it into the client folder and checks for updates by tag and publication time. Every build carries a status: recommended, supported or legacy. There are no legacy builds at the moment. EternalJK does not survive the `s_initsound 0` launch argument and crashes on map load with it; the launcher warns about that with a toast and leaves the launch line alone.
- **Launching the game.** The launcher starts the engine executable itself. A Jedi Academy client gets three file-system roots: `fs_cdpath` at the game folder, `fs_basepath` at the unpacked build, `fs_homepath` at the client folder. A Jedi Outcast client gets its own `basepath` root with a link to the `base` folder of the game: JK2MV 1.4.1 does not read `fs_assetspath` and looks for the menu module only in the root of `fs_basepath`. The launcher puts a copy of `jk2mvmenu_*.dll` into that root, makes the `base` entry a directory junction to the game folder and copies the JK2MV archives into the client's `home\base\`. It never writes into the game folder, not even through the link. One game runs at a time; the launcher watches the process and can stop it.
- **Server browser.** For Jedi Academy the launcher asks the master servers `master.jkhub.org` and `masterjk3.ravensoft.com` for addresses over protocol 26, for Jedi Outcast `master.jkhub.org:28060` and `master.jk2mv.org:28060` over protocols 15 and 16, then queries every server with `getinfo` and fills the table as answers arrive. There are filters, the tabs **All**, **Favorites**, **History**, **LAN** and **Hidden**, a player list and a **Connect** button that connects with the client remembered for that server. The selected server also gets a three-dot button: favorites and **Hide**.
- **pk3 library.** Files belong to a client and live in its `home\` folder. The launcher installs archives by drag and drop or through a dialog, detects the category, enables and disables a file by renaming it, finds conflicting internal paths and names the winner by the engine's rules.
- **JKHub catalog.** The **Browse JKHub** tab of the **Library** screen shows the files of jkhub.org without leaving the launcher: a category tree, sorting, cards with a screenshot, author, date and download count, a details panel with the description and pictures. The search box searches the whole catalog of the game, and while a search is active the category tree shows only the categories with matches, with their counts. The **Install** button downloads the archive, extracts the pk3 files from any depth and puts them into the selected client; the card of an already installed file carries an **Installed** badge. The launcher reads the public pages of the site with at most two requests at once and a 300 ms pause, identifies itself with its own `User-Agent` and caches responses, so as not to load somebody else's server.
- **Settings.** The **Settings** screen shows the data folder, opens it in Explorer, sets the folder of each of the two games and offers **Extra launch arguments**: tokens appended to the launch command of every client. Per-client arguments come after them, so a repeated `+set` of the same cvar on the client wins.
- **Launcher updates.** An installed launcher checks GitHub Releases, shows a notification about a new version and installs it on request. The package is verified with a minisign signature.
- **Account.** The launcher signs in to JKNet Online through Discord in the browser, shows the name and avatar in the sidebar and offers an **Account** card on the **Settings** screen: renaming, signing out and deleting your data from the service. Signing in through JKHub requires a separate OAuth client issued by its administrators. A `dev` provider is available for local development. You can also play as a guest: an account is only needed for friends and invites.

- **Friends and invites.** The **Friends** screen lists friends grouped by state: in game, online, offline. Requests go out by display name, arrive on the same screen and are accepted with one button. **Join game** launches the default client straight onto the friend's server, and **Invite to my game** calls a friend over; the invite arrives as a toast on any screen. The launcher tells the service where you are by itself: in the launcher or in the game, on which server and with which client.

Release builds connect to the public JKNet Online service at the address compiled into the code (`RELEASE_ONLINE_URL`); debug builds use `http://127.0.0.1:8787`. To try the public service from a debug launcher, enter its address in the **JKNet Online address** field on the **Account** card after signing out of the local account. An end user only needs to install the launcher.

## What is missing

- Signing in through JKHub requires an OAuth client from the JKHub administrators. Signing in through Discord works.
- The Downloads and Appearance sections of the settings are placeholders.
- Search on the **Browse JKHub** tab uses a local catalog. It supports `by:`, `after:` and `before:`. Sorting by rating works in both directions; entries without reviews come last.
- The launcher does not open `.rar` archives: for those the card offers to open the file on JKHub.

## Installing and updating

This section is for players. Developers want the [Quick start](#quick-start) section.

Install the launcher:

1. Download `JKNet_0.4.0_x64-setup.exe` from the [releases page](https://github.com/TrayHard/jknet/releases/latest).
2. Run the file. The installer does not ask for administrator rights: it writes into the folder of the current user.
3. Optional: on the last page of the installer tick **Create desktop shortcut**.
4. Open JKNet from the **Start** menu, group **JKNet**.

The installer places files like this:

| What | Where |
| --- | --- |
| Program | `%LOCALAPPDATA%\JKNet` |
| Shortcut | **Start** menu, group **JKNet**; on the desktop when ticked |
| Player data | `%LOCALAPPDATA%\org.jknet.launcher`: `settings.json`, `clients\`, `library\`, `cache\`, `logs\` |
| Install path | `HKCU\Software\JKNet\JKNet` |
| Entry in the programs list | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\JKNet` |

The program and the data live in different folders. The NSIS installer in `currentUser` mode takes the folder named after the product, `%LOCALAPPDATA%\JKNet`, so the launcher writes its own files into the identifier folder, `%LOCALAPPDATA%\org.jknet.launcher`. The uninstaller offers a **Delete app data** checkbox, and that checkbox clears exactly the data folder. Untick it so that clients, the library and the settings survive the removal (not verified: the uninstaller has not been exercised).

Early builds of the launcher kept their data in `%LOCALAPPDATA%\JKNet`. On start the launcher moves `settings.json`, `clients\`, `library\`, `cache\` and `logs\` from there into the identifier folder and logs every move. The rest of the old folder stays in place: the program itself lives there.

Updates arrive on their own:

- 5 s after start the launcher asks GitHub Releases for the `latest.json` file.
- If the version on the server is newer, the launcher shows the notification `JKNet VERSION is available` with an **Install and restart** button.
- The button downloads the package, shows the progress and hands the file to the installer. The installer runs in `passive` mode: it shows a progress bar and asks nothing. After the installation the launcher restarts itself.

To check for updates by hand, open the **Settings** screen and press **Check for updates** on the **About** card. The installed version is written there too.

The launcher verifies the package signature with minisign before it hands the file to the installer. A package without a signature or with somebody else's signature is rejected. A verification error at start goes only to the log: a player who asked nothing should see no answer. A verification error after pressing the button is shown on the **About** card.

> **Note.** The build has no Authenticode certificate, so Microsoft SmartScreen shows a warning the first time the installer runs. Signing with a certificate is a separate decision.

## Prerequisites

Install:

- Node.js 24 and npm 11;
- Rust stable with the `x86_64-pc-windows-msvc` target (`rustup default stable-msvc`);
- Visual Studio Build Tools 2022 with the **Desktop development with C++** workload;
- WebView2 Runtime (Windows 11 ships it by default).

## Quick start

If the terminal was opened before Rust was installed, `npm run tauri dev` fails with `failed to run 'cargo metadata' ... program not found`: the inherited `PATH` lacks `%USERPROFILE%\.cargo\bin`. Open a new terminal, or add that folder to `PATH` by hand.

1. Install the frontend dependencies:
   ```bash
   npm install
   ```
2. Run the application in development mode:
   ```bash
   npm run tauri dev
   ```
   The command starts Vite on port 1420 and builds the Rust core. The first build takes several minutes.

   To look at the layout only, run `npm run dev` and open `http://localhost:1420/` in a browser. The core is not built in this mode: commands answer with `Tauri runtime is not available` and the screens show their empty states. The exception is the **Friends** screen: outside Tauri its commands go to the JKNet Online mock through `fetch`, so the lists are visible in a browser too.

   To try signing in, friends and invites, start the JKNet Online mock in a second terminal:
   ```bash
   node scripts/mock-online.mjs
   ```
   The mock listens on `http://127.0.0.1:8787`, the default service address of a debug build, that is the one `npm run tauri dev` starts. The `dev` provider completes the sign-in by itself after 3 s; JKHub and Discord refuse, as the real service does.
3. Build the installer:
   ```bash
   npm run tauri build
   ```
   The result is `src-tauri/target/release/bundle/nsis/JKNet_0.4.0_x64-setup.exe`. On a cold cache the build takes about ten minutes.

   To get the `.sig` signature file next to it, set the update signing key before the build:

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\jknet.key" -Raw
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npm run tauri build
   ```

   Without these variables the build produces the installer and then fails at the signing step: `A public key has been found, but no private key`. That is how `bundle.createUpdaterArtifacts` in `tauri.conf.json` works. A `.sig` file from a previous build stays on disk and no longer matches the new installer, so delete it or rebuild with the key.

## Checks

| Task | Command |
| --- | --- |
| Types and frontend build | `npm run build` |
| Types only | `npm run typecheck` |
| Compile the core | `cargo check --all-targets` in `src-tauri` |
| Rust linter | `cargo clippy --all-targets -- -D warnings` in `src-tauri` |
| Rust unit tests | `cargo test` in `src-tauri` |
| Release manifest tests | `node --test scripts/release-manifest.test.mjs` |

Some tests are marked `#[ignore]`: they reach the internet or need an installed game. Add `-- --ignored` to run them.

The same six checks run in `.github/workflows/ci.yml` on a `windows-latest` runner on every push and in every pull request.

## Releasing a version

A release is built by `.github/workflows/release.yml` on a `vX.Y.Z` tag. The same workflow publishes a draft release and the `latest.json` update file.

### Before you start

Create two GitHub Actions secrets in the repository:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the whole content of `%USERPROFILE%\.tauri\jknet.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | an empty string: the key was issued without a password |

Check the update endpoint: `plugins.updater.endpoints` in `src-tauri/tauri.conf.json` points at `https://github.com/TrayHard/jknet/releases/latest/download/latest.json`. Change it if releases move to another repository. While there are no published releases, the launcher checks for updates in vain: the address answers with an error, the launcher logs it and carries on.

> **Warning.** The private key exists in one copy and never enters the repository: `.gitignore` rejects `*.key`. Losing the key cuts every installed launcher off from updates: the signature of a new build would no longer match the `pubkey` field that has already spread to the players' machines. Keep a backup in a password manager.

### Release steps

1. Bump the version to the same value in three files: `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. Both the installer and the updater take the version from `tauri.conf.json`, and a mismatch with `Cargo.toml` gives different numbers in the window and in the programs list.
2. Refresh `Cargo.lock`: run `cargo check` in `src-tauri`.
3. Refresh `package-lock.json`: run `npm install --package-lock-only`.
4. Commit the changes and tag them:
   ```bash
   git commit -am "Version 0.4.0"
   git tag v0.4.0
   git push origin main --tags
   ```
5. Wait for the **Release** workflow on the **Actions** tab to finish. It builds the installer, signs it and creates a draft release. Then `scripts/release-manifest.mjs` points `latest.json` at the public download address, adds `SHA256SUMS` and checks the installer signature against the key in `tauri.conf.json`. If the run fails, do not publish the draft.
6. Check the draft's assets: `JKNet_0.4.0_x64-setup.exe`, `JKNet_0.4.0_x64-setup.exe.sig`, `latest.json` and `SHA256SUMS`.
7. Publish the draft with **Publish release**.

Installed launchers see the version once it is published: `releases/latest/download/latest.json` does not serve drafts.

## Repository layout

| Folder | Content |
| --- | --- |
| `src/` | frontend: React, TypeScript, Tailwind CSS |
| `src/styles/` | design tokens and local fonts |
| `src/components/` | application shell, dialogs and the UI kit |
| `src/pages/` | screens by route |
| `src/lib/` | typed wrappers over the commands and React Query hooks |
| `src/i18n/` | i18next setup, the language list, key types, formatting through `Intl` |
| `src/locales/` | string catalogs, one folder per language |
| `public/` | the JKNet mark: the master `jknet_logo.png` and raster copies in `brand/` |
| `scripts/` | the JKNet Online mock, the translation check, `make-brand-assets.ps1` for copies of the mark |
| `src-tauri/` | the Rust core, the Tauri configuration, window permissions |

## Where the data lives

The launcher creates `%LOCALAPPDATA%\org.jknet.launcher`:

| Path | Content |
| --- | --- |
| `settings.json` | launcher settings |
| `clients\<slug>\` | a client: `client.json`, `library.json`, the `engine\` folder, the `home\` folder |
| `library\` | downloaded pk3 files |
| `cache\` | the server lists `servers-ja.json` and `servers-jo.json`, engine releases, build archives, the JKHub catalog in `jkhub\` |
| `logs\` | log files |

The folder name repeats the `identifier` field of `src-tauri/tauri.conf.json`. The path comes from `app.path().app_local_data_dir()`, and the same folder is what the uninstaller clears with **Delete app data**. The program is installed next door in `%LOCALAPPDATA%\JKNet` and does not overlap with the data.

The `dataDirOverride` setting moves `clients`, `library`, `cache` and `logs` to another folder. `settings.json` stays in `%LOCALAPPDATA%\org.jknet.launcher`.

Edit `settings.json` by hand when the launcher is closed or when the fields do not overlap: the `update_settings` command writes only the changed fields and re-reads the file before writing.

## Documentation

The repository publishes only the code and this README. The architecture, localization and change log are maintained outside the repository; release notes live on the GitHub releases page.

## License

The launcher is distributed under the GNU General Public License version 3 or later (`GPL-3.0-or-later`). The full text is in the [LICENSE file](LICENSE).

© 2026 TrayHard

The license of the code does not cover the JKNet name and the JKNet mark. They remain with the author.
