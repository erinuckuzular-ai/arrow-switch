# Arrow Switch

Automatic multicam podcast editing for Adobe Premiere Pro (2022 and newer).
Arrow Switch listens to each person's mic, works out who is talking, and cuts
between their cameras — with wide shots for cross-talk and long monologues.

| Set up | Listening | Preview | Done |
|---|---|---|---|
| ![Empty state](docs/screenshots/empty.png) | ![Analyzing](docs/screenshots/analyzing.png) | ![Result](docs/screenshots/result.png) | ![Done](docs/screenshots/done.png) |

## For users

**Download:** grab `Arrow-Switch-<version>.dmg` from the [latest release](https://github.com/erinuckuzular-ai/arrow-switch/releases/latest).

1. Open `Arrow-Switch-<version>.dmg` and run **Install Arrow Switch.pkg**.
2. In Premiere: **Window → Extensions → Arrow Switch**.
3. Sequence layout: one camera per video track (e.g. V1 wide, V2 host, V3 guest)
   and one mic per audio track (A1 host, A2 guest), all synced.
4. Pick how cutty (Sleepy / Chatty / Chaotic), hit **LISTEN!**, then **CUT IT!**

Arrow Switch saves your project, then duplicates your sequence (`<name> – Arrow Switch`, numbered if that name is taken) and disables the unused
angle on each cut, so every shot can be flipped back on by hand.

Windows: install `Arrow Switch.zxp` with a ZXP installer and put `ffmpeg.exe`
in the extension's `bin` folder.

## For developers

```
extension/            the CEP panel that ships to users
  CSXS/manifest.xml   extension manifest (bump ExtensionBundleVersion to release)
  index.html, css/    panel UI
  js/engine.js        speaker detection + edit decisions (pure JS, unit tested)
  js/audio.js         ffmpeg decoding -> loudness per 100 ms
  js/main.js          UI logic; runs in demo mode when opened in a normal browser
                      (?state=empty|analyzing|result|done jumps to a screen)
  fonts/              Lilita One + Nunito (SIL OFL), bundled so it works offline
  jsx/host.jsx        ExtendScript: reads the sequence, clones it, razors, disables clips
installer/            pkg scripts, installer pages, uninstaller, read me
test/                 node --test suites
build.sh              tests -> universal ffmpeg -> signed ZXP -> .pkg -> .dmg
```

### Accuracy benchmark

```bash
node test/bench/accuracy.js
```

Generates synthetic podcasts with known answers (mic bleed, a quiet guest, rumble,
backchannels, cross-talk, a two-channel recorder) and scores the engine: time on the
right camera, wrong shots, missed turns, cut timing and listen speed. Pass a folder
holding another `engine.js` + `audio.js` to compare versions.

### Build the DMG

```bash
./build.sh
```

Output: `dist/Arrow-Switch-<version>.dmg`. The first run downloads a static
universal ffmpeg and Adobe's ZXPSignCmd into `.cache/`, and creates a
self-signed ZXP certificate in `certs/` (keep it; reuse it for updates).

### Signing and notarization (no "malware" warning)

Unsigned installers make macOS say it can't verify the app is free of malware. Signing
with Apple Developer ID certificates and notarizing removes that. One-time setup:

1. Join the [Apple Developer Program](https://developer.apple.com/programs/enroll/) ($99/year).
2. Create both certificates on this Mac: Xcode → Settings → Accounts → your team →
   Manage Certificates → **+** → **Developer ID Application**, then again for
   **Developer ID Installer**. (Only the team's Account Holder can create these.)
3. Make an app-specific password at [account.apple.com](https://account.apple.com) → Sign-In and Security →
   App-Specific Passwords, then save the notary credentials in the keychain:

   ```bash
   xcrun notarytool store-credentials arrow-switch-notary --apple-id you@example.com --team-id TEAMID
   ```

After that, `./build.sh` finds the certificates and profile by itself, signs ffmpeg,
the installer and the DMG, sends them to Apple, staples the tickets and checks the result.
Use `RELEASE=1 ./build.sh` for anything you publish: it stops if the DMG isn't notarized.

### Develop live inside Premiere

Enable unsigned extensions once, then symlink the source folder:

```bash
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
ln -s "$PWD/extension" ~/Library/Application\ Support/Adobe/CEP/extensions/com.arrow.switch
```

Restart Premiere. Debug with Chrome at http://localhost:8088 (see `extension/.debug`).
Preview just the UI in a browser: `python3 -m http.server -d extension` (demo mode).

### Licensing note

Arrow Switch's own code is MIT licensed (see `LICENSE`). Bundled third-party parts keep their own licenses:

The bundled ffmpeg is a GPLv3 build. Arrow Switch runs it as a separate program, and every
release ships `licenses/` (GPL text + `FFMPEG-NOTICE.txt`) in the extension and the DMG.
`build.sh` also drops the ffmpeg source and its build scripts into `dist/`: **attach
`ffmpeg-9.0.1.tar.xz` and `ffmpeg-build-script.tar.gz` to every GitHub release** next to the DMG.
If you swap in a different ffmpeg build, update `FFMPEG_VERSION` in `build.sh` and the notice.

Fonts: Lilita One and Nunito, SIL Open Font License 1.1 (`extension/fonts/FONTS-LICENSE.txt`).
