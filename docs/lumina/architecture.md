# LUMINA architecture (Phase 1)

LUMINA extends theaestheticslyrics. It adds a full-screen music player to the existing tray app,
plus the groundwork for ambient lighting. Everything the original app did still works the same way:
the four lyric styles, the always-on overlay, the lock-style screen, the lyrics sources and cache,
timing offset, monitor choice, tray and hotkey.

## How data flows

```
Spotify / Apple Music
   │  Windows media sessions (SMTC), read only
   ▼
resources/smtc-bridge.ps1 ──JSON lines──▶ src/main/media/watcher.ts
                                            │ track · anchor · artwork events
                                            ▼
                                   src/main/app-controller.ts
             ┌───────────────┬──────────────┼──────────────────┬──────────────┐
             ▼               ▼              ▼                  ▼              ▼
     lyrics/service.ts  palette/extract  palette/ambient  settings.ts    ui/tray.ts
     (local → cache →   (lyric colours)  (ambient light)  (settings.json)
      LRCLIB + NetEase)
             └───────────────┴──────┬───────┴──────────────────┘
                                    ▼
                         src/main/ui/stage-controller.ts
                    lock window (full screen) · overlay window (click-through)
                                    │ IPC: stage:state · stage:anchor · stage:artwork
                                    ▼
                         src/renderer/src/stage/main.ts  (one frame loop)
                    ┌───────────────┴────────────────┐
                    ▼                                ▼
         styles/* (Ship, Fisheye,          player/player-view.ts (LUMINA player)
          Fisheye Visual, Visual)            ├─ ambient/ambient-layer.ts
                                             ├─ player/lyric-lines.ts
                                             └─ track info, progress, art card
```

- **Playback state and animation are kept apart.** The bridge polls SMTC every 250 ms. The main
  process forwards a *playback anchor* (position, the time it was true, playing, rate) only when it
  changes by more than 40 ms. The renderer works out the song position for every frame from that
  anchor (`stage/clock.ts`), so the frame rate never adds IPC traffic.
- **Artwork is sent once per track.** The main process decodes the cover once. It takes the lyric
  palette and the ambient palette from a 64×64 copy, re-encodes the cover as a JPEG of 1024 px at
  most, and sends it only to the lock-style window on `stage:artwork`. The overlay never receives it.
- **Security is unchanged.** Every window still runs with `contextIsolation`, `sandbox` and no Node
  integration, behind the existing CSP. The only new renderer API is `stage.onArtwork`, a
  subscription added to the existing preload bridge. Track text is written with `textContent`,
  never as HTML.

## The full-screen player

Tray → **Full-Screen View** picks what the lyrics screen shows:

- **LUMINA Player** (the default): album art, track info, progress and synced lyrics over ambient light.
- **Lyrics Only (style)**: the original full-screen view in the chosen style, with the lock-screen clock.

The overlay (**Show Lyrics → Always**) always uses the chosen style. The player only exists in the
full-screen window.

| Piece | File | Notes |
|---|---|---|
| View | `src/renderer/src/player/player-view.ts` | Implements the same `StageStyle` interface as the styles, so the existing loop, snapshot mode and settings flow drive it unchanged. |
| Lyrics | `src/renderer/src/player/lyric-lines.ts` | One span per timed word. `--p` sweeps the sung part across the word using its real (NetEase, Enhanced LRC) or estimated timing. Only the word being sung changes per frame. Lines fade and recede with CSS transitions, and the column scrolls with one transform. |
| Pure logic | `player/lines.ts`, `player/format.ts`, `player/chrome-fader.ts` | Line segmentation (keeps punctuation), focus and interlude detection, word fill, opacity rules, time formatting, chrome fade timing. All unit-tested. |
| Tokens | `src/renderer/src/css/tokens.css` | Surfaces, text tiers, accents, type scale, spacing, radii and motion. |
| Styles | `src/renderer/src/css/player.css` | Layout for landscape, with a stacked layout for narrow or portrait screens (aspect ≤ 5:4). |

### Edge cases

