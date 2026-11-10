# LUMINA architecture

LUMINA extends theaestheticslyrics. Phase 1 added a full-screen music player to the existing tray
app; Phase 2 adds hybrid audio-reactive lighting for that player and an independent desktop
edge-lighting overlay (see [LUMINA Lighting](#lumina-lighting-phase-2-hybrid-audio-reactive-light)). Everything the original app did still works the same way:
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

## LUMINA Lighting (Phase 2): hybrid audio-reactive light

The album palette sets the colours, and live music sets how they move, pulse, glow and change
intensity. One audio pipeline feeds every lighting window: the fullscreen player background and
the desktop edge-lighting overlay.

```
default output device ────┐ WASAPI endpoint loopback: all desktop audio (default source)
Spotify.exe process tree ─┤ WASAPI process loopback: Spotify only, other apps excluded (optional source)
                          ▼
resources/lumina-helper.exe  (C#, .NET Framework 4.x, runs as the user)
   mono float32 PCM + status, length-prefixed packets on stdout
                          ▼
src/main/audio/worker.ts  (worker thread: raw PCM never reaches the main thread)
   PacketReader → AudioAnalyzer (FFT 2048, ~60 Hz) → AudioAnalysisFrame (~200 bytes)
                          ▼
src/main/audio/audio-service.ts  (main: lifecycle, backoff, validation)
                          ▼ IPC lighting:audio (only to visible lighting windows)
     ┌────────────────────┴────────────────────┐
lock window (player)                   edge window(s), one per monitor
LightingEngine (shared)                LightingEngine (shared)
  album palette + audio → LightFrame     album palette + audio → LightFrame
WebGL2 shader / CSS fallback           WebGL2 shader / CSS fallback
```

### Audio capture: method and why

| Option | Verdict |
|---|---|
| **WASAPI endpoint loopback** of the default render device ✔ **(default source)** | Works on every Windows version without elevation, and is verified live on the target PC. It captures **everything** playing on that device, not only Spotify, and the UI says so wherever it is active: "All desktop audio (not Spotify only)". |
| **WASAPI process loopback** (`ActivateAudioInterfaceAsync` with `VAD\Process_Loopback` and `INCLUDE_TARGET_PROCESS_TREE`, build 20348+) ✔ optional source | Selectable as "Spotify only". Captures only Spotify's process tree (the helper finds the root `Spotify.exe` and follows restarts), without elevation. Verified to exclude other apps; see [Spotify-only capture](#spotify-only-capture-status). |
| Native Node addon (N-API) | Needs a C++ toolchain on every build machine and an ABI-specific rebuild for each Electron upgrade. Rejected. |
| Third-party npm capture packages | Not evaluated in depth: any would add a prebuilt native binary per Electron ABI, which the helper avoids. |
| .NET 6+ sidecar | Needs the .NET runtime on the user's PC (or ~70 MB self-contained). Rejected. |

The helper is a few hundred lines of C# 5, compiled by `scripts/build-helper.mjs` with the
`csc.exe` that ships with .NET Framework 4.x on every Windows 10/11 PC. Building it needs no SDK
and no downloads, the result needs no runtime install, and it runs without Administrator rights
(default `asInvoker` manifest). `npm run dev`, `npm start` and `npm run build` build it
automatically (`pre*` scripts), the CI workflow compiles it, and `npm run package` ships it next to
the asar, as it does with `smtc-bridge.ps1`.

**Audio Capture Source** (settings): **All desktop audio** (the default, at the user's request) or
**Spotify only**. The source is one setting passed to the helper (`capture --source system|spotify`),
so making Spotify-only the default means changing a default, not the architecture. The helper also
understands `auto` (Spotify while it runs, otherwise system audio), which the app doesn't offer yet.

#### Spotify-only capture: status

**Compared with Microsoft's ApplicationLoopback sample:**
- **Same:** the activation parameters (`AUDIOCLIENT_ACTIVATION_PARAMS` in a `VT_BLOB` PROPVARIANT),
  an agile completion handler, the stream flags (`LOOPBACK | EVENTCALLBACK`), the event-driven
  `GetNextPacketSize` / `GetBuffer` / `ReleaseBuffer` loop, and the supported Windows build (26200 ≥ 20348).
- **The difference that mattered:** the sample calls `Initialize`, `GetService` and `SetEventHandle`
  inside `ActivateCompleted`. The helper used to call them after the callback signalled, and then got
  only silence. It now does the same as the sample (`ActivationHandler` in `native/lumina-helper/Capture.cs`).

**After the fix, with Spotify playing**, the inaudible 40 Hz tone from `npm run fake-player` acted
as a second app:

| Source | Overall level | 40 Hz tone |
|---|---|---|
| Spotify only, fake player off | −69.9 dBFS | −107.0 dBFS |
| System audio, fake player off | −69.8 dBFS | −100.4 dBFS |
| Spotify only, fake player on | −67.5 dBFS | **−110.3 dBFS (absent)** |
| System audio, fake player on | −65.3 dBFS | **−66.1 dBFS (present)** |

Spotify-only follows Spotify's real level, which matches system audio when nothing else plays, and
leaves the other app out. Spotify's volume was low during this test (about −68 dBFS), below the
analysis silence threshold of −60 dBFS. See the note on quiet playback below.

**Before the fix (kept for the record), one diagnostic pass with Spotify playing:**
- Windows honours the activation parameters: an invalid activation type returns `E_INVALIDARG`.
- About 100 packets per second arrive and are never flagged silent, but they hold only dither (−99.7 dBFS).
- The result is the same for:
  - the root process tree and each Spotify process on its own;
  - 44.1 kHz and 48 kHz PCM, and 32-bit float;
  - MTA and STA threads;
  - with and without `AUTOCONVERTPCM`.
- Exclude mode (everything except the target), even excluding Explorer, is byte-for-byte equally
  silent, while endpoint loopback of the same device hears the music at about −18 dBFS.
- Microphone privacy allows desktop apps, so that's not the cause.

The output device is a standard one (no virtual or enhanced audio software), which pointed to the
callback difference. That turned out to be the cause.

**Quiet playback:** analysis treats RMS below −60 dBFS as silence and scales band levels against a
−72 dBFS floor. Both sources capture after the app's own volume, so very low Spotify or per-app
volume (as in the test above) reads as silence and the light stays dark. Lowering those thresholds,
or adapting them, is an open follow-up.

**Lifecycle:**
- `AudioService` starts the worker (and the helper) only while a **visible** consumer needs audio:
  edge lighting while it shows, or the fullscreen player while music played in the last 15 s. The
  mode must use audio (Bass Reactive, Hybrid).
- It stops 4 s after the last consumer leaves (so reopening the player doesn't restart capture).
  The worker closes the helper's stdin and kills it after 1.5 s if it doesn't exit. The helper also
  exits when its parent process disappears.
- A crashed helper or worker is restarted with backoff from 1 s up to 30 s. Capture failures are
  logged and the light settles as if silent; they never reach the lyrics.
- In endpoint mode the helper reopens the device when the default output changes (polled every
  second): headphones, Bluetooth, USB DACs. Loopback delivers no packets during silence, so the
  helper pads the gaps with zeros to keep analysis timing steady. Every queue and buffer is bounded:
  the packet reader holds at most one packet (≤ 1 MB, otherwise it resets), and the renderer perf
  rings are fixed-size.
- Nothing is recorded, saved or sent anywhere. PCM exists only in memory, for one FFT window.

### Analysis (`src/main/audio/analysis.ts`)

| Step | Detail |
|---|---|
| Window | 2048-sample Hann (42.7 ms at 48 kHz), hop = sample rate / 60, so 60 frames/s (measured 60.0) |
| Bands | bass 30–150 Hz (kick, bass), mids 250–2000 Hz (vocals, instruments), treble 4–12 kHz (cymbals, air) |
| Levels | RMS amplitude of the band's bins in dBFS |
| Normalisation | Adaptive per band. The recent peak maps to 1 and 30 dB below it to 0. A louder passage raises the peak at once (no overshoot); a quieter one reads darker while the peak falls at 3 dB/s. A noise floor (−72 dBFS) is never stretched to full scale. |
| Smoothing | Attack/release per band (for example bass 18 ms / 150 ms), independent of frame rate |
| Transients | Spectral flux of log-compressed magnitudes up to 10 kHz, relative to its 1.5 s average |
| Beat-like pulse | A bass-band flux onset above its running mean + 1.6σ, at most every 240 ms, decaying over 170 ms. It is a pulse, **not** BPM detection. |
| Silence | RMS below −60 dBFS for 250 ms. All levels go to 0 and no beats fire. |
| Output | `AudioAnalysisFrame` { timestamp, rms, bass, mids, treble, transient, beatPulse, intensity, isSilent }. Every value is clamped to 0–1 and validated again in the main process (`sanitizeAudioFrame`). |

### Hybrid lighting engine (`src/shared/lighting-engine.ts`)

Each window runs its own engine instance (cheap), fed with the same analysis frames. `sample(now)`
interpolates toward the latest audio with the user's smoothing, so the render rate is independent of
the 60 Hz analysis rate. Audio older than 400 ms counts as silence.

| Layer | Driven by (Hybrid) |
|---|---|
| 1. Base album-colour atmosphere | brightness × (0.35 + 0.65 × intensity): quiet passages darken, loud ones reach the chosen brightness |
| 2. Slowly moving gradients | drift speed 0.3 + 0.9 × mids, accumulated as a phase so speed changes never jump |
| 3. Bass bloom behind the album art | bass strength × (0.35 × bass + 0.7 × beat pulse) + 0.12 × transient, radius growing with intensity |
| 4. Treble shimmer | 0.4 × treble × sensitivity. It only modulates light that is already there, so it never flickers on black. |
| 5. Edge illumination | atmosphere and bloom, along the selected edges |

- **Colours** come only from the album palette (`palette/ambient.ts`). They crossfade over 1.6 s on
  a track change, starting from what is on screen, so a quick skip never jumps. Audio never changes them.
- **Modes:** Off, Static Album Colors (still), Ambient (drift and a slow breath, no audio), Bass
  Reactive (steady atmosphere, bass bloom), Hybrid (all layers, the default).
- **Reduced motion** (the setting, or Windows' animation effects off): no drift, no shimmer, bloom
  capped at 0.35 and slowed 3×.

### Rendering (`src/renderer/src/lighting/`)

- **WebGL2:** one fragment shader on a vertex-less fullscreen triangle (`gl_VertexID`). There are no
  buffers or textures, and one program and VAO are created once and reused. Per frame it uploads
  uniforms and makes one draw call. It renders at **half resolution** (1280×720 for 1440p); soft light
  scales up invisibly at a quarter of the fill cost.
- **Picture quality:** ±0.5/255 dithering prevents OLED banding. A soft shoulder (x / (1 + 0.35x))
  keeps peaks restrained. A readability guard dims the light up to 35% behind the lyrics column. The
  overlay writes premultiplied alpha that is exactly 0 where unlit, so the desktop's true black stays black.
- **Robustness:** a lost context (driver reset, GPU process crash) switches to the CSS fallback and
  back on restore. Destroying a renderer releases its context at once (`WEBGL_lose_context`).
- **Fallback:** without GPU compositing (`gpu-info-update`) or WebGL2, the player uses the Phase 1
  CSS gradient layers and the overlay uses four CSS gradient strips, both driven by the same light frames.
- **Pacing:** light draws at its own target (30 / 60 / 120 / 240) through `FrameGate`, which follows a
  schedule so the average rate matches the target even when it doesn't divide the refresh rate.
  Identical frames are skipped. The lyrics never wait on lighting.

### Desktop edge lighting (`src/main/ui/edge-controller.ts`, `src/renderer/src/edge/`)

One window per selected monitor, separate from the lyrics overlay, the player and the settings
window. Verified on the real window with `lumina-helper probe`:

| Requirement | How | Verified |
|---|---|---|
| Click-through | `setIgnoreMouseEvents(true)` → `WS_EX_TRANSPARENT` + `WS_EX_LAYERED` | ✔ `WindowFromPoint` at a lit edge and at the centre returns the window underneath |
| Never takes focus | `focusable: false` → `WS_EX_NOACTIVATE`, `showInactive()` | ✔ style bit set |
| Not in Alt+Tab or the taskbar | `type: 'toolbar'` → `WS_EX_TOOLWINDOW`, `skipTaskbar` | ✔ style bit set, no `WS_EX_APPWINDOW` |
| Transparent, no opaque background | `transparent: true`, `#00000000`, premultiplied output | ✔ snapshot PNG has alpha 0 away from the edges |
| High DPI, monitor-aware | DIP bounds per display, `devicePixelRatio` in the renderer; full-screen rectangles compared in physical pixels (`dipToScreenRect`) | ✔ unit-tested with a 150% + 100% two-monitor layout; live run on one 2560×1440 monitor |
| Monitor selection | Primary, All, or one display; falls back to primary if that display disconnects; windows re-placed on `display-metrics-changed` | ✔ unit tests |
| Paused in full-screen apps | `lumina-helper fullscreen`: the foreground window covers its monitor **and** has no title bar (borderless, F11), or `SHQueryUserNotificationState` reports exclusive D3D. LUMINA's own windows never count. | ✔ live: a maximized window isn't flagged |
| Emergency off | Tray → LUMINA Lighting → **Pause Lighting** hides every edge window and stops capture at once | ✔ code path |
| OLED rest | Hidden 60 s after music stops (no SMTC playback and no audible capture) | ✔ unit tests |

Edge lighting also hides while the fullscreen player is open (the player has its own light).

## Settings

All settings stay in `%APPDATA%\theaestheticslyrics\settings.json`, now `version: 2`.
`sanitizeSettings` validates every field on its own. A version-1 file (Phase 1) migrates as
follows: `ambient: false` becomes Fullscreen Lighting off, and Low/Medium/High brightness becomes
30/45/65%. Everything else carries over unchanged. Changes apply live.

| Setting | Field | Default |
|---|---|---|
| Lighting Mode | `lightingMode` | Hybrid |
| Enable Fullscreen Lighting | `fullscreenLighting` | On |
| Enable Desktop Edge Lighting | `edgeLighting` | Off (until enabled) |
| Brightness | `lightingBrightness` 5–100% | 45% |
| Audio Sensitivity | `audioSensitivity` | 60% |
| Bass Strength | `bassStrength` | 55% |
| Smoothing | `lightingSmoothing` | 70% |
| Glow Radius | `glowRadius` | 50% |
| Edge Thickness / Spread / Softness | `edgeThickness`, `edgeSpread`, `edgeSoftness` | 35% / 60% / 70% |
| Edges | `edgeSides` | left, right, bottom |
| Edge Glow in the Player | `playerEdgeGlow` | Off |
| Render FPS | `lightingFps` 30 / 60 / 120 / 240 | 60 |
| Audio Capture Source | `audioSource` system / spotify | All desktop audio (`system`) |
| Monitor Selection | `edgeDisplays` primary / all / display id | Primary |
| Pause During Fullscreen Games | `pauseInFullscreen` | On |
| Start Edge Lighting with Windows | `edgeAtStartup` | On |
| Lyric style, font size, timing, display, Start with Windows, reduced motion, frame-rate limit | (Phase 1 fields) | unchanged |

**Where to change them:**
- **Tray → LUMINA Lighting:** Enable Desktop Lighting, Fullscreen Player Lighting, Lighting Mode,
  Brightness, Select Monitor, Pause Lighting, and Lighting Settings…, which opens the full panel.
- **The panel:** shows live status (audio mode, edge state, renderer) and validates nothing itself.
  The main process accepts only lighting keys (`pickLightingPatch`) and the settings store
  validates every value.

## Performance (measured)

All runs on the target PC: RTX 4070 SUPER, Ryzen 7 7700X, 2560×1440 at **179.9 Hz** (the panel's
current mode, not 240). Each used the real app, a throwaway profile and live system audio.

- **Frame timing** comes from the pages' own `requestAnimationFrame` counters.
- **CPU and GPU** come from Windows counters (`GPU Engine … engtype_3D`, per-process CPU) sampled
  once a second.
- **Main-thread blocking** is the event-loop delay above Windows' 15.6 ms timer granularity.

| Scenario | Frames | Frame interval p50 / p99 / max | Script per frame | LUMINA GPU 3D avg / max | CPU (all cores) |
|---|---|---|---|---|---|
| Edge overlay, 60 FPS target, 20 s | 59.9 FPS | 16.7 / 16.8 / 16.8 ms | 0.02 ms | 0.31% GPU-process CPU (per-process GPU-3D not sampled in this run) | 0.66% total (Browser 0.13, GPU 0.31, renderer 0.22) |
| Player, lighting only (Spotify paused), 240 target, 12 s | 180 FPS (the panel's limit) | 5.6 / 5.8 / 5.8 ms | 0.04 ms | 0.33% / 1.41% | 1.43% |
| Player + Spotify playing (lyric word fill at display rate), 60 target, 12 s | page 140.6, light 60.0 | page 5.6 / 16.8 / 22.3 ms | 0.13 ms | 9.07% / 27.25% | 7.23% |
| Player + Spotify playing, 120 target, 12 s | page 156.6, light 119.0 | light p99 12.3 ms | 0.12 ms | 7.71% / 21.2% | 7.71% |

**Other measurements:**
- **Long tasks:** none in any run.
- **Main-thread blocking:** p99 ≤ 0.62 ms and max ≤ 1.29 ms in clean runs. A 609 ms spike in one
  earlier run was the debug screenshot (synchronous PNG encode) and is excluded.
- **Helper CPU:** 0.02–0.03% of all cores.
- **Audio delivery latency** (analysis → renderer, IPC): p50 0–1 ms, p99 1 ms.
- **Audio-to-light latency:** not measured end to end. The algorithmic part is about 21 ms (half
  the FFT window) + up to 10 ms (WASAPI packet) + up to 16.7 ms (hop) + about 1 ms delivery. On top
  of that comes the engine's attack time constant, about 104 ms at the default 70% smoothing (about
  20 ms at 0%).
- **Memory (working set):** browser about 165 MB, GPU process about 165 MB, renderer about 150–220 MB.
- **3-minute soak** (edge lighting, live audio, WebGL): 60.0 FPS throughout (frame p99 16.9 ms, max
  22.4 ms), script 0.03 ms per frame, no long tasks, audio delivery p99 1 ms. Working set at the
  start and end: browser 165 → 154 MB, GPU process 151 → 155 MB, renderer 222 → 227 MB. No growth trend.
- **Without a GPU** (`--disable-gpu`): the CSS fallback took over, at 21.8 FPS under software
  compositing, with no long tasks and audio still at 60 frames/s.

**The GPU cost while playing comes from the Phase 1 lyric animation, not the lighting:**
- Lighting alone at 180 FPS used 0.33% of the GPU.
- With Spotify playing, the word-fill text gradient and glow repaint at the display rate.

Lowering **Frame Rate Limit** (lyrics) or using Reduce Motion cuts that cost. A follow-up could
render the active-line fill more cheaply.

## Reliability (what was exercised)

| Scenario | Result |
|---|---|
| Spotify not running / closed | The default desktop-audio source doesn't depend on Spotify. The Spotify-only source waits and re-checks every second. Not exercised by closing Spotify during this work. |
| Pause / resume, quiet passages | Analysis reports silence after 250 ms. The light settles to 35% of brightness and stays dark. Edge lighting rests 60 s after music stops (no playback and no audible capture). Unit-tested; pauses observed live. |
| Track changes | The palette crossfades over 1.6 s from what is on screen. Unit-tested; seen live with Spotify. |
| Output device change (USB, Bluetooth) | The helper polls the default device every second and reopens it; an invalidated device ends the stream and it reopens. Not exercised with real device switching. |
| Other apps playing audio | In system mode they drive the light (by design, and labelled); in Spotify mode they are excluded. Verified live: endpoint loopback heard music while the Spotify stream was silent. |
| Process loopback unavailable | Activation errors are reported and the source can be switched; the default doesn't depend on it. |
| Helper or worker crash | Restart with backoff from 1 s to 30 s (unit-tested). Capture errors never affect lyrics. |
| A full-screen app or game on the monitor | Edge lighting hides on that monitor and capture stops if no other consumer needs it. Verified live: another app's full-screen window hid it, and it came back after. |
| Maximized windows | Not treated as full screen (verified live). |
| Several displays, scaling, disconnects | Display targeting and high-DPI full-screen matching unit-tested; windows re-placed on display changes. Only one monitor was available live. |
| No GPU | CSS fallback verified live with `--disable-gpu`. A lost WebGL context switches to CSS and back. |
| Quit with edge lighting on | Fixed during testing (edge windows used to cancel the quit). Now exits cleanly and the helper is gone (verified). |
| Restart with saved settings | Settings v2 persistence and v1 migration unit-tested. |
| Several consumers at once | One worker and helper serve the player and every edge window (unit-tested lifecycle). |

## Phase 1 performance notes (still true)

- The stage loop draws at full rate only while something moves. Lighting adds its own rate, still
  capped by the Frame Rate Limit.
- The loop stops completely while the page is hidden.
- Per-frame DOM writes skip unchanged values (`setStyle`).
