// hbar.dj deck engine — spike v0 (SoundTouch deck rebuild 2026-06-17)
// A 50/50 deck: load on the left, always-visible control rack on the right.
// Independent tempo (time-stretch), pitch, transpose and varispeed via a
// locally-vendored SoundTouch PitchShifter (static/vendor/soundtouch.js) — no
// CDN, no key. Speech-to-text is the browser Web Speech API; spoken commands
// map to actions through the LOCAL mapCommand parser (resolveAction is the one
// swappable seam — set window.DJ_BRAIN_URL to route to the hbar brain instead).
import { PitchShifter } from "./vendor/soundtouch.js";

const $ = (s) => document.querySelector(s);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ----- audio graph -----
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const master = ctx.createGain();
master.connect(ctx.destination);

// ----- deck state -----
let track = null;          // current track id
let buffer = null;         // full-track AudioBuffer
let durationSec = 0;
let shifter = null;        // full-track PitchShifter
let stemShifters = null;   // {drums,bass,vocals,other} PitchShifters (stem mode)
let stemGains = {};
let mode = "full";         // "full" | "stems"
let playing = false;
let progress = 0;          // 0..1 playhead
let analysis = null;

// ----- control state (live, applied to the active shifter[s]) -----
let tempo = 1;             // slider value: key-lock on -> time-stretch; off -> varispeed
let semitones = 0;         // pitch + transpose combined, applied as pitchSemitones
let keyLock = true;

function applyTo(s) {
  if (keyLock) { s.tempo = tempo; s.rate = 1; s.pitchSemitones = semitones; }
  else { s.rate = tempo; s.tempo = 1; s.pitchSemitones = 0; }  // varispeed: pitch follows
}
function applyAll() {
  if (mode === "stems" && stemShifters) Object.values(stemShifters).forEach(applyTo);
  else if (shifter) applyTo(shifter);
}

// ----- loading -----
async function loadBuffer(url) {
  const ab = await (await fetch(url)).arrayBuffer();
  return await ctx.decodeAudioData(ab);
}

function disposeAll() {
  if (shifter) { try { shifter.disconnect(); } catch (e) {} shifter = null; }
  if (stemShifters) {
    Object.values(stemShifters).forEach((s) => { try { s.disconnect(); } catch (e) {} });
    stemShifters = null; stemGains = {};
  }
  playing = false; progress = 0; updatePlayBtn();
}

async function setTrack(t) {
  disposeAll();
  track = t.track;
  buffer = await loadBuffer(t.url);
  durationSec = buffer.duration;
  mode = "full";
  $("#trackTitle").textContent = t.title || t.track;
  $("#dur").textContent = fmt(durationSec);
  document.querySelectorAll(".stem").forEach((b) => { b.disabled = true; b.classList.remove("active", "muted"); });
  $("#stemStatus").textContent = "";
  drawWave();
  logLine(`loaded: ${t.title || t.track}`);
}

function makeShifter(buf) {
  const s = new PitchShifter(ctx, buf, 4096);
  applyTo(s);
  s.percentagePlayed = progress;                 // start from current playhead (fraction 0..1)
  s.on("play", (d) => { progress = (d.percentagePlayed || 0) / 100; });  // event % is 0..100
  return s;
}

// ----- transport -----
function play() {
  if (!buffer) return;
  if (ctx.state === "suspended") ctx.resume();
  if (mode === "stems" && stemShifters) {
    Object.entries(stemShifters).forEach(([n, s]) => { s.percentagePlayed = progress; s.connect(stemGains[n]); });
  } else {
    if (!shifter) shifter = makeShifter(buffer);
    shifter.connect(master);
  }
  playing = true; updatePlayBtn();
}
function pause() {
  if (mode === "stems" && stemShifters) Object.values(stemShifters).forEach((s) => { try { s.disconnect(); } catch (e) {} });
  else if (shifter) { try { shifter.disconnect(); } catch (e) {} }
  playing = false; updatePlayBtn();
}
function stop() { pause(); seek(0); }
function restart() { seek(0); if (!playing) play(); }
function updatePlayBtn() { $("#play").textContent = playing ? "❚❚" : "▶"; }

