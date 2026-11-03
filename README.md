# Steam Disk Bill

A small Windows app that reads a local Steam library and shows where the disk went. Nothing is cleaned automatically; every removal needs explicit confirmation.

Double-click [Steam Disk Bill.vbs](Steam%20Disk%20Bill.vbs). That starts a local server on `127.0.0.1:47331` and opens an Edge app window. Closing the window stops the server. [steam-disk-bill-console.bat](steam-disk-bill-console.bat) does the same with a console left open.

The window lists:

- installed size and free space per library
- installs that were never played, or last played longer ago than 180 / 365 / 730 days
- shader cache and workshop files left behind after a game was uninstalled
- libraries on a drive that is currently unplugged, using the sizes saved in `libraryfolders.vdf`
- in-progress downloads, shown separately and excluded from the review estimate

## Libraries on other PCs

Nothing is tied to one machine. The Steam folder comes from `STEAM_PATH`, the Windows registry, or the default Program Files location. The library list comes from Steam's own `steamapps/libraryfolders.vdf`, so every drive added in Steam appears. A drive that is not currently connected is shown as offline with the sizes Steam last recorded.

## Desktop interface

The app uses a Steam-inspired blue-gray storage layout while keeping its own Steam Disk Bill identity. It includes sidebar views, library filters, searchable and sortable game rows, and expandable size breakdowns. Cover art comes only from Steam's existing local cache, including localized and legacy cache layouts; no artwork is downloaded.

Use the top-bar language selector to switch between Simplified Chinese and English. The first visit follows your browser's preferred supported language, with English as the fallback. Your selection is remembered locally when browser storage is available. Switching languages preserves the current scan, search, filters, threshold, sort mode, and expanded details without reading the disk again. Copied reports use the selected language; game names, file paths, and raw system diagnostics remain unchanged.

Changing the inactivity threshold recalculates the current report immediately. Use **Scan libraries** to read the disk again. **Space to review** is a candidate estimate, not a guarantee that files can be safely removed. A missing local play-history timestamp is labeled as **No play history**, not as proof that a game has never been played.

## Open folder and removal

Expand a row to see two buttons:

- **Open folder** opens the game install folder or the cache folder in Explorer.
- The red button depends on the row:
  - **Uninstall via Steam…** for games. It sends `steam://uninstall/<appid>` to Steam through the same `steam.exe -- <url>` handler Steam registers for its links. Steam shows its own dialog; this app never deletes game folders itself.
  - **Delete cache…** for leftover shader or workshop folders. Windows asks for confirmation and moves the folder to the Recycle Bin. If Windows says it cannot recycle the folder, cancel instead of choosing permanent deletion.

Safeguards:

- a required checkbox and a one-time confirmation ticket that expires after two minutes
- a per-session token on the local action API, with host and origin checks
- re-validation against Steam's files right before acting; a rescan invalidates old targets
- linked paths (junctions or symlinks) at or inside a target are refused
- cache deletion is blocked while Steam is running, while Steam still has an install, download or library record for that app, or when the scan reported warnings
- only one action runs at a time

## Verification

```bash
npm install --cache D:/Caches/npm
npm run test:actions
npm run test:ui
```

`test:actions` exercises the removal safeguards against a throwaway Steam layout in `.test-tmp/` with fake Windows side effects, so no real files are touched.

The UI smoke test uses the installed Windows Edge browser with Playwright, reads the real local Steam library, and checks navigation/search/sorting/details/copy/error handling. It opens the removal dialog and cancels it, so no uninstall or deletion is requested. It also verifies Chinese/English switching, state preservation, localized reports, language persistence, switching during a pending scan, initial failures, and blocked preference storage. Lifecycle checks replay the real scan response rather than reading the disk repeatedly. Screenshots are saved to `screenshots/`. Stop a running instance first so the test can own its local port. Test tools are not required to launch the app.

Requires Node.js. The launcher looks for `D:\Programs\nodejs\node.exe`, then `node` on `PATH`. Edge is used for the window. Set `STEAM_PATH` if Steam is not in the registry.

A text summary without the window:

```bash
node tools/preview.mjs --days 365
```

`src/scan.mjs` is the scanner and `src/actions.mjs` handles open/removal requests. `backend/` and `frontend/` are an earlier Millennium plugin; the desktop app does not need Millennium.
