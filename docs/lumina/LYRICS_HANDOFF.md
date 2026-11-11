# LUMINA Lyrics handoff

State at handoff (2026-11-11, updated after the performance and sync work): branch **`lumina/lyrics`**, created from `lumina/phase-2` @ `49639d2`,
**local only (not pushed)**. `main` is untouched. Nothing is merged, and there is no pull request or
release. **Ask the user before pushing, merging, opening a PR or releasing.**

The user's priority (their words): synchronized lyrics and text effects are the most important
feature, *not* the ambient lighting. Lighting stays as it is; don't expand it unless necessary.

Full technical detail: [architecture.md](architecture.md), sections "LUMINA Lyrics" and "Settings".
Phase 2 history: [PHASE2_HANDOFF.md](PHASE2_HANDOFF.md).

## Approved design decisions (from the user)

1. Smooth Fill is the default effect.
2. Bundle 1–2 open-source fonts with verified redistribution licences alongside Inter. Done:
   Manrope and Fraunces, SIL OFL 1.1, licence files checked in `node_modules/@fontsource-variable/*/LICENSE`.
3. The new animations should eventually work in the always-on desktop overlay, but fullscreen
   comes first. **Not started.**
4. Benchmark the original Fisheye and Visual styles and improve them only where it helps, without
   changing their look. Done: both measured healthy, so neither was changed (numbers below).

Further priorities: lyrics are the visual centrepiece. Motion should be fluid, expressive and
musical, not generic CSS effects. Keep the sync and the existing four styles. Make every style
selectable and customisable. Readability beats heavy glow. Target the 2560×1440 240 Hz OLED.
Keep a reduce-animations option.

## Commits on lumina/lyrics

| Commit | What |
|---|---|
| `4adecaf` | LUMINA Lyrics: compositor word animations, six effects, spring line motion, typography (Inter, Manrope, Fraunces), settings with migration, tray submenu, settings-window Lyrics tab with live preview, per-effect snapshots |
| `ffc38c8` | Word animations created just in time (350 ms ahead) and finished words rested statically (less GPU, same look) |
| `c48b015` | Font notices, architecture docs, this handoff |
| `6bb2e5a` | **Sync fix**: word animations locked to the song clock with `startTime` (no late start while pending, no auto-rewind after a pin); measured-drift re-pin; drift counters; trace and effect-cycling debug flags |
| `098d9cd` | Performance findings and status in this handoff |
| (latest, `git log -1`) | Session-end handoff: proposed effect ideas, next steps. Working tree clean. |

## What was built

| Piece | File |
|---|---|
| Lyrics config types, defaults, settings sanitising and migration, patch filter | `src/shared/lyrics-style.ts` |
| Keyframe plans per effect, critically damped spring, motion presets | `src/renderer/src/player/lyric-timeline.ts` |
| Renderer: overlays, compositor scheduling, re-pinning, spring scroll, typography | `src/renderer/src/player/lyric-lines.ts` |
| Overlay and typography CSS | `src/renderer/src/css/player.css` (`.lm-fill*`, `--lm-lyric-*`) |
| Settings fields (`lyricEffect` … `lyricColor`) | `src/main/settings.ts` |
| Tray → LUMINA Lyrics | `src/main/ui/tray.ts` |
| Settings window: Lyrics and Lighting tabs; live preview | `src/renderer/src/lighting-panel/lyrics-section.ts`, `main.ts`, `css/lighting.css`; `src/main/ui/lighting-window.ts` (`pickPanelPatch`) |
| Snapshots `lyrics-*.png` | `src/main/snapshot.ts` |

Effects: Smooth Fill, Fade, Glow, Scale, Expressive, Minimal. Options: intensity, transition speed
(Relaxed, Balanced, Snappy), font, weight, alignment, line spacing, colour (white or album-tinted),
Reduce animations (forces Minimal and no drift). The old `animation` setting (low/medium/high)
migrates to intensity 35/60/90%.

## Verified

- `npm run typecheck` clean. **322 tests pass** (301 before; +15 timeline, +4 settings, +2 helpers).
  `electron-vite build` OK.
- Snapshots (1536×864) of every effect mid-word, Manrope Extra Bold Expressive at maximum, Fraunces,
  centred, and Fraunces + centred + album colour + airy: all render correctly.
- Two bugs found by snapshots and fixed: overlays placed before a new font loaded (now wait for
  `document.fonts.load`), and overlays inheriting `text-align: center` (sung copy shifted by about 0.2em).
- Settings window captured on both tabs (`--capture-lighting`): the live preview plays the
  selected effect, and the Lighting tab is unchanged.
- **Live with real Spotify** ("I Wonder", NetEase native word timing, 2560×1440): capture series
  with Smooth Fill and with Expressive. Words sweep mid-word in time with the song, the interlude
  dots appear near the end, and the song restarting from 0:00 rebuilds cleanly. Perf windows: no
  long tasks, frame interval max 29 ms (Fill) and 21 ms (Expressive), with lighting at 60 FPS.