function seek(frac) {
  progress = clamp(frac, 0, 1);
  if (mode === "stems" && stemShifters) Object.values(stemShifters).forEach((s) => (s.percentagePlayed = progress));
  else if (shifter) shifter.percentagePlayed = progress;
}

// ----- controls -----
function setTempo(v) {
  tempo = clamp(v, 0.5, 2);
  $("#tempo").value = tempo;
  const bpm = analysis?.bpm ? ` · ${Math.round(analysis.bpm * tempo)} BPM` : "";
  $("#tempoVal").textContent = `${tempo.toFixed(2)}×${bpm}`;
  applyAll();
}
function setSemitones(v) {
  semitones = clamp(v, -12, 12);
  $("#pitch").value = semitones;
  const sign = semitones > 0 ? "+" : "";
  $("#pitchVal").textContent = `${sign}${semitones.toFixed(1)} st`;
  $("#transVal").textContent = `${sign}${Math.round(semitones)} st`;
  applyAll();
}
function nudgeTranspose(d) { setSemitones(Math.round(semitones) + d); }

function setKeyLock(on) {
  keyLock = on;
  $("#keyLock").checked = on;
  $("#pitchCtl").classList.toggle("disabled", !on);
  $("#transCtl").classList.toggle("disabled", !on);
  $("#pitch").disabled = !on;
  $("#transDown").disabled = !on; $("#transUp").disabled = !on;
  // relabel tempo control: key-lock on = time-stretch; off = varispeed (vinyl)
  $("#tempo").closest(".control").querySelector(".clabel > span:first-child").textContent =
    on ? "TEMPO (key-lock)" : "TEMPO (varispeed)";
  applyAll();
}
function resetAll() { setTempo(1); setSemitones(0); setKeyLock(true); logLine("controls reset"); }

// ----- analyze -----
async function analyze() {
  if (!track) return;
  $("#iImp").textContent = "analyzing…";
  const r = await fetch("/analyze", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ track, title: $("#trackTitle").textContent }),
  });
  const d = await r.json();
  if (!r.ok) { $("#iImp").textContent = d.detail || "failed"; return; }
  analysis = d;
  $("#iKey").textContent = d.key;
  $("#iBpm").textContent = d.bpm;
  const imp = d.impressions || {};
  $("#iImp").textContent = imp.error
    ? imp.error
    : `${imp.energy ?? "?"}/10 · ${imp.mood ?? ""} · ${imp.genre ?? ""} · ${imp.mix_role ?? ""}`;
  setTempo(tempo);  // refresh tempo readout now that BPM is known
  renderEdl();      // grid label now reflects the detected BPM
  logLine(`analyzed: ${d.key}, ${d.bpm} BPM`);
}

// ----- stems (demucs; heavy — button always present) -----
async function splitStems() {
  if (!track) { $("#stemStatus").textContent = "load a track first"; return; }
  $("#stemStatus").textContent = "splitting… (demucs, slow on CPU)";
  try {
    const r = await fetch("/stems", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ track }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "stems failed");
    pause();
    stemShifters = {}; stemGains = {};
    for (const [name, url] of Object.entries(data.stems)) {
      const buf = await loadBuffer(url);
      const g = ctx.createGain(); g.connect(master); stemGains[name] = g;
      const s = new PitchShifter(ctx, buf, 4096); applyTo(s);
      s.on("play", (d) => { if (name === "drums") progress = (d.percentagePlayed || 0) / 100; });
      stemShifters[name] = s;
    }
    mode = "stems";
    document.querySelectorAll(".stem").forEach((b) => { b.disabled = false; b.classList.add("active"); b.classList.remove("muted"); });
    $("#stemStatus").textContent = "ready (drums/bass/vocals/other)";
    logLine("stems ready");
    if (playing) play();
  } catch (e) {
    $("#stemStatus").textContent = "unavailable: " + e.message;
    logLine("stems: " + e.message);
  }
}
function stem(name, modeArg) {
  if (!stemShifters) return;
  const btns = [...document.querySelectorAll(".stem")];
  const me = btns.find((b) => b.dataset.stem === name);
  if (!me) return;
  if (modeArg === "solo") { btns.forEach((b) => b.classList.toggle("muted", b !== me)); me.classList.remove("muted"); }
  else if (modeArg === "mute") me.classList.add("muted");
  else if (modeArg === "unmute") me.classList.remove("muted");
  else me.classList.toggle("muted");
  btns.forEach((b) => {
    const g = stemGains[b.dataset.stem];
    const on = !b.classList.contains("muted");
    if (g) g.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.01);
    b.classList.toggle("active", on);
  });
}