| Situation | What happens |
|---|---|
| Spotify closed / nothing playing | The "Waiting for music" screen, lit by the lyric colours. |
| Paused | A "Paused" pill appears. The light dims to about 72% and slows. Lyrics and progress hold still, and the loop drops to its idle rate. |
| Track skipped | The art crossfades, track info and lyrics rise in, and the light crossfades to the new palette over 1.4 s. |
| No album art | The card waits 1.2 s for late art, then shows an original gradient placeholder. The light uses the lyric colours. |
| Spotify album art | Spotify's Store app publishes its cover to SMTC as a **300×300 PNG**. That is all Windows provides without signing in to Spotify's Web API, which LUMINA does not do, so on a 1440p screen the cover is shown about 2× enlarged. The bridge reads the thumbnail through reflection: PowerShell cannot resolve the stream class Spotify returns and would otherwise drop the art. Art-read failures go to the log once per track (`bridge: Album art unreadable …`). Each cover that arrives is logged as `artwork: 300×300 image/png`. |
| No synced lyrics | The art and progress stay. The lyrics column says *Finding lyrics…*, *No synced lyrics for this song*, *Instrumental* or *Lyrics are unavailable right now*. |
| Instrumental break (≥ 4 s) | The last line dims and three dots breathe in the gap. |
| Window resize / display change | The layout uses viewport units, and lyric positions are measured again when the size changes. |
| No GPU compositing | Detected at startup with `app.getGPUFeatureStatus()`. The player drops its grain, art glow and word glow, and the light holds still. |
| Reduced motion | Tray → Player → **Reduce Motion**, or Windows' *Animation effects* off. Drift, scrolling, lift, glow, recede and rise-in all stop. |

### Playback controls

The media bridge only **reads** SMTC (title, artist, timeline, artwork), so the player shows no
play, pause or skip buttons, because they would not work. Adding them means sending SMTC commands
from the bridge (see Phase 2). The only interactive chrome today is a top bar (brand, source app,
"Esc to close") and the cursor. Both appear on mouse movement in watch-only sessions and fade
after 2.6 s. On screens that close on any input, they never appear.

## Ambient lighting

### Approach: CSS gradient layers on the GPU, moved by the existing frame loop

| Option | Verdict |
|---|---|
| **WebGL2 fragment shader** | Gives the richest look (mesh gradients, noise fields), but needs a context, handling for a lost context, a fallback without a GPU, and shader code to maintain. It also shades every pixel every frame: 3.7 M pixels at 1440p, and up to 240 times a second. Worth it later for the audio-reactive modes, behind the same interface. |
| **Canvas 2D** | Blurred gradients are rasterised on the CPU every frame, so it costs the most CPU of the options. Rejected. |
| **CSS animations (keyframes)** | Cheapest when idle because the compositor runs them, but they ignore the frame-rate limit, pausing and idle throttling. Rejected for the drift. CSS transitions are still used for crossfades. |
| **CSS gradients moved from JS** ✔ | Each light is a huge radial gradient on its own compositor layer. It is rasterised once per colour change, and frames only change `transform` and `opacity`, so nothing is repainted. The light moves inside the existing loop at its idle rate (24 FPS), which looks smooth for drift this slow and follows the frame-rate limit, pause and hidden-window rules automatically. It also works with software compositing. |

There are no new dependencies. A static SVG-noise grain at 5% opacity dithers the gradients so
they don't band on the OLED panel.

### Contract (`src/shared/lighting.ts`, `src/renderer/src/ambient/`)

- `AmbientPalette`: 2–4 colours (strongest first) tuned to glow on black, with `source: 'album' | 'palette'`.
  `src/main/palette/ambient.ts` makes them from k-means clusters of the cover. That clustering is now
  shared with the lyric palette in `extract.ts`, so the cover is analysed once.
- `LightingDrive`: `{ intensity, motion }`, both 0–1, for each frame. Phase 1's `albumDrive()` breathes
  with play and pause and follows the animation setting.
- `AmbientRenderer`: `mount / setColors / setBrightness / setEnabled / frame / destroy`. Today
  `createAmbientLayer()` is the only implementation. A WebGL renderer or the edge-glow overlay would
  implement the same interface.
- `LightingMode`: `album` (implemented), and `audio`, `hybrid` and `static` (planned).
  `IMPLEMENTED_LIGHTING_MODES` lists what works, so settings and the UI can't offer a mode that does nothing.
- `AudioBands`: `{ energy, bass, mid, treble }`, smoothed and 0–1. Nothing produces it in Phase 1.

