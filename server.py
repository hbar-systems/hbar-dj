#!/usr/bin/env python3
"""hbar.dj — voice-driven DJ tool backend (spike v0, created 2026-06-16;
key-free runtime as of 2026-06-17).

A small FastAPI service behind a single-page Web Audio deck. The deck is
sovereign: speech-to-text runs in the browser (Web Speech API) and spoken
commands are mapped to deck actions by a LOCAL parser (static/app.js
mapCommand) — no LLM, no API key, fully offline. The mapper is one swappable
function, so it can later be pointed at the hbar brain (set window.DJ_BRAIN_URL)
without changing the deck.

Endpoints
  POST /download  {url}     -> pull YouTube audio via yt-dlp -> wav; returns track id + url
  POST /upload    (file)    -> drag-dropped audio -> wav
  POST /analyze   {track}   -> BPM + musical key + impressions (all local: librosa + heuristics)
  POST /stems     {track}   -> demucs 4-stem separation (drums/bass/vocals/other). Slow on CPU.
  GET  /audio/<f>           -> serve a wav/stem
  GET  /                    -> the deck UI

No API key. No network calls at runtime beyond yt-dlp on /download.
"""
import hashlib
import subprocess
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

HERE = Path(__file__).parent
DATA = HERE / "data"
DATA.mkdir(exist_ok=True)

app = FastAPI(title="hbar.dj")


# ---------------------------------------------------------------- helpers

def _track_id(seed: str) -> str:
    return hashlib.sha1(seed.encode()).hexdigest()[:12]


def _wav_path(track: str) -> Path:
    return DATA / f"{track}.wav"


# ---------------------------------------------------------------- download

class DownloadReq(BaseModel):
    url: str
    title: str | None = None


@app.post("/download")
def download(req: DownloadReq):
    """Pull bestaudio from a YouTube (or any yt-dlp-supported) URL to wav."""
    track = _track_id(req.url)
    out = _wav_path(track)
    if not out.exists():
        # %(title)s captured separately; download to a temp template then ffmpeg->wav
        cmd = [
            "yt-dlp", "--no-warnings", "--no-playlist",
            "-x", "--audio-format", "wav",
            "-o", str(DATA / f"{track}.%(ext)s"),
            req.url,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0 or not out.exists():
            raise HTTPException(502, f"yt-dlp failed: {r.stderr[-400:]}")
    title = req.title or _yt_title(req.url) or track
    return {"track": track, "url": f"/audio/{track}.wav", "title": title}


def _yt_title(url: str) -> str | None:
    try:
        r = subprocess.run(
            ["yt-dlp", "--no-warnings", "--skip-download", "--print", "%(title)s", url],
            capture_output=True, text=True, timeout=60)
        t = r.stdout.strip()
        return t or None
    except Exception:
        return None


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """Accept a drag-dropped audio file; transcode to wav for uniform handling."""
    raw = await file.read()
    track = _track_id(file.filename + str(len(raw)))
    src = DATA / f"{track}_src{Path(file.filename).suffix or '.bin'}"
    src.write_bytes(raw)
    out = _wav_path(track)
    if not out.exists():
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-ac", "2", "-ar", "44100", str(out)],
            capture_output=True, text=True, timeout=300)
        if r.returncode != 0 or not out.exists():
            raise HTTPException(502, f"ffmpeg failed: {r.stderr[-400:]}")
    src.unlink(missing_ok=True)
    return {"track": track, "url": f"/audio/{track}.wav", "title": file.filename}


# ---------------------------------------------------------------- analyze

class AnalyzeReq(BaseModel):
    track: str
    title: str | None = None


# Krumhansl-Schmuckler major/minor profiles for key estimation
_KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _estimate_key(chroma_mean):
    import numpy as np
    best = (-2.0, "C", "major")
    for i in range(12):
        rot = np.roll(chroma_mean, -i)
        maj = float(np.corrcoef(rot, _KS_MAJOR)[0, 1])
        minr = float(np.corrcoef(rot, _KS_MINOR)[0, 1])
        if maj > best[0]:
            best = (maj, _NOTES[i], "major")
        if minr > best[0]:
            best = (minr, _NOTES[i], "minor")
    return f"{best[1]} {best[2]}"