// ===================================================================
// Beat-grid editing — non-destructive EDL enforced live at playback.
// Edits are in SOURCE time (independent of the tempo control). Each is
// {type, from, to} in seconds; the scheduler in tick() enforces them.
// ===================================================================
let edl = [];                       // [{type:'loop'|'cut'|'mute'|'fade', from, to}]
const barSec = () => (4 * 60) / ((analysis && analysis.bpm) || 120);

function addEdit(type, bars) {
  if (!buffer) { logLine("load + analyze a track first"); return; }
  const len = bars * barSec();
  const t = progress * durationSec;
  const e = type === "fade"
    ? { type: "fade", from: Math.max(0, durationSec - len), to: durationSec }
    : { type, from: t, to: Math.min(durationSec, t + len) };
  if (type === "loop") edl = edl.filter((x) => x.type !== "loop");  // one loop at a time
  edl.push(e);
  renderEdl();
  logLine(`edit: ${type} ${bars} bars (${fmt(e.from)}–${fmt(e.to)})`);
}
function clearEdits() { edl = []; if (master) master.gain.setTargetAtTime(1, ctx.currentTime, 0.02); renderEdl(); logLine("edits cleared"); }
function removeEdit(i) { edl.splice(i, 1); renderEdl(); }

function enforceEdits() {
  if (!buffer) return;
  const t = progress * durationSec;
  if (!scrubbing) {                                    // don't fight a manual scrub
    for (const e of edl) if (e.type === "cut" && t >= e.from && t < e.to) { seek(e.to / durationSec); return; }
    const loop = [...edl].reverse().find((e) => e.type === "loop");
    if (loop && t >= loop.to) seek(loop.from / durationSec);
  }
  let g = 1;
  for (const e of edl) {
    if (e.type === "mute" && t >= e.from && t < e.to) g = 0;
    else if (e.type === "fade" && t >= e.from && t < e.to) g = Math.min(g, 1 - (t - e.from) / (e.to - e.from));
    else if (e.type === "fade" && t >= e.to) g = Math.min(g, 0);
  }
  master.gain.setTargetAtTime(g, ctx.currentTime, 0.02);
}

const EDIT_COLORS = { loop: "rgba(124,214,160,0.18)", cut: "rgba(255,107,138,0.20)", mute: "rgba(140,140,160,0.22)", fade: "rgba(107,168,255,0.18)" };
function renderEdl() {
  const grid = analysis?.bpm ? `grid: ${analysis.bpm} BPM · bar ${barSec().toFixed(2)}s` : "analyze for the beat grid";
  $("#gridInfo").textContent = grid;
  const list = $("#edlList");
  list.innerHTML = "";
  edl.forEach((e, i) => {
    const chip = document.createElement("span");
    chip.className = "chip " + e.type;
    chip.innerHTML = `${e.type} · ${fmt(e.from)}–${fmt(e.to)} <b data-i="${i}">✕</b>`;
    chip.querySelector("b").onclick = () => removeEdit(i);
    list.appendChild(chip);
  });
  if (!edl.length) list.innerHTML = '<span class="dim">no edits — try "loop the next 8 bars"</span>';
}