### Planned modes

- **Audio Reactive.** Capture WASAPI loopback (the system mix, never Spotify's stream) in a small
  native helper or a utility process. Run an FFT off the UI thread, then fold the result into bass,
  mid and treble bands with attack/release envelopes (fast attack ~40 ms, slow release ~300 ms) and
  a soft limiter, so beats never flash. Post `AudioBands` to the renderer at ≤ 60 Hz, and map them
  to `LightingDrive` with a user sensitivity setting.
- **Hybrid.** The album palette sets the colours, and `AudioBands` sets `LightingDrive`.
- **Static.** One user colour and brightness, so `AmbientPalette` holds a single colour.

## Desktop lighting overlay (planned)

The lyric overlay stays as it is: transparent, click-through (`setIgnoreMouseEvents(true)`),
`focusable: false`, always on top at `screen-saver` level, and hidden 3 s after a pause. The
lighting overlay will be a **separate window kind** in `StageController`, so it can run with or
without the lyrics:

- One transparent, click-through, non-focusable window per selected monitor. It draws only a band
  around the screen edges with `AmbientRenderer` (adjustable glow width and opacity). The middle of
  the screen is never painted.
- It never takes input or focus, so mouse and keyboard pass through as they do with the lyric overlay.
- It hides itself while another app is full screen or a game holds exclusive full screen. It
  checks the foreground window's bounds against the monitor, polled slowly, plus Windows' "busy"
  state. It can also hide on its own after a pause (optional).
- It runs at a low frame rate (15–30 FPS), because Windows composites transparent full-screen windows expensively.
- It is not a lock-screen replacement. Windows does not allow one, and the existing lock-style
  screen remains an ordinary top-most window.

## Settings

All settings stay in `%APPDATA%\theaestheticslyrics\settings.json` (`version: 1`).
`sanitizeSettings` checks every field on its own, so a file from before LUMINA loads unchanged and
picks up the new defaults. The folder name stays the same on purpose: renaming the app would move
the data folder and lose existing settings, the cache and the user's own lyrics.

| Setting | Field | Status |
|---|---|---|
| Display mode | `showOn` (Lock Screen / Always), `layout` (Player / Lyrics Only) | ✔ |
| Lyric style | `style` | ✔ (existing) |
| Font size | `lyricScale` (0.85 / 1 / 1.15 / 1.3, player) | ✔ |
| Timing offset | `offsetMs` | ✔ (existing) |
| Ambient lighting on/off | `ambient` | ✔ |
| Brightness | `ambientBrightness` (0.4 / 0.7 / 1) | ✔ |
| Animation intensity | `animation` (low / medium / high) | ✔ |
| Frame-rate limit | `frameRateCap` (display / 120 / 60 / 30), whole lyrics screen | ✔ |
| Monitor | `displayId` | ✔ (existing) |
| Start with Windows | `launchAtLogin` | ✔ (existing, packaged builds) |
| Reduced motion | `reducedMotion`, plus Windows' setting | ✔ |
| Lighting mode | — | Planned. Only `album` exists, so there is no setting yet. |
| Sensitivity | — | Planned (audio-reactive). |

## Performance notes

- The loop draws at full rate only while something moves (scrolling, or a word filling during
  playback). Otherwise it drops to 24 FPS for the light. While paused nothing changes except the light.
- **Frame-rate limit:** at 60 FPS and above, the loop skips display refreshes rather than sleeping,
  so frames stay aligned to vsync. On a 240 Hz panel, 120 means every second refresh and 60 every
  fourth. Lower rates use the original timer path, which still wakes up in time for the next word.
- The loop stops completely while the page is hidden (`document.hidden`), as it is for the lyrics
  screen, which is loaded in advance and kept hidden. It starts again when the page becomes visible.
- Per-frame DOM writes go through `setStyle`, which skips unchanged values. Resting lines are left
  alone, and the elapsed and remaining times only change once a second.
- **Not measured yet:** frame times and power at 60, 120 and 240 Hz on the target RTX 4070 SUPER /
  1440p OLED. The design aims at those rates, but no number is claimed until it has been profiled
  (Chrome DevTools Performance panel, `--enable-gpu-benchmarking`, PresentMon).
