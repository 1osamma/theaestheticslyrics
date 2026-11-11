# LUMINA Lyrics handoff

State at handoff (2026-11-11): branch **`lumina/lyrics`**, created from `lumina/phase-2` @ `49639d2`,
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
| (this commit) | Font notices, architecture docs, this handoff |

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
- 240 FPS is **not** claimed for page frames. The display ran at 239 Hz; compositor animations
  follow vsync, but no per-compositor-frame counter was recorded.

## Not done or not verified

- Live check of Fade, Glow, Scale and Minimal with a real song, and of a seek or a font switch
  during playback (Smooth Fill and Expressive passed live; all six passed in snapshots).
- The new animations in the always-on desktop overlay (decision 3): not started.
- Not tried: seek-heavy use, very long lines that wrap to three lines, right-to-left scripts, and
  CJK lyrics in Fraunces (it has no CJK glyphs, so the system fallback font is used).
- Possible further GPU savings, not tried: drop the feathered mask while a word is not sweeping,
  or share one glow layer per line.

## Exact next steps

1. Optionally, with a song playing, live-check the remaining effects, a seek and a font switch
   (commands below). Fix only real issues.
2. If the user wants, bring the effects to the always-on overlay (`src/renderer/src/stage/`), with
   the same `lyric-timeline.ts` plans. Fullscreen remains the priority.
3. **Ask** before pushing `lumina/lyrics`, merging, opening a PR or releasing.

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
- `--capture-lighting=<png>` saves the settings window: the Lyrics tab to `<png>`, the Lighting
  tab to `<png>-lighting.png`.

## Continuation prompt

> Continue LUMINA on branch `lumina/lyrics` in `C:\Users\osama\Desktop\lumina` (my fork
> `1osamma/theaestheticslyrics`). Read `docs/lumina/LYRICS_HANDOFF.md` first. Lyrics and text
> effects are the priority, not lighting. Next: live-check the remaining lyric effects (Fade, Glow,
> Scale, Minimal), a seek and a font switch with real Spotify word timing (I'll play a song), fixing
> only real issues. Then ask me before starting the desktop-overlay version. Run typecheck, tests and the build, commit locally, and don't push,
> merge or open a PR without asking me.