// ----- waveform -----
function drawWave() {
  const c = $("#wave"), g = c.getContext("2d");
  c.width = c.clientWidth;
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!buffer) {
    g.fillStyle = "rgba(164,124,255,0.12)"; g.fillRect(0, H / 2, W, 1);
    g.fillStyle = "rgba(226,223,255,0.45)";
    g.font = "13px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("drop a track · paste a URL · or speak to the deck", W / 2, H / 2);
    return;
  }
  drawPeaks(g, buffer.getChannelData(0), W, H, "rgba(164,124,255,0.55)");
  if (analysis?.bpm) {                                 // beat-grid: bar lines
    const bs = barSec();
    g.fillStyle = "rgba(164,124,255,0.12)";
    for (let t = 0; t <= durationSec; t += bs) g.fillRect((t / durationSec) * W, 0, 1, H);
  }
}
function drawPeaks(g, data, W, H, color) {
  const step = Math.max(1, Math.floor(data.length / W));
  g.fillStyle = color;
  for (let x = 0; x < W; x++) {
    let min = 1, max = -1;
    for (let i = 0; i < step; i++) { const v = data[x * step + i]; if (v < min) min = v; if (v > max) max = v; }
    g.fillRect(x, (1 + min) * H / 2, 1, Math.max(1, (max - min) * H / 2));
  }
}
function drawRegions(g, W, H) {
  if (!buffer) return;
  for (const e of edl) {
    g.fillStyle = EDIT_COLORS[e.type] || "rgba(255,255,255,0.1)";
    const x = (e.from / durationSec) * W, w = Math.max(2, ((e.to - e.from) / durationSec) * W);
    g.fillRect(x, 0, w, H);
  }
}
function tick() {
  if (buffer) {
    enforceEdits();
    $("#cur").textContent = fmt(progress * durationSec);
    const c = $("#wave"), g = c.getContext("2d");
    drawWave();
    drawRegions(g, c.width, c.height);
    const x = progress * c.width;
    g.fillStyle = "#E4DFFF"; g.fillRect(x, 0, 2, c.height);  // playhead
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ----- vocal recording (record a take over the playing track) -----
let mediaRec = null, recChunks = [], takeBuffer = null, takeSource = null, takePlaying = false;

async function toggleRec() {
  if (mediaRec && mediaRec.state === "recording") { mediaRec.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { logLine("mic blocked: " + e.message); return; }
  recChunks = [];
  mediaRec = new MediaRecorder(stream);
  mediaRec.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  mediaRec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(recChunks, { type: mediaRec.mimeType || "audio/webm" });
    try { takeBuffer = await ctx.decodeAudioData(await blob.arrayBuffer()); }
    catch (e) { logLine("take decode failed: " + e.message); return; }
    const url = URL.createObjectURL(blob);
    const a = $("#takeSave"); a.href = url;
    $("#takeLen").textContent = `${takeBuffer.duration.toFixed(1)}s`;
    $("#takeWrap").hidden = false;
    drawTake();
    $("#rec").classList.remove("on"); $("#rec").textContent = "● REC vocal";
    logLine(`recorded take: ${takeBuffer.duration.toFixed(1)}s`);
  };
  mediaRec.start();
  $("#rec").classList.add("on"); $("#rec").textContent = "■ stop";
  logLine("recording… (sing over the track)");
}
function drawTake() {
  if (!takeBuffer) return;
  const c = $("#take"), g = c.getContext("2d");
  c.width = c.clientWidth;
  g.clearRect(0, 0, c.width, c.height);
  drawPeaks(g, takeBuffer.getChannelData(0), c.width, c.height, "rgba(107,168,255,0.65)");
}
function playTake() {
  if (!takeBuffer) return;
  if (takePlaying && takeSource) { try { takeSource.stop(); } catch (e) {} return; }
  if (ctx.state === "suspended") ctx.resume();
  takeSource = ctx.createBufferSource();
  takeSource.buffer = takeBuffer;
  takeSource.connect(master);
  takeSource.onended = () => { takePlaying = false; $("#takePlay").textContent = "▶"; };
  takeSource.start();
  takePlaying = true; $("#takePlay").textContent = "■";
}

// ===================================================================
// LOCAL command parser — no LLM, no key. Maps a sentence to a deck
// action; resolveAction() is the swappable seam to the hbar brain.
// ===================================================================
function mapCommand(text) {
  const t = " " + text.toLowerCase().trim() + " ";
  const has = (...w) => w.some((x) => t.includes(x));
  const numAfter = (re) => { const m = t.match(re); return m ? parseFloat(m[1]) : null; };

  let sName = null;
  if (/\bdrum/.test(t)) sName = "drums";
  else if (/\bbass\b/.test(t)) sName = "bass";
  else if (/\bvocal|acapella|aca?pella|\bvox\b|\bvoice\b/.test(t)) sName = "vocals";
  else if (/\bother|melod|synth|instrument/.test(t)) sName = "other";

  // 1) info read-back
  if (has("what", "tell me", "which", "info", "how fast")) {
    if (has("key")) return { action: "read_info", info_field: "key" };
    if (has("bpm", "tempo", "fast")) return { action: "read_info", info_field: "bpm" };
    if (has("vibe", "feel", "mood", "impression", "genre")) return { action: "read_info", info_field: "impressions" };
    return { action: "read_info", info_field: "all" };
  }

  // 2) analyze / stems / key-lock
  if (has("analyze", "identify", "what is this track")) return { action: "analyze", spoken_reply: "analyzing" };
  if (has("split", "separate", "stem")) return { action: "split", spoken_reply: "splitting stems" };
  if (has("key lock", "keylock", "master tempo", "lock the key", "lock key"))
    return { action: "keylock", on: !has("off", "unlock", "disable"), spoken_reply: has("off", "unlock", "disable") ? "key lock off" : "key lock on" };

  // 3) stems by name
  if (sName) {
    if (has("just ", "only ", "solo", "isolate", "acapella", "acappella"))
      return { action: "stem", stem_name: sName, stem_mode: "solo", spoken_reply: `solo ${sName}` };
    if (has("drop ", "kill", "mute", "lose ", "remove", "without", "take out", "no "))
      return { action: "stem", stem_name: sName, stem_mode: "mute", spoken_reply: `mute ${sName}` };
    if (has("bring back", "unmute", "add ", "return", "back in"))
      return { action: "stem", stem_name: sName, stem_mode: "unmute", spoken_reply: `${sName} back` };
    return { action: "stem", stem_name: sName, stem_mode: "toggle", spoken_reply: `toggle ${sName}` };
  }

  // 3.5) beat-grid edits (loop / cut / mute / fade over N bars)
  {
    const bars = numAfter(/(\d+)\s*bars?/) ?? numAfter(/(?:loop|cut|mute|skip|fade)\s+(?:the\s+)?(?:next\s+|last\s+)?(\d+)/);
    if (has("clear") && has("edit", "edits", "loop", "all")) return { action: "clear_edits", spoken_reply: "edits cleared" };
    if (has("fade out", "fade it out")) return { action: "edit", edit: "fade", bars: bars || 8, spoken_reply: `fade out ${bars || 8} bars` };
    if (has("loop") && (bars != null || has("here", "this"))) return { action: "edit", edit: "loop", bars: bars || 4, spoken_reply: `loop ${bars || 4} bars` };
    if (has("cut", "skip") && bars != null) return { action: "edit", edit: "cut", bars, spoken_reply: `cut ${bars} bars` };
    if (has("mute", "silence") && bars != null) return { action: "edit", edit: "mute", bars, spoken_reply: `mute ${bars} bars` };
  }

  // 4) pitch / transpose (semitones)
  if (has("pitch", "transpose", "semitone", "key up", "key down", "higher", "lower")) {
    const n = numAfter(/(-?\d+(?:\.\d+)?)\s*(?:semitone|step|st\b)/)
      ?? numAfter(/(?:up|down|by)\s+(\d+(?:\.\d+)?)/) ?? 1;
    const down = has("down", "lower", "drop");
    return { action: "transpose", delta: down ? -Math.abs(n) : Math.abs(n), spoken_reply: `${down ? "down" : "up"} ${Math.abs(n)} st` };
  }

  // 5) tempo / speed
  if (has("tempo", "speed", "faster", "slower", "double time", "half time", "halftime", "slow it", "speed it", "stretch", "compress")) {
    let v = tempo;
    if (has("normal", "original", "reset", "back to normal")) v = 1;
    else if (has("half")) v = 0.5;
    else if (has("double", "twice")) v = 2;
    else if (has("faster", "speed up", "speed it up", "compress")) v = tempo + 0.05;
    else if (has("slower", "slow down", "slow it", "stretch")) v = tempo - 0.05;
    const n = numAfter(/to\s+(\d+(?:\.\d+)?)\s*(?:x|times|percent|%)?/);
    if (n != null) v = n > 3 ? n / 100 : n;  // "to 90 percent" or "to 1.1x"
    return { action: "set_tempo", tempo: v, spoken_reply: `tempo ${v.toFixed(2)}x` };
  }

  // 6) transport
  if (has("restart", "take it back", "start over", "from the top", "from the beginning")) return { action: "restart", spoken_reply: "from the top" };
  if (has("pause", "hold", "wait", "freeze")) return { action: "pause", spoken_reply: "paused" };
  if (has("stop")) return { action: "stop", spoken_reply: "stopped" };
  if (has("play", "go", "start", "run it", "resume", "let's go", "hit it", "drop it")) return { action: "play", spoken_reply: "playing" };

  return { action: "noop", spoken_reply: "didn't catch that" };
}

// The deck's action grammar — the single source of truth for what the deck can
// do. Sent to the brain so it can map open-ended editing language onto these
// exact actions. Keep in sync with applyAction()'s switch.
const GRAMMAR = [
  "play", "pause", "stop", "restart",
  "set_tempo{tempo: 0.5..2}", "transpose{delta: semitones}", "keylock{on: bool}",
  "edit{edit: loop|cut|mute|fade, bars: int}", "clear_edits",
  "split", "stem{stem_name: drums|bass|vocals|other, stem_mode: solo|mute|unmute|toggle}",
  "analyze", "read_info{info_field: key|bpm|impressions|all}",
];

// normalise any brain/parser return into a flat action array
function asActions(x) { return Array.isArray(x) ? x : x && Array.isArray(x.actions) ? x.actions : x ? [x] : []; }

// LOCAL compound parsing: split a sentence on connectors and map each clause,
// so "loop the next 8 bars and mute the vocals" → two actions. No key, no model.
function mapCommandSeq(text) {
  const clauses = text.split(/\s*(?:,|;|\b(?:and then|and|then|after that)\b)\s*/i).map((s) => s.trim()).filter(Boolean);
  const acts = clauses.map(mapCommand).filter((a) => a.action !== "noop");
  return acts.length ? acts : [mapCommand(text)];
}

// the swappable seam — local compound parser by default; the brain (if wired)
// gets {text, state, grammar} and returns {actions:[...]} (or one action).
async function resolveAction(text) {
  const brain = window.DJ_BRAIN_URL;
  if (brain) {
    try {
      const state = { mode, playing, tempo, semitones, keyLock, bpm: analysis?.bpm, key: analysis?.key, hasStems: !!stemShifters, edits: edl.length, t: progress * durationSec };
      const r = await fetch(brain, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, state, grammar: GRAMMAR }),
      });
      if (r.ok) { const got = asActions(await r.json()); if (got.length) return got; }
      logLine("brain gave nothing — local parser");
    } catch (e) { logLine("brain error — local parser"); }
  }
  return mapCommandSeq(text);
}