## Benchmarks (2026-11-11, RTX 4070 SUPER, 2560×1440 at 239 Hz)

Method: `bench.sh` in the session scratchpad. It runs the real app with the fake player
(`scripts/fake-player`) and the fixture `tests/fixtures/original-song.lrc`, and takes a 12 s perf
window (page `requestAnimationFrame`) and Windows GPU-3D counters. The baseline is the
`lumina/phase-2` build (49639d2), rebuilt and measured in the same session.

| Build | Lighting | Page FPS | Frame interval p50 | Script p99 | Long tasks | GPU-3D avg / max |
|---|---|---|---|---|---|---|
| phase-2 baseline | on (hybrid 60 FPS) | 184.9 | 4.2 ms | 0.5 ms | 0 | 3.52% / 15.7% |
| phase-2 baseline | off | 175.2 | 4.2 ms | 0.4 ms | 0 | 0.65% / 5.2% |
| lyrics, Smooth Fill | on | 92.6 | 16.6 ms* | 0.5 ms | 0 | 4.23% / 14.1% |
| lyrics, Smooth Fill | off | 66.9 | 4.2 ms | 0.7 ms | 0 | 2.88% / 10.1% |
| lyrics, Expressive at 100% | off | 66.3 | 4.2 ms | 0.5 ms | 0 | 2.34% / 11.4% |
| lyrics, Minimal | off | 64.8 | 4.2 ms | 0.4 ms | 0 | 1.89% / 10.5% |
| Lyrics Only: Fisheye (unchanged) | off | 112.2 | 4.2 ms | 0.9 ms | 0 | 2.27% / 8.6% |
| Lyrics Only: Visual (unchanged) | off | 182.4 | 4.2 ms | 0.2 ms | 0 | 1.74% / 5.2% |

\* With lighting on, the idle loop runs at the light's 60 FPS. While lines move it runs at the
full 239 Hz, and the words themselves run on the compositor at refresh rate either way.

How to read it:
- The main thread now draws far fewer frames (page FPS 175 → 67 without lighting), because words
  no longer need main-thread frames; only line moves do. No long tasks in any run.
- GPU-3D is higher than the baseline (+0.7 points with lighting, +2.2 without) but low in absolute
  terms (under 5% average on this GPU). Most of the remaining cost is composited text layers, not
  motion: Minimal, which barely animates, already costs 1.9%. The just-in-time change took 1 point
  off. Each figure is a single run, so expect roughly ±0.3 points of noise.
- Page FPS counts main-thread frames only; what the screen gets is measured below from a trace.

## Performance investigation (2026-11-11): verified results

The user confirmed the animations look smooth on the 1440p 240 Hz OLED in real use, and asked to
stop chasing benchmark differences unless there is a confirmed visible problem. These are the
findings up to that point.

**Why page FPS fell from 175 to 67: less JavaScript, not fewer frames.** In `lumina/phase-2` the
main thread moved the sweep (`transform`) every frame and reported itself busy while a word was
being sung, so the loop ran at refresh rate. Now the compositor plays the sweep and the loop
idles between line moves. A Chromium trace (`--trace-after/--trace-window/--trace-file`, analysed
with `PipelineReporter` and `Graphics.Pipeline.DrawAndSwap`) shows what the screen actually gets:

| Measure (fixture song, lighting off, 239 Hz) | Result |
|---|---|
| Frames presented while words animate, on consecutive refreshes | **99.8–100%** (three runs: 1702/1702, 2753/2756, 2760/2766) |
| Swap-to-swap interval while drawing | p50 4.17 ms, p99 4.2–4.26 ms (= 239 Hz) |
| Dropped frames while a word animation runs | 0–1 per 10 s (startup traces including window opening: ~60 per 17 s) |
| Other dropped frames | ~20–30 per 10 s, all idle main-thread frames (`has_compositor_animation: false`), with nothing moving on screen |
| Drawing work per frame (render-pass record + replay) | phase-2 ≈ 220 µs, now ≈ 270 µs; render passes per frame 2.4 → 4.3–4.6 |

The extra render passes are the small feathered-mask surfaces of the words currently animating.
GPU-3D counters at this level (about 1–3%) vary more between runs than between variants. An A/B of
removing the mask, the glow layer, the sung-copy shadow or the line transitions showed no
difference beyond that noise, so none of those were removed and the look is unchanged.

**Sync, measured (not assumed).** A running word animation's own clock is compared with the song
clock every frame (`lyricSyncDriftMs` in the perf report). That counter found two real bugs, fixed
in `6bb2e5a`: words could start up to ~170 ms late when a line was scheduled while the page loop
idled, and a pin could replay an already-swept word. After the fix: **drift p50 0.3 ms, max 0.9 ms,
no corrective re-pins** over 10 s.

