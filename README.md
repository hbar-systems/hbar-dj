# hbar.dj — voice-driven DJ deck (spike)

created 2026-06-16 · local voice brain 2026-06-17

A browser deck you control by talking to it.
You load a track, the deck identifies it, and you DJ it with your voice.
The language layer is the point: you say "tempo down" or "just the vocals," and the deck maps that to a concrete action — locally, with no API key and no network round-trip.

## Sovereign by design

There is **no LLM and no API key at runtime**. Speech-to-text runs in the browser (Web Speech API, the same engine as phone dictation), and the spoken sentence is mapped to a deck action by a local keyword/regex parser (`static/app.js` → `mapCommand`). The command set is small and closed, so plain matching covers it. The mapper is one swappable function: set `window.DJ_BRAIN_URL` and the deck POSTs the transcript to the hbar brain instead — same `{ action, ... }` shape — for fuzzier language understanding. The medium matches the message: a sovereignty tool that doesn't phone home to build or to run.

## What it does (v0)

- **Load** a track three ways:
  - paste a YouTube (music-video) URL → `yt-dlp` pulls the audio to wav
  - drag-drop / pick a local audio or video file
  - *(next)* pull a video that's already open in orfeo — see "Orfeo hook" below
- **Identify** — Key + BPM (librosa), plus **Impressions** — a DJ-ear read (energy, mood, genre, mix-role, one-liner) derived locally from the audio features (RMS, spectral centroid, onset strength, tempo band). No model.
- **Deck controls** (the right half — always visible, like a real deck), all independent via a vendored **SoundTouch** PitchShifter:
  - **Tempo** — time-stretch 0.5×–2×. With **key lock** on it's master-tempo (pitch stays); off it's varispeed (vinyl — pitch follows).
  - **Pitch** — continuous shift, −12…+12 semitones.
  - **Transpose** — discrete −/+ semitone steps.
  - **Stems** — demucs 4-way split (drums / bass / vocals / other), solo/mute each. The split button is always present; the split itself needs the stems extra (below).
- **Beat-grid editing** — after analyze, the waveform shows bar lines; loop / cut / mute / fade over N bars (click or voice) build a **non-destructive EDL** drawn as colored regions and enforced live at playback. "loop the next 8 bars", "cut 4 bars here", "fade out".
- **Record a vocal** — REC captures your mic (`getUserMedia` + `MediaRecorder`) while the track plays; the take renders as a second waveform under the track, plays back, and downloads. Local; nothing uploaded.
- **Speak to the deck** — mic → browser speech-to-text → local parser → deck action(s). One sentence can chain a **sequence** ("loop the next 8 bars and mute the vocals"); open-ended editing routes to your brain (see below). Typed commands work too.

## Look

Layout: full-width waveform (the hero) on top, transport + REC beneath it, then two halves — **source** (load / analyze / key·bpm·impressions) and **deck** (the control rack). Themed to match **orfeo.music** (HDX tokens: violet `#A47CFF` on `#05030A`, lavender ink, slow breathing-purple background). Fonts are local stacks only — no web-font fetch, so the page stays offline by default.

## Run

```bash
./run.sh        # creates .venv, installs base deps, serves on :8731 — no key needed
```

Open http://127.0.0.1:8731 in **Chrome** (best Web Speech support).

Stems are an opt-in heavy extra (pulls torch):

```bash
./.venv/bin/pip install -r requirements-stems.txt
```

## Architecture

- `server.py` — FastAPI: `/download`, `/upload`, `/analyze`, `/stems`, static + `/audio`. No `/command`, no anthropic dependency.
- `static/app.js` — ESM deck engine: a **SoundTouch PitchShifter** per source (full track, or one per stem), with live tempo / pitch / transpose / key-lock, transport, waveform-seek, and the local voice parser.
- `static/vendor/soundtouch.js` — vendored SoundTouch JS (LGPL, v0.1.30) for independent time-stretch + pitch-shift. Vendored, not CDN — the tool stays offline.
- Key/BPM: librosa (`beat_track` + chroma → Krumhansl-Schmuckler key estimate).
- Impressions: local heuristic over librosa features (`server.py` → `_impressions`).
- Voice mapping: `static/app.js` → `mapCommand` (local) behind `resolveAction` (the brain-pluggable seam).

To grow the vocabulary, add a branch in `mapCommand` and a matching case in `applyAction`. To route to the brain instead, set `window.DJ_BRAIN_URL`.

### Engine note / tradeoff

Native Web Audio couples speed and pitch (`playbackRate` changes both, like a turntable), so independent **stretch** and **pitch/transpose** require a stretch engine — hence SoundTouch. The cost: SoundTouch plays a continuous stream, so the old beat-synced `1/2ⁿ` loop buttons don't survive this engine and were dropped in favour of the controls. SoundTouch runs on a `ScriptProcessorNode` (deprecated but universally supported). Stem mode runs four PitchShifters sharing one set of controls — sync is good but not sample-locked; treat it as experimental.

## Voice → actions, and the brain seam

Two layers, both feeding the same `applyAction()`:

1. **Local (default, no key):** `mapCommandSeq` splits a sentence on connectors (`and` / `then` / `,`) and maps each clause with the closed-vocabulary `mapCommand`. So one utterance can be **a sequence** — "loop the next 8 bars and mute the vocals" → two actions; "loop 8 and cut 4 and mute the bass" → three. Fully offline.
2. **Brain (optional, open-ended):** set `window.DJ_BRAIN_URL`. The deck POSTs `{ text, state, grammar }` and applies the returned `{ actions: [...] }`. This is where free-form editing language ("take the breakdown, double it, bring the vocal in halfway") gets turned into an action sequence — a reasoning task that belongs in your brain / a local model, **not** a hardcoded grammar.

**Contract** (what the brain endpoint must accept and return):

```jsonc
// POST DJ_BRAIN_URL
// request:
{ "text": "loop the drop and fade out",
  "state": { "bpm": 122, "key": "A minor", "t": 73.1, "mode": "full", "edits": 0, ... },
  "grammar": ["play","pause","set_tempo{tempo:0.5..2}","edit{edit:loop|cut|mute|fade, bars:int}", ...] }
// response (either shape):
{ "actions": [ { "action": "edit", "edit": "loop", "bars": 8 }, { "action": "edit", "edit": "fade", "bars": 8 } ] }
```

`grammar` (the single source of truth) is `GRAMMAR` in `app.js` and is sent on every request — point `DJ_BRAIN_URL` at the hbar brain or a local model with a system prompt like: *"You translate a DJ's spoken instruction into a JSON array of deck actions drawn ONLY from the provided grammar. Use the state (BPM, current time `t`, key) to resolve musical references. Return `{\"actions\":[...]}` and nothing else."* No Anthropic by default — the brain is yours.

## Try saying

> "tempo up" · "slow it down" · "set tempo to 90 percent" · "pitch up" · "down 2 semitones" · "key lock off" · "split the stems" · "just the vocals" · "drop the drums" · "take it from the top" · "what key is this"

## Orfeo hook (next)

The "pull the video up through orfeo" path isn't wired yet — orfeo.music is a separate Next app with its own data layer. The clean integration: orfeo exposes the current video's source URL (or media id), and the deck calls `/download` with it. Until then the YouTube-URL box covers the same intent for music videos.

## Known v0 limits

- Stems on CPU are slow (minutes per track); GPU strongly preferred. The split button is always shown; without the stems extra it returns a clear "unavailable" status.
- Stem mode = four PitchShifters sharing controls — sync is good but not sample-locked (experimental).
- SoundTouch uses a `ScriptProcessorNode` (deprecated; works everywhere today). An AudioWorklet port is the v1 upgrade.
- Beat-synced `1/2ⁿ` loop buttons were dropped for the stretch engine (see Engine note) — could return as a separate buffer-loop mode.
- No persistence; `data/` is gitignored scratch.
- Single deck (no crossfade / second deck yet).

## Brain-app architecture (2026-06-18)

The spike is wired to install as a BrainFoundry brain-app (`brain-app.yaml`, dialect
`brain-app/v1`, id `hbar-dj`). Three structural facts:

1. **Backend = a router, not an app.** `server.py` exports `router = APIRouter()`,
   which the brain mounts at `/apps/hbar-dj/api/`. A thin `app = FastAPI()` +
   `__main__` (mounting the router under `/api` and the deck at `/`) keeps
   standalone dev working (`run.sh`). The frontend addresses the backend with a
   **relative `api/…` path**, which resolves correctly in both contexts — under
   the brain it becomes `/api/bf/apps/hbar-dj/api/…` (proxied to the router), and
   standalone it becomes `/api/…`. (Same pattern as the hbar.poker brain-app.)

2. **Open-ended voice → the host brain reasoner.** `resolveAction` priority:
   (1) the postMessage **`llm.complete`** bridge to the host brain (only when
   installed — i.e. running in an iframe). The bridge returns *free text* (it
   proxies `/chat/rag`, not structured output), so the deck sends a system prompt
   asking for `{"actions":[…]}` and parses the JSON out client-side, scoped to the
   grammar in `GRAMMAR`. (2) `window.DJ_BRAIN_URL` — a standalone-dev escape hatch
   that POSTs `{text, state, grammar}` to an explicit endpoint. (3) the local
   closed-vocabulary parser (offline default). The app holds **no API key**; it
   borrows the operator's own selected model.

3. **Heavy tools run elsewhere — the `HBAR_DJ_BACKEND_URL` seam.** `yt-dlp`,
   `librosa`, and `demucs`/`torch` are too heavy for a small brain VM. Leave
   `HBAR_DJ_BACKEND_URL` unset → the tools run in-process (standalone dev, or a
   brain that has the deps). Set it → the router becomes a thin same-origin proxy
   for `download / upload / analyze / stems / audio` to a **shared compute node**
   (e.g. a GPU pod) that runs this same `server.py`. The frontend never changes.
   This is the "thin app, thick brain, heavy work on a shared node" shape.

### What is a DJ feature vs a shared brain capability

- **Voice-command input** (speech-to-text for "tempo up") is inline browser Web
  Speech today. The eventual shared home for voice input across the brain is the
  proposed **hbar.talk** extension; converge on it when hbar.talk ships, not before.
- **Vocal recording** (singing a take over the track) is a music-production
  feature and stays **DJ-local** — it is not a cross-brain tool. The one natural
  future hook is "save this take to my brain" via `memory.write` (episodic), which
  would require adding that permission to the manifest. Out of scope for v0.1.