function applyAction(a) {
  $("#actionOut").textContent = `${a.action}${a.spoken_reply ? " — " + a.spoken_reply : ""}`;
  switch (a.action) {
    case "play": play(); break;
    case "pause": pause(); break;
    case "stop": stop(); break;
    case "restart": restart(); break;
    case "set_tempo": setTempo(a.tempo ?? 1); break;
    case "transpose": setSemitones(semitones + (a.delta ?? 0)); break;
    case "keylock": setKeyLock(!!a.on); break;
    case "edit": addEdit(a.edit, a.bars); break;
    case "clear_edits": clearEdits(); break;
    case "split": splitStems(); break;
    case "stem": stem(a.stem_name, a.stem_mode || "toggle"); break;
    case "analyze": analyze(); break;
    case "read_info": {
      const f = a.info_field || "all";
      const msg = !analysis ? "not analyzed yet"
        : f === "key" ? `key is ${analysis.key}`
        : f === "bpm" ? `${analysis.bpm} BPM`
        : f === "impressions" ? (analysis.impressions?.one_liner || "no impressions")
        : `${analysis.key}, ${analysis.bpm} BPM`;
      logLine("info: " + msg); say(msg);
      return;  // skip the generic spoken_reply below
    }
    default: break;
  }
  if (a.spoken_reply) { logLine("» " + a.spoken_reply); say(a.spoken_reply); }
}