**Environment notes.** Two of about ten traces showed swaps at 8.3 ms (120 Hz) and 2.7 ms
SwapBuffers stalls; repeats of the same build were clean. Brave and Wallpaper Engine were busy on
the PC at the time, and DWM or another GPU client is the likely cause; it was not pursued.
An experiment to shorten the animation lookahead (350 → 120 ms, fewer mask surfaces) was stopped
before it was measured and is **not** in the code.

## Not done or not verified

- **Not done:** a live Spotify pass of Fade, Glow, Scale and Minimal, and of seeking, pausing,
  resuming and switching effects mid-song. Smooth Fill and Expressive passed live, all six passed
  in snapshots, and the pause, resume and seek paths go through the re-pin code fixed and measured
  in `6bb2e5a`. Tools are ready: `--cycle-effects=<ms>` switches effects mid-song. Pause and seek
  need driving Spotify through Windows media controls, which the app itself doesn't do.
- The new animations in the always-on desktop overlay (decision 3): not started.
- Not tried: seek-heavy use, very long lines that wrap to three lines, right-to-left scripts, and
  CJK lyrics in Fraunces (it has no CJK glyphs, so the system fallback font is used).
- Possible further GPU savings, deliberately not pursued (no visible problem): a shorter animation
  lookahead, or sharing one glow layer per line.

## Windows packages (2026-11-11)

`npm run dist` (electron-builder 26.17.0, config `electron-builder.yml`, installer page
`build/installer.nsh`) writes to `release/`:
- `LUMINA-Portable-1.0.1-x64.exe`: single file, no install (unpacks to a temp folder on each start).
- `LUMINA-Setup-1.0.1-x64.exe`: per-user installer with a choice of folder and optional desktop and
  Start menu shortcuts ("LUMINA"); launches after install; uninstall keeps settings.
Both use `%APPDATA%	heaestheticslyrics`, the same settings as before. Not code-signed, so
SmartScreen shows "More info → Run anyway". The media bridge runs Windows' built-in PowerShell
(part of Windows 11, nothing to install).
Verified: the portable EXE started with a throwaway profile, detected Spotify, found NetEase word
timing, rendered the player, started audio capture with the bundled helper, opened the settings
window and quit cleanly. **Not run:** the installer itself (it creates shortcuts and an uninstall
entry), the overlay and edge lighting in the packaged build, and "Start with Windows" from the
portable EXE.

## Phase 4: lyrics synchronization and reliability (2026-11-11)

**Roadmap (agreed with the user):** Phase 4 sync and reliability (this). Next, **Phase 5 (needs
approval):** a resizable windowed full lyrics player, a transparent movable text-only lyrics
window, and consistent lyric styles across fullscreen and both windowed modes. Later: adaptive
album/wallpaper lyric colours, Windows integration, final release. **Desktop edge lighting is
dropped:** don't develop it further. Keep the fullscreen album-colour atmosphere.

Investigated, measured, and sorted into source problems and app bugs:

| Area | Finding | Kind |
|---|---|---|
| Spotify position (Windows media session) | Published about every 4.5 s; each sample agrees with the previous one to ±7–16 ms. Interpolating from its `updated` stamp is accurate. | OK |
| Pause | Paused position correct, but stamped ~600 ms after it took effect: the clock overshoots, then snaps back while paused. | Spotify quirk, cosmetic |
| Seek | First reports the target position at the seek moment, then ~121 ms back once audio resumes; the clock glides corrections under 250 ms. | Spotify quirk, handled |
| **Line handover (fullscreen)** | The next line takes focus `leadMs` (140–260 ms) early, and the outgoing line's animations were torn down at that moment, so its last word snapped to "sung" early. Measured on 11 cached real songs: 14–50 lines per song, median 170–200 ms early. | **App bug, fixed** |
| NetEase vs LRCLIB line starts | Per-song median offset from −380 to +510 ms, spread up to 510 ms; some songs agree within 20–30 ms. The app can't tell which source is right. | **Source data** |
| Fast words | Up to 24% of words are under 120 ms (Touch); timestamps are kept exactly. | Source (fine) |
| Text-only styles (Ship, Fisheye, Visual) | Words pop at their own start; the loop wakes before each word; entrances shorten for fast words. No bug found. | OK |
| Parsers | NetEase word stamps are absolute, LRC `[offset:]` is applied, estimated lines are capped before instrumentals. | OK |

Fix (`src/renderer/src/player/lines.ts` `stillSinging`, `lyric-lines.ts`): the outgoing line
keeps animating, and stays lit and full size, until its last word ends, while the scroll still
leads. Then it fades and its glow releases. Seeks drop it.