@app.post("/analyze")
def analyze(req: AnalyzeReq):
    path = _wav_path(req.track)
    if not path.exists():
        raise HTTPException(404, "track not found")
    try:
        import librosa
        import numpy as np
    except ImportError:
        raise HTTPException(500, "librosa not installed (pip install librosa)")

    y, sr = librosa.load(str(path), sr=22050, mono=True)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = round(float(np.atleast_1d(tempo)[0]), 1)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key = _estimate_key(chroma.mean(axis=1))
    duration = round(len(y) / sr, 2)

    # feature reads for the impressions heuristic — all local, no model
    rms = float(librosa.feature.rms(y=y).mean())
    centroid = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    onset = float(librosa.onset.onset_strength(y=y, sr=sr).mean())
    impressions = _impressions(bpm, key, rms, centroid, onset)
    return {"bpm": bpm, "key": key, "duration": duration, "impressions": impressions}


def _impressions(bpm: float, key: str, rms: float, centroid: float, onset: float) -> dict:
    """A DJ-ear 'feel' read derived from the audio features — heuristic, local,
    no model. Returns the same shape the deck UI consumes."""
    energy = max(1, min(10, round(rms * 45 + onset * 1.5 + 1)))
    minor = "minor" in key

    # genre guess from tempo band (tuned toward the afro-house / melodic-techno lane)
    if bpm < 90:
        genre = "downtempo / hip-hop"
    elif bpm < 116:
        genre = "afro house / disco"
    elif bpm < 124:
        genre = "house"
    elif bpm < 129:
        genre = "afro / melodic house"
    elif bpm < 134:
        genre = "melodic techno"
    elif bpm < 142:
        genre = "techno"
    elif bpm < 150:
        genre = "trance / hard"
    else:
        genre = "dnb / fast (or half-time)"

    bright = "bright" if centroid > 2800 else "warm" if centroid > 1600 else "dark"
    mood = (f"{bright}, {'brooding' if minor else 'open'}"
            if energy >= 6 else f"{bright}, {'pensive' if minor else 'easy'}")

    if energy <= 3:
        mix_role = "opener / breakdown"
    elif energy <= 6:
        mix_role = "builder"
    elif energy <= 8:
        mix_role = "peak-time"
    else:
        mix_role = "peak / closer"

    one_liner = f"{genre} at {round(bpm)} — {mood}, sits as a {mix_role}."
    return {
        "energy": energy, "mood": mood, "genre": genre,
        "mix_role": mix_role, "one_liner": one_liner,
        "source": "local-heuristic",
    }


# ---------------------------------------------------------------- stems

class StemsReq(BaseModel):
    track: str


@app.post("/stems")
def stems(req: StemsReq):
    """Demucs 4-stem split. Heavy: minutes on CPU, needs the stems extra installed."""
    path = _wav_path(req.track)
    if not path.exists():
        raise HTTPException(404, "track not found")
    outdir = DATA / "stems" / req.track
    names = ["drums", "bass", "vocals", "other"]
    existing = {n: outdir / f"{n}.wav" for n in names}
    if all(p.exists() for p in existing.values()):
        return {"stems": {n: f"/audio/stems/{req.track}/{n}.wav" for n in names}}

    try:
        import demucs.separate  # noqa: F401
    except ImportError:
        raise HTTPException(500, "demucs not installed (pip install -r requirements-stems.txt)")

    outdir.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ["python3", "-m", "demucs", "-n", "htdemucs", "--out", str(DATA / "stems_raw"), str(path)],
        capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise HTTPException(502, f"demucs failed: {r.stderr[-400:]}")
    # demucs writes data/stems_raw/htdemucs/<track>/<stem>.wav
    src = DATA / "stems_raw" / "htdemucs" / req.track
    for n in names:
        sp = src / f"{n}.wav"
        if sp.exists():
            sp.replace(existing[n])
    return {"stems": {n: f"/audio/stems/{req.track}/{n}.wav" for n in names}}


# ---------------------------------------------------------------- static + audio
#
# The "voice brain" lives entirely in the browser (static/app.js mapCommand):
# Web Speech API for speech-to-text, then a local keyword/regex parser maps the
# sentence to a deck action. No /command route, no key. To swap in the hbar
# brain later, set window.DJ_BRAIN_URL in the page and the deck POSTs the
# transcript there expecting the same { action, ... } shape.

@app.get("/audio/{path:path}")
def audio(path: str):
    f = (DATA / path).resolve()
    if DATA.resolve() not in f.parents and f != DATA.resolve():
        raise HTTPException(403, "nope")
    if not f.exists():
        raise HTTPException(404, "not found")
    return FileResponse(f)


app.mount("/", StaticFiles(directory=str(HERE / "static"), html=True), name="static")
