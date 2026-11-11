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
   - The very low levels in the fix test (about −68 dBFS) were Spotify's volume at 1%. At normal
     volume (above 50%) the analysis works as designed, so the thresholds are **unchanged** (see
     "Spotify at normal volume" below). Captures follow the app's own volume, so a near-silent
     Spotify gives a dark light by design.
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
4. **Resolved (2026-11-11): the lyric word fill was the main GPU cost while playing.** It is now
   compositor-only; see "Word-fill optimisation" below.

## Spotify at normal volume (final live check)

Spotify playing above 50% volume. Both sources captured **at the same moment** with
`npm run check:audio`, which runs `tests-live/{audio-capture,lighting-compare,spectrum}.live.test.ts`.

| Check | Spotify only | All desktop audio | Verdict |
|---|---|---|---|
| Analysis, 8 s | bass 0.65 · mids 0.73 · treble 0.00 · intensity 0.58 · 9 beats · 63/477 silent | bass 0.65 · mids 0.73 · treble 0.00 · intensity 0.59 · 9 beats · 45/476 silent | ✔ identical when nothing else plays |
| Octave spectrum (dBFS, 63 Hz → 16 kHz) | −65 −44 −41 −49 −52 −65 −79 −90 −88 | −65 −44 −42 −49 −53 −65 −79 −92 −89 | ✔ within 1–2 dB in every band: no loss in process loopback |
| Isolation | earlier run: treble 0.00, 14 beats | same run: treble 0.59, 22 beats | ✔ another app's sound reached system audio only |
| Silence detection | quiet passage: about 1 s of silent frames; Spotify paused: 100% silent | — | ✔ |
| Hybrid lighting at default settings, driven by the live Spotify frames | atmosphere 0.19–0.40 (ceiling 0.45), bloom 0.03–0.39 | — | ✔ follows the music, stays OLED-friendly |

- **Treble reads 0 for this track** because its content above 4 kHz sits at about −79 to −90 dBFS,
  below the −72 dBFS band floor. That's correct for the song, not a capture fault.
- No analysis, sensitivity or threshold changes were made.

## Live visual testing (2026-11-11)

Real app, throwaway profile, Spotify playing "Don't Let Me Go" (Cigarettes After Sex, greyscale
cover "Cry"), default source All desktop audio, default lighting settings. Light levels come from
the pages' own counters (`lightLevels` in the `--perf-file` report).