Tests: `tests/sync-regression.test.ts` (13). It covers the recorded Spotify timelines (steady
playback, pause, resume, seek with buffering correction, track change), line handover (contiguous,
slow, seek), fast words through the timing builder and every effect, and text-only word picking.
335 tests pass, typecheck is clean, the build succeeds.

Live (real Spotify, "Creep", NetEase word timing): all six effects switched every 3 s mid-song
(`--cycle-effects`), with a pause, a resume and two seeks driven through Windows media controls
(`spotify-ctl.ps1` in the session scratchpad: TryPause/TryPlay/TryChangePlaybackPosition). Drift
p50 0.3 ms, max 14.6 ms; re-pins: 13 line, 2 play-state, 8 clock (seeks and Spotify corrections);
no long tasks or errors; screenshots correct after the seek.

**Remaining (source data):** a song whose lyric source is offset is still offset; the global
timing offset (tray) is the only correction today. Possible next step: a per-song offset nudge
(e.g. hotkeys ±100 ms, remembered per track), or preferring the source that agrees with the other.
Not covered: Bluetooth output latency (use the timing offset), Apple Music timelines, and a
packaged-build rerun of these checks.

## Exact next steps

0. **Phase 4 is done** (sync fix and tests above). Ask the user before starting Phase 5 (windowed
   player, transparent text-only window, consistent styles). The effect ideas below are for later.
1. **Earlier priority, now after Phase 5: the visual quality, creativity and customisation of the lyric
   text effects** (not lighting, not benchmark numbers). Proposed at session end, and **awaiting
   the user's choice**:
   - New effects: Letter Cascade (letters light and lift one by one within the sung word),
     Focus Pull (blurred-copy crossfade into sharp), Neon Outline, Wave, Pop-in.
   - For all effects: held-note bloom, active-line emphasis and depth, backing vocals in
     parentheses shown smaller and dimmer, richer interludes, optional 3D line transitions.
   - Customisation: glow colour, glow size, sweep softness, contrast, active-line size, letter
     spacing and case, column position, presets (Apple-like, Neon Club, Cinematic Serif, Calm,
     custom).
   - Recommended first batch: Letter Cascade, held-note bloom, active-line emphasis, glow colour
     with sweep softness and contrast controls, and presets. Keep the existing six effects
     unchanged; use transform and opacity only; update the live preview and snapshots.
2. When convenient, live-check the remaining effects with seeks, pauses and mid-song effect
   switches (commands below). Fix only visible issues.
3. Only when the user asks: bring the effects to the always-on overlay (`src/renderer/src/stage/`), with
   the same `lyric-timeline.ts` plans. Fullscreen remains the priority.
4. **Ask** before pushing `lumina/lyrics`, merging, opening a PR, releasing or starting a new phase.

## Commands to resume

```bash
cd C:\Users\osama\Desktop\lumina
git switch lumina/lyrics
git log --oneline -5
npm run typecheck
npm test
npm run dev
npm run snapshot
```

- Tray → LUMINA Lyrics → Lyrics Settings… opens the settings window on the Lyrics tab.
- Live capture with a throwaway profile (play a song in Spotify first):
  `TAL_PROFILE=<dir> TAL_NO_LOCK=1 npx electron . --open-lock-after=2500 --perf-after=4000 --perf-window=10000 --perf-file=<json> --capture-series=<prefix> --capture-start=6000 --capture-every=700 --capture-count=8 --quit-after=14000`
  To test an effect, put `{"version":2,"lyricEffect":"expressive"}` in `<dir>/settings.json` first.
- Sync and frames: add `--perf-after=6000 --perf-window=10000 --perf-file=<json>` (see
  `lyricSyncDriftMs`, `lyricRepins`) and `--trace-after=6000 --trace-window=10000 --trace-file=<json>`
  (allow about 8 s after the window for the trace to be written before `--quit-after`).
  `--cycle-effects=4000` switches the effect every 4 s.
- `--capture-lighting=<png>` saves the settings window: the Lyrics tab to `<png>`, the Lighting
  tab to `<png>-lighting.png`.

## Continuation prompt

> Continue LUMINA in `C:\Users\osama\Desktop\lumina` (branch `lumina/lyrics`, my fork
> `1osamma/theaestheticslyrics`). Verify the branch, latest commit and a clean tree, then read
> `docs/lumina/LYRICS_HANDOFF.md` and `docs/lumina/architecture.md`. Phase 4 (lyrics sync and
> reliability) is complete. Don't develop desktop edge lighting; keep the fullscreen album-colour
> atmosphere and the current lyric styles. Next milestone, **only after I approve**: Phase 5:
> a resizable windowed full lyrics player, a transparent movable text-only lyrics window, and
> consistent lyric styles across fullscreen and both windowed modes. Run typecheck, tests and the
> production build; commit locally; don't push, merge or start a new phase without asking me.
