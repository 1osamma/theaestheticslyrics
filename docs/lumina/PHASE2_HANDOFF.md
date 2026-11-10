# LUMINA Phase 2 handoff

State at handoff: branch **`lumina/phase-2`** (local only, **not pushed**). The latest commit is the
one that adds the Spotify-only capture fix (run `git log --oneline -1`), and the working tree is clean. It is based on `lumina/phase-1` @ `6fb7f00`, which is pushed to
`origin` = `https://github.com/1osamma/theaestheticslyrics.git`. `main` is untouched.
Nothing is merged or pushed, and no pull request exists.

Full technical detail: [architecture.md](architecture.md), sections "LUMINA Lighting (Phase 2)",
"Settings", "Performance (measured)" and "Reliability".

## Commits on lumina/phase-2

| Commit | What |
|---|---|
| `d799d99` | WASAPI capture helper (C#) and real-time audio analysis (worker thread, FFT) |
| `f624444` | Hybrid lighting engine, WebGL2 renderer, fullscreen lighting, desktop edge lighting, settings v2, tray, Lighting Settings window |
| `94b8dd5` | Fixes from live tests: frame pacing (`FrameGate`), GPU status timing, maximized windows ≠ full screen, audible capture keeps edge lighting awake, perf report |
| `7252eba` | System loopback is the default audio source; edge windows no longer block quit; docs |
| `39a98b9`, `bf27b25`, `8ca0cf4` | This handoff and its updates |
| latest | **Spotify-only capture fixed**: stream setup moved into `ActivateCompleted`, as in Microsoft's sample; verified to exclude other apps |

## Implemented and verified

| Feature | Status | How it was verified |
|---|---|---|
| Native helper `resources/lumina-helper.exe` (built from `native/lumina-helper/*.cs` with .NET Framework `csc.exe`; no SDK, runs as the user) | ✔ | Builds clean; `npm run check:audio` |
| **System (endpoint) loopback capture = default source** (kept as default at the user's request), labelled "All desktop audio (not Spotify only)" | ✔ | Live: real music analysed (bass ≈ 0.75, about 14 beat pulses per 6 s), 60 frames/s |
| **Spotify-only (process loopback) capture**, optional source "Spotify only (process loopback, ignores other apps)" | ✔ | Live, Spotify playing: follows Spotify's level (−68.5 dBFS vs −67.2 system); another app's 40 Hz tone was present in system audio (−66.1 dBFS) and absent from Spotify-only (−110.3 dBFS) |
| Analysis: FFT 2048, bass/mids/treble, adaptive normalisation, attack/release, flux transients, beat-like pulse, silence | ✔ | 20 synthetic-signal tests and live levels |
| `AudioService` lifecycle: on demand, 4 s stop delay, backoff restart, frame validation, helper released on stop and quit | ✔ | 13 unit tests; live stop/restart when a full-screen app appeared; no leftover helper after quit |
| `LightingEngine` (shared): album palette = colour, audio = motion; modes Off / Static / Ambient / Bass / Hybrid; smoothing, sensitivity, reduced motion | ✔ | 16 unit tests |
| WebGL2 renderer (half resolution, one shader, dither, readability guard, context-loss fallback) and CSS fallback | ✔ | Live WebGL at 1440p; live CSS fallback with `--disable-gpu` |
| Fullscreen player lighting (Phase 1 layout and lyric sync unchanged) | ✔ | Snapshots `player-quiet` and `player-beat-edges`; live runs with real Spotify, artwork and NetEase word timing |
| Desktop edge lighting: per-monitor transparent, click-through, non-activating tool window | ✔ | Live probe: `WS_EX_TRANSPARENT \| LAYERED \| TOOLWINDOW \| NOACTIVATE \| TOPMOST`; hit tests pass through |
| Pause in full-screen apps (borderless/F11 without a title bar, or exclusive D3D; maximized windows ignored) | ✔ | Live in both directions |
| OLED rest 60 s after music stops; hidden while the player is open; Pause Lighting as an emergency off | ✔ | Unit tests and code path |
| Settings v2 with v1 migration; tray "LUMINA Lighting" submenu; Lighting Settings window | ✔ | 17 settings tests; window compiles and renders (not visually reviewed in a capture) |
| Frame-rate targets 30/60/120/240 via `FrameGate` (average rate even when it doesn't divide the refresh rate) | ✔ | Tests; live 120 target gave 119 light FPS on a 179.9 Hz panel |

## Not working or not verified

1. **Resolved: Spotify-only capture used to deliver silence.** The cause was where the stream was set
   up: Microsoft's sample calls `Initialize`, `GetService` and `SetEventHandle` inside
   `ActivateCompleted`, and the helper called them afterwards. Moving them into the callback fixed it
   (see the verification row above and architecture.md, "Spotify-only capture: status"). **Do not
   reopen this investigation.** The evidence from before the fix, kept for the record:
   - Activation parameters are honoured: an invalid type returns `E_INVALIDARG`.
   - About 100 packets per second arrive, never flagged silent, but hold only dither (−99.7 dBFS).
   - The result is the same for the root process tree and each Spotify process on its own; for
     44.1 kHz and 48 kHz PCM and float; on MTA and STA threads; with and without `AUTOCONVERTPCM`.
   - Exclude mode, even excluding Explorer, is equally silent, while endpoint loopback of the same
     device hears the music.
   - Microphone privacy is Allow.
   - The user has a **standard output device** (no virtual or enhanced audio software), which pointed
     at the callback difference.
   - **Open follow-up: quiet playback.** Both sources capture after the app's own volume. During the
     fix test Spotify sat at about −68 dBFS, below the analysis silence threshold (−60 dBFS RMS, with
     a −72 dBFS band floor in `src/main/audio/analysis.ts`), so the light stayed dark. Consider lower
     or adaptive thresholds, and keep the synthetic tests in `tests/audio-analysis.test.ts` passing.
2. **Resolved, not a bug:** during the Phase 2 test runs Spotify started playing a few seconds after
   the lyrics screen opened and paused after the app quit. The user confirmed they were pressing
   play and pause themselves. Nothing to investigate.
3. **Not exercised live:**
   - real output-device switching (Bluetooth, USB);
   - Spotify closing and restarting during capture;
   - a second monitor (only one connected);
   - display-scaling changes;
   - a real game (full-screen detection was verified with another app's full-screen window);
   - a visual review of the Lighting Settings window (there is a `--capture-lighting=<png>` flag for it);
   - 240 Hz (the panel ran at 179.9 Hz).
4. **Known cost:** with Spotify playing, GPU-3D use (about 9%) comes from the **Phase 1 lyric
   word-fill animation** at display rate (text gradient and glow repaint), not from lighting (0.33%
   at 180 FPS). A possible optimisation: render the active-line fill more cheaply.

## Tests and measurements (latest)

| Check | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | **301/301** tests, 32 files |
| `npx electron-vite build` | Pass (worker bundled as `out/main/chunks/worker-*.js`) |
| `npm run snapshot -- --snapshot-size=2560x1440` | 21 PNGs: 4 styles × 3, 7 player shots, `edge-lighting.png` and `edge-lighting-preview.png` |
| `npm run check:audio` | Both sources capture and analyse; Spotify-only verified to exclude other apps |
| Edge overlay, WebGL, 60 target, 1440p | 59.9–60.0 FPS, p99 16.8–16.9 ms, script about 0.03 ms per frame, no long tasks |
| Player, lighting only, 240 target | 180 FPS (the panel's limit), p99 5.8 ms, GPU-3D 0.33% average |
| Player with Spotify playing, 60 / 120 target | Light 60.0 / 119.0 FPS; page 140–157 FPS; GPU-3D 9.1% / 7.7% average |
| 3-minute soak | Flat memory (browser 165→154 MB, GPU 151→155 MB, renderer 222→227 MB) |
| Audio delivery (main → renderer) | p50 0–1 ms, p99 1 ms |
| Helper CPU | 0.02–0.03% of all cores |

All measurements were taken with live **system** audio, in a throwaway profile (`TAL_PROFILE`).

## Files

**New:**
- `native/lumina-helper/{Interop,Capture,Program}.cs`
- `scripts/build-helper.mjs`
- `src/main/audio/{analysis,fft,packets,worker,worker-protocol,audio-service,create-worker}.ts`
- `src/main/ui/{edge-controller,edge-logic,fullscreen-watcher,lighting-window}.ts`
- `src/shared/{audio-frame,lighting-engine}.ts`
- `src/renderer/{edge,lighting}.html`
- `src/renderer/src/edge/main.ts`, `src/renderer/src/lighting-panel/main.ts`
- `src/renderer/src/lighting/{light-renderer,webgl-renderer,css-renderer,light-layer,frame-utils,edge-weights,perf}.ts`
- `src/renderer/src/css/{edge,lighting}.css`
- Tests: `tests/{audio-analysis,audio-service,lighting-engine,edge-lighting}.test.ts`, `tests-live/audio-capture.live.test.ts`
- Docs: this file

**Modified:**
- `src/main/{app-controller,settings,snapshot,index,paths}.ts`
- `src/main/ui/{stage-controller,tray,windows}.ts`
- `src/shared/{lighting,ipc,types}.ts`, `src/preload/index.ts`
- `src/renderer/src/player/player-view.ts`, `src/renderer/src/stage/{main,frame-gate}.ts`, `src/renderer/src/stage/styles/types.ts`
- `src/renderer/src/ambient/drive.ts` (`albumDrive` removed, superseded), `src/renderer/src/css/player.css`
- `electron.vite.config.ts`, `package.json` (`pre*` helper build, `build:helper`, `check:audio`), `scripts/package-win.mjs` (ships the helper), `.gitignore` (the helper exe), `.github/workflows/ci.yml`, `tsconfig.node.json`, `vitest.live.config.ts`
- `README.md`, `docs/lumina/architecture.md`
- `tests/{settings,player-state}.test.ts`

## Exact next steps

1. **Quiet playback:** make the analysis respond at low app volume (about −70 dBFS). Lower or adapt
   `silenceDb` / `noiseFloorDb` in `src/main/audio/analysis.ts`, adjust `tests/audio-analysis.test.ts`
   as needed, and confirm with `npm run check:audio` while Spotify plays quietly.
2. Ask the user whether **Spotify only** should become the default source. They asked to keep All
   desktop audio as the default for now. Changing it means editing `DEFAULT_SETTINGS.audioSource` in
   `src/main/settings.ts`, its test, and the docs. The helper also supports `auto` (Spotify while it
   runs, otherwise system audio) if a fallback default is wanted.
3. Have the user review the Lighting Settings window (`npm run dev`, tray → LUMINA Lighting →
   Lighting Settings…) and the edge glow on their desktop; tune defaults if needed.
4. Live checks not yet done: Bluetooth or USB device switching, Spotify close/restart during
   capture, a real full-screen game, a second monitor if available.
5. Optional optimisation: a cheaper Phase 1 active-line word fill (the main GPU cost while playing).
6. When the user approves: push `lumina/phase-2` and open a pull request (ask first).

## Commands to resume

```bash
cd C:\Users\osama\Desktop\lumina
git switch lumina/phase-2
git log --oneline -5
npm ci
npm run build:helper
npm run typecheck
npm test
npm run dev
npm run check:audio
npm run snapshot -- --snapshot-size=2560x1440
```

`npm ci` is only needed if `node_modules` is missing. `npm run dev` starts the app (tray →
LUMINA Lighting). Play something first for `npm run check:audio`, which prints live levels for
both sources.

**Debug runs** use a throwaway profile so your settings aren't touched:
- `TAL_PROFILE=<dir> npx electron . --open-lock-after=2500 --perf-after=6500 --perf-window=12000 --perf-file=<json> --quit-after=20000`
- `--edge-probe-after=<ms>` logs the edge window handles; then run
  `resources\lumina-helper.exe probe <hwnd> <x> <y>` to check styles and click-through.
- `--capture-lighting=<png>` saves the Lighting Settings window.