| Check | Result |
|---|---|
| **Fullscreen player**, 10 s | WebGL; light 59.8 FPS at the 60 target while the page ran 228 FPS (lyric word fill at the panel's rate); no long tasks; GPU-3D 3.2% avg / 7.3% max; audio 60 frames/s, 9 beat pulses |
| Player light response | bloom median 0.25, p95 0.42, max 0.46 (moves with the music); atmosphere 0.42–0.44 (steady loudness, by design); cover sharp, lyrics word-synced and readable, light restrained to soft grey for the greyscale cover |
| **Desktop edge lighting**, 10 s | WebGL 60.0 FPS, frame p99 16.8 ms, script 0.06 ms per frame, no long tasks, GPU-3D 2.0% avg / 4.1% max; bloom 0.23–0.45, edge glow 0.54–0.70 with the music |
| Edge window behaviour | Re-probed: `WS_EX_TRANSPARENT | LAYERED | TOOLWINDOW | NOACTIVATE | TOPMOST`, hit test passes through to the window underneath |
| **Fixed:** faint rectangle at the end of the edge glow | The overlay shader hard-cut light below 1.5/255 to transparent, which drew a one-code-value edge about 150 px in. It now fades the last few code values out (`smoothstep`) in `src/renderer/src/lighting/webgl-renderer.ts`; the live re-capture shows a smooth falloff. |
| **Lighting Settings window** | Reviewed in a capture: live status (audio mode, edges, renderer), mode selector, toggles and sliders all show the saved state. **Fixed:** the light system scrollbar now matches the dark panel (`lighting.css`). |

**Colourful album** (same day): Kanye West, "I Wonder" (*Graduation*, a vivid pink and purple cover).

| Check | Result |
|---|---|
| Fullscreen player, 10 s | Violet-magenta light from the cover, bloom behind the art; the Spotify dot, progress bar and active-word glow take the pink accent; lyrics column stays readable. WebGL, light 59.8 FPS, no long tasks; 24 beat pulses in 10 s (vs 9 for the slow song); bloom median 0.34, p95 0.40 |
| Edge lighting, 10 s | Magenta and violet glow on the left, right and bottom, smooth falloff, centre untouched; WebGL 59.8 FPS, frame p99 16.8 ms, no long tasks; bloom median 0.29 (max 0.44), edge 0.57 (max 0.70). A quieter section lowered the atmosphere average to 0.37 (median 0.41), so quiet passages go darker as designed |

New debug tools used for this (kept):
- `--capture-series=<prefix> --capture-start=<ms> --capture-every=<ms> --capture-count=<n>` saves
  the visible lyrics screen as `<prefix>-stage-N.png`, and each edge window as `<prefix>-edge-N.png`
  plus `<prefix>-edge-N-preview.png` (composited over a dark desktop, no screenshot of the real
  desktop).
- The `--perf-file` report includes `lightLevels` (atmosphere, bloom, edge stats).

## Word-fill optimisation (2026-11-11)

**Before:** the word being sung was a `background-clip: text` gradient whose stop moved every frame
(`--p`), inside a `filter: drop-shadow`. At 239 Hz that repainted the word and re-ran the blur filter
on every refresh.

**After** (`src/renderer/src/player/lyric-lines.ts`, `.lm-fill*` in `player.css`):
- Words in the active line are plain coloured text. Sung words are white and upcoming ones dimmed
  (`.is-ahead`), and classes change once per word, never per frame.
- The word being sung is hidden (`.is-held`). One overlay, placed over it inside the line, holds:
  - a dimmed copy;
  - a weak underglow;
  - a white copy with the strong glow, inside a clip window with a 0.45em feathered mask edge.
- Each frame only translates the window and counter-translates its text: two transforms, applied by
  the compositor with no repaint, no filter and no layout. Layout is read once per word (position,
  width).
- The overlay lives in the line element, so it follows the line's scale and fade transitions. The
  sweep edge lands where the old gradient put it (progress × (word + feather) − feather), and the
  glow strength matches the old drop-shadow (strong on sung letters, weak on dimmed ones).
- Snapshots of the same moment before and after are visually the same (edge at "ro|ad", same
  glow, layout and typography).

**Benchmark:** fake player and fixture LRC for identical, continuous word fill; the real app; 12 s
window; per-process GPU-3D counters. One run each.

| Benchmark (fixture lyrics, 239 Hz, 2560×1440) | Before | After |
|---|---|---|
| Lyrics only: GPU-3D avg / max | 3.78% / 19.6% | **0.93% / 4.3%** |
| Lyrics + lighting: GPU-3D avg / max | 6.58% / 23.0% | **3.11% / 13.9%** |
| Lyrics + lighting: worst frame interval | 20.8 ms | **16.8 ms** |
| Renderer CPU / GPU-process CPU (lyrics + lighting) | 1.22% / 2.01% | 0.74% / 1.44% |
| Frame interval p50 while a word fills | 4.2 ms (239 Hz) | 4.2 ms (239 Hz) |
| Long tasks | 0 | 0 |

**On 240 Hz:** while a word fills, the page draws on every refresh of the 239 Hz panel (p50 4.2 ms).
The page averages 173–186 FPS rather than 239 because the loop slows down between words and in gaps,
by design. That isn't a sustained 240 FPS.

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

1. (Done: the live check at normal volume passed; thresholds are unchanged.)
2. **Decided:** the user chose to keep **All desktop audio** as the default source, after Spotify-only
   was verified working. Don't ask again. Spotify only stays available in Lighting Settings. If this
   ever changes, edit `DEFAULT_SETTINGS.audioSource` in `src/main/settings.ts`, its test, and the docs.
3. (Done 2026-11-11: live visual tests of the fullscreen lighting, the edge overlay and the
   Lighting Settings window, with a greyscale and a colourful album; two small visual fixes. See
   "Live visual testing".)
4. Live checks not yet done: Bluetooth or USB device switching, Spotify close/restart during
   capture, a real full-screen game, a second monitor if available.
5. (Done 2026-11-11: compositor-only word fill; see "Word-fill optimisation".) Optional: repeat the
   benchmark a few times for variance, and re-check live with Spotify, `--capture-series` and
   `--perf-file`.
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
- Run A (player): `--open-lock-after=2500 --perf-after=4000 --perf-window=10000 --perf-file=<json> --capture-series=<prefix> --capture-start=15000 --capture-every=700 --capture-count=6 --quit-after=21000`
- Run B (edge, settings `{"version":2,"edgeLighting":true}`): `--edge-probe-after=3000 --perf-after=3500 --perf-window=10000 --perf-file=<json> --capture-series=<prefix> --capture-start=14500 --capture-every=600 --capture-count=6 --quit-after=22000`