// ----- voice + log -----
function logLine(t) { const d = document.createElement("div"); d.textContent = t; $("#log").prepend(d); }
function say(t) { try { speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } catch (e) {} }

async function sendCommand(text) {
  if (!text.trim()) return;
  $("#heard").textContent = text;
  logLine("heard: " + text);
  try {
    const actions = await resolveAction(text);
    actions.forEach(applyAction);
    if (actions.length > 1) $("#actionOut").textContent = `${actions.length} actions: ` + actions.map((a) => a.action).join(" → ");
  } catch (e) { logLine("error: " + e.message); }
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
if (SR) {
  rec = new SR();
  rec.lang = "en-US"; rec.interimResults = false; rec.maxAlternatives = 1;
  rec.onresult = (e) => sendCommand(e.results[0][0].transcript);
  rec.onend = () => $("#mic").classList.remove("live");
} else {
  $("#mic").textContent = "no speech API — type below";
  $("#mic").disabled = true;
}
$("#mic").onclick = () => { if (!rec) return; $("#mic").classList.add("live"); try { rec.start(); } catch (e) { $("#mic").classList.remove("live"); } };

// ----- wiring -----
$("#play").onclick = () => (playing ? pause() : play());
$("#stop").onclick = stop;
$("#restart").onclick = restart;
$("#tempo").oninput = (e) => setTempo(parseFloat(e.target.value));
$("#tempoReset").onclick = () => setTempo(1);
$("#pitch").oninput = (e) => setSemitones(parseFloat(e.target.value));
$("#pitchReset").onclick = () => setSemitones(0);
$("#transDown").onclick = () => nudgeTranspose(-1);
$("#transUp").onclick = () => nudgeTranspose(1);
$("#keyLock").onchange = (e) => setKeyLock(e.target.checked);
$("#resetAll").onclick = resetAll;
$("#splitBtn").onclick = splitStems;
$("#rec").onclick = toggleRec;
$("#takePlay").onclick = playTake;
document.querySelectorAll("[data-edit]").forEach((b) => {
  const [type, n] = b.dataset.edit.split(":");
  b.onclick = () => addEdit(type, parseInt(n, 10));
});
$("#clearEdits").onclick = clearEdits;
document.querySelectorAll(".stem").forEach((b) => (b.onclick = () => stem(b.dataset.stem, "toggle")));
$("#analyzeBtn").onclick = analyze;
$("#typeCmd").onkeydown = (e) => { if (e.key === "Enter") { sendCommand(e.target.value); e.target.value = ""; } };

// drag the waveform with the cursor to scrub / jog the track (click also seeks)
let scrubbing = false;
function seekFromEvent(e) {
  const r = $("#wave").getBoundingClientRect();
  seek(clamp((e.clientX - r.left) / r.width, 0, 1));
}
$("#wave").addEventListener("pointerdown", (e) => {
  if (!buffer) return;
  scrubbing = true;
  $("#wave").setPointerCapture(e.pointerId);
  $("#wave").style.cursor = "grabbing";
  seekFromEvent(e);
});
$("#wave").addEventListener("pointermove", (e) => { if (scrubbing) seekFromEvent(e); });
$("#wave").addEventListener("pointerup", () => { scrubbing = false; $("#wave").style.cursor = "grab"; });
$("#wave").addEventListener("pointercancel", () => { scrubbing = false; $("#wave").style.cursor = "grab"; });

$("#ytLoad").onclick = async () => {
  const url = $("#ytUrl").value.trim();
  if (!url) return;
  $("#trackTitle").textContent = "pulling…";
  try {
    const r = await fetch("/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
    const t = await r.json();
    if (!r.ok) throw new Error(t.detail || "download failed");
    await setTrack(t);
  } catch (e) { $("#trackTitle").textContent = "failed: " + e.message; }
};

// drag-drop / file pick
const dz = $("#dropZone");
$("#fileInput").onchange = (e) => e.target.files[0] && uploadFile(e.target.files[0]);
["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => e.dataTransfer.files[0] && uploadFile(e.dataTransfer.files[0]));
async function uploadFile(file) {
  $("#trackTitle").textContent = "uploading…";
  const fd = new FormData(); fd.append("file", file);
  try {
    const r = await fetch("/upload", { method: "POST", body: fd });
    const t = await r.json();
    if (!r.ok) throw new Error(t.detail || "upload failed");
    await setTrack(t);
  } catch (e) { $("#trackTitle").textContent = "failed: " + e.message; }
}

window.addEventListener("resize", () => { drawWave(); drawTake(); });
setKeyLock(true);  // initialise labels/enabled state
renderEdl();       // initialise the beat-grid edit panel
