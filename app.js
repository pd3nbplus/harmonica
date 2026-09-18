'use strict';

/* ============================================================
 * 守夜人口琴 · NIGHT WATCH HARMONICA —— 运行逻辑
 * ------------------------------------------------------------
 * 核心机制：
 *  - Z X C V B N M ,  八个键 = do re mi fa sol la si do（按住发声，松开即止）
 *  - 鼠标左键按住 = 整体降八度；右键按住 = 整体升八度；中键按住 = 全部升半音
 *  - 三个鼠标修饰键互不影响、可叠加，松开立即还原
 * 音频：Web Audio API 实时合成（正弦基频 + 递减泛音 + 气流噪声 + 长音颤音）
 * ============================================================ */

/* ---------- 基础数据 ---------- */
const KEY_MAP = { z:0, x:1, c:2, v:3, b:4, n:5, m:6, ',':7 };
const KEY_LABELS = ['Z','X','C','V','B','N','M',','];
const BASE_MIDI = [60, 62, 64, 65, 67, 69, 71, 72]; // C4 D4 E4 F4 G4 A4 B4 C5
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
const midiName = m => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

// 乐谱音符解析：'|' = 小节线、'-' = 休止（两者不经过本函数）
// 键位后缀/前缀（可叠加）：'X_' = 降调(降八度)、'X^' = 升调(升八度)、'#X' = 升半音、'bX' = 降半音
// 例：'#V_' = 低八度的 F#3；'bB' = F#4；',^' = C6
const parseNote = t => {
  let acc = 0, oct = 0, i = 0;
  if(t[0] === '#'){ acc = 1; i = 1; }
  else if(t[0] === 'b'){ acc = -1; i = 1; }
  const key = t[i];
  for(let j = i + 1; j < t.length; j++){
    if(t[j] === '_') oct--;
    else if(t[j] === '^') oct++;
  }
  return { key, acc, oct };
};

/* ---------- 修饰键状态（鼠标三键，类似 Shift） ---------- */
const State = {
  left:false, right:false, mid:false,
  get octave(){ return (this.left && this.right) ? 0 : this.left ? -1 : this.right ? 1 : 0; },
  get sharp(){ return this.mid; }
};
const effectiveMidi = idx => BASE_MIDI[idx] + State.octave * 12 + (State.sharp ? 1 : 0);

/* ---------- 音频引擎 ---------- */
const AudioEngine = {
  ctx:null, master:null, noiseBuffer:null,

  ensure(){
    if(!this.ctx){
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      // 轻微饱和，增加簧片般的“金属芯”
      const shaper = this.ctx.createWaveShaper();
      const n = 256, curve = new Float32Array(n), k = 2.0;
      for(let i = 0; i < n; i++){
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(k * x) / Math.tanh(k);
      }
      shaper.curve = curve;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -20; comp.knee.value = 16; comp.ratio.value = 5;
      comp.attack.value = 0.004; comp.release.value = 0.22;
      this.master.connect(shaper); shaper.connect(comp); comp.connect(this.ctx.destination);
      // 共享白噪声 buffer（气流声）
      const len = this.ctx.sampleRate * 2;
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuffer.getChannelData(0);
      for(let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if(this.ctx.state === 'suspended') this.ctx.resume();
  },

  noteOn(keyIndex, midi, when){
    if(!this.ctx) return null;
    const t = when == null ? this.ctx.currentTime : Math.max(when, this.ctx.currentTime);
    const freq = midiToFreq(midi);
    const v = { keyIndex, midi, oscs:[], alive:true };

    // 音头：20~50ms 气声渐入
    const toneGain = this.ctx.createGain();
    toneGain.gain.setValueAtTime(0.0001, t);
    toneGain.gain.linearRampToValueAtTime(0.5, t + 0.032);
    toneGain.connect(this.master);
    v.toneGain = toneGain;

    // 基频正弦波（主音色）+ 第二泛音 0.15 + 第三泛音 0.05
    const partials = [[1,1],[2,0.15],[3,0.05]];
    const jitter = (Math.random() - 0.5) * 6;
    for(const [mult, g] of partials){
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * mult, t);
      o.detune.value = jitter;
      const og = this.ctx.createGain();
      og.gain.value = g;
      o.connect(og); og.connect(toneGain);
      o.start(t);
      v.oscs.push({ o, mult });
    }

    // 气流噪声：白噪声 + 带通（中心频率 = 基频×2，Q=2，增益 0.08）
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer; noise.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(freq * 2, t);
    bp.Q.value = 2;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.08, t + 0.02);
    noise.connect(bp); bp.connect(ng); ng.connect(this.master);
    noise.start(t);
    v.noise = noise; v.noiseGain = ng; v.bp = bp;

    // 长音颤音：LFO 5.5Hz 调制音高，深度 = 基频的 0.8%（≈13.8 音分，长音后渐入）
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const lfoDepth = this.ctx.createGain();
    lfoDepth.gain.setValueAtTime(0, t);
    lfoDepth.gain.linearRampToValueAtTime(1200 * Math.log2(1.008), t + 0.75);
    lfo.connect(lfoDepth);
    v.oscs.forEach(({ o }) => lfoDepth.connect(o.detune));
    lfo.start(t);
    // LFO 4.5Hz 调制音量，深度 0.03
    const lfo2 = this.ctx.createOscillator();
    lfo2.frequency.value = 4.5;
    const lfo2Depth = this.ctx.createGain();
    lfo2Depth.gain.setValueAtTime(0, t);
    lfo2Depth.gain.linearRampToValueAtTime(0.03, t + 0.85);
    lfo2.connect(lfo2Depth); lfo2Depth.connect(toneGain.gain);
    lfo2.start(t);
    v.lfos = [lfo, lfo2];

    return v;
  },

  // force=true：强制停止（用于停止自动演奏/回放），即使已排程过 future 释音也立即取消事件并停振
  noteOffVoice(v, when, force){
    if(!v || !this.ctx) return;
    if(!v.alive && !force) return;
    v.alive = false;
    const t = when == null ? this.ctx.currentTime : Math.max(when, this.ctx.currentTime);
    const rel = 0.09 + Math.random() * 0.05; // 松键后 80~150ms 平滑衰减
    const g = v.toneGain.gain;
    if(g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
    g.linearRampToValueAtTime(0.0001, t + rel);
    const ng = v.noiseGain.gain;
    if(ng.cancelAndHoldAtTime) ng.cancelAndHoldAtTime(t);
    else { ng.cancelScheduledValues(t); ng.setValueAtTime(ng.value, t); }
    ng.linearRampToValueAtTime(0.0001, t + rel * 0.75);
    const stopAt = t + rel + 0.1;
    v.oscs.forEach(({ o }) => { try{ o.stop(stopAt); }catch(e){} });
    try{ v.noise.stop(stopAt); }catch(e){}
    v.lfos.forEach(l => { try{ l.stop(stopAt); }catch(e){} });
  },

  // 修饰键变化时，所有正在按住的发音平滑滑到新音高（50ms 滑音）
  repitch(){
    if(!this.ctx) return;
    const t = this.ctx.currentTime;
    heldVoices.forEach((v, k) => {
      const f = midiToFreq(effectiveMidi(k));
      v.oscs.forEach(({ o, mult }) => {
        o.frequency.cancelScheduledValues(t);
        o.frequency.setValueAtTime(o.frequency.value, t);
        o.frequency.linearRampToValueAtTime(f * mult, t + 0.05);
      });
      const bp = v.bp.frequency;
      bp.cancelScheduledValues(t);
      bp.setValueAtTime(bp.value, t);
      bp.linearRampToValueAtTime(f * 2, t + 0.05);
    });
  }
};

/* ---------- DOM 引用 ---------- */
const $ = id => document.getElementById(id);
const harpSvg = $('harmonica'), holesG = $('holes'), posRange = $('posRange'), posSharp = $('posSharp'),
      curNote = $('curNote'), bigNote = $('bigNote'), modeTag = $('modeTag'),
      songTabs = $('songTabs'), songNotes = $('songNotes'), songHint = $('songHint'),
      autoBtn = $('autoBtn'), followBtn = $('followBtn'),
      recBtn = $('recBtn'), playRecBtn = $('playRecBtn'), recStatus = $('recStatus'),
      modL = $('modL'), modR = $('modR'), modM = $('modM');

/* ---------- 口琴 SVG 构建 ---------- */
const NS = 'http://www.w3.org/2000/svg';
const holeEls = [];
const holeNoteEls = []; // 孔内音符标签，随把位（八度/半音）实时刷新
function svgEl(tag, attrs){
  const e = document.createElementNS(NS, tag);
  for(const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function buildHarmonica(){
  for(let i = 0; i < 8; i++){
    const cx = 130 + i * 75;
    const g = svgEl('g', { 'class':'hole' });
    g.appendChild(svgEl('ellipse', { 'class':'hole-glow', cx:cx, cy:121, rx:42, ry:46 }));
    const mouth = svgEl('rect', { 'class':'hole-mouth', x:cx - 23, y:86, width:46, height:70, rx:10 });
    mouth.setAttribute('fill', 'url(#mouthGrad)');
    mouth.setAttribute('stroke', '#100b04');
    mouth.setAttribute('stroke-width', '2');
    g.appendChild(mouth);
    // 孔位编号 / 音符 / 键位 全部写在孔内
    g.appendChild(svgEl('line', { 'class':'hole-sep', x1:cx - 14, y1:107, x2:cx + 14, y2:107 }));
    g.appendChild(svgEl('line', { 'class':'hole-sep', x1:cx - 14, y1:126, x2:cx + 14, y2:126 }));
    const num = svgEl('text', { 'class':'hole-num', x:cx, y:101 });
    num.textContent = String(i + 1).padStart(2, '0');
    const note = svgEl('text', { 'class':'hole-note-in', x:cx, y:120 });
    note.textContent = midiName(BASE_MIDI[i]);
    const key = svgEl('text', { 'class':'hole-key-in', x:cx, y:144 });
    key.textContent = KEY_LABELS[i];
    g.appendChild(num); g.appendChild(note); g.appendChild(key);
    holesG.appendChild(g);
    holeEls.push(g);
    holeNoteEls.push(note);
  }
}
function holeOn(i){ if(holeEls[i]) holeEls[i].classList.add('active'); }
function holeOff(i){ if(holeEls[i]) holeEls[i].classList.remove('active'); }

/* ---------- 状态显示 ---------- */
const heldVoices = new Map(); // keyIndex -> voice（复音）
let lastKey = null;

function heldKeyToShow(){
  if(lastKey != null && heldVoices.has(lastKey)) return lastKey;
  const it = heldVoices.keys().next();
  return it.done ? null : it.value;
}
function refreshStatus(){
  const oct = State.octave, sh = State.sharp;
  const base = oct * 12 + (sh ? 1 : 0);
  const range = midiName(BASE_MIDI[0] + base) + '~' + midiName(BASE_MIDI[7] + base);
  posRange.textContent = (oct === -1 ? '↓ ' : '') + range + (oct === 1 ? ' ↑' : '');
  posSharp.textContent = sh ? ' · 升半音 #' : '';
  // 孔内音符标签随把位实时变化（低八度 C3~C3 / 升半音 C#4~C#5 等），修饰生效时整体染金
  holeNoteEls.forEach((el, i) => { el.textContent = midiName(BASE_MIDI[i] + base); });
  harpSvg.classList.toggle('modded', base !== 0);
  const k = heldKeyToShow();
  if(k == null){
    curNote.textContent = '—';
    if(Performer.mode === 'idle') bigNote.textContent = '—';
    return;
  }
  const m = effectiveMidi(k);
  const mods = [];
  if(oct === -1) mods.push('低八度');
  if(oct === 1) mods.push('高八度');
  if(sh) mods.push('升半音');
  curNote.textContent = KEY_LABELS[k] + ' → ' + midiName(m) + (mods.length ? '（' + mods.join('·') + '）' : '');
  bigNote.textContent = midiName(m);
}
function refreshMods(){
  modL.classList.toggle('on', State.left && !State.right);
  modR.classList.toggle('on', State.right && !State.left);
  modM.classList.toggle('on', State.sharp);
}
function setModeTag(t){ modeTag.textContent = t; }
function onModifiersChanged(){
  AudioEngine.repitch(); // 已按住的音立即滑到新把位
  refreshStatus();
  refreshMods();
}

/* ---------- 键盘输入 ---------- */
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if(!(k in KEY_MAP)) return;
  e.preventDefault();
  if(e.repeat) return;
  AudioEngine.ensure();
  takeover();
  const idx = KEY_MAP[k];
  if(heldVoices.has(idx)) return;
  const v = AudioEngine.noteOn(idx, effectiveMidi(idx));
  heldVoices.set(idx, v);
  lastKey = idx;
  Recorder.onNoteOn(idx);
  holeOn(idx);
  Follow.check(k);
  refreshStatus();
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if(!(k in KEY_MAP)) return;
  const idx = KEY_MAP[k];
  const v = heldVoices.get(idx);
  if(!v) return;
  AudioEngine.noteOffVoice(v);
  heldVoices.delete(idx);
  Recorder.onNoteOff(idx);
  if(!Performer.hasKey(idx)) holeOff(idx);
  refreshStatus();
});

/* ---------- 鼠标修饰键 ---------- */
document.addEventListener('mousedown', e => {
  if(e.button === 0) State.left = true;
  else if(e.button === 1){ State.mid = true; e.preventDefault(); }
  else if(e.button === 2){ State.right = true; e.preventDefault(); }
  else return;
  AudioEngine.ensure();
  // 页面内任意按下即接管（按钮除外——按钮的停止/切换由各自 click 处理）
  if(!(e.target instanceof Element) || !e.target.closest('button')) takeover();
  onModifiersChanged();
});
document.addEventListener('mouseup', e => {
  if(e.button === 0) State.left = false;
  else if(e.button === 1){ State.mid = false; e.preventDefault(); }
  else if(e.button === 2) State.right = false;
  else return;
  onModifiersChanged();
});
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('auxclick', e => e.preventDefault());
window.addEventListener('blur', releaseHeld);
document.addEventListener('visibilitychange', () => { if(document.hidden) releaseHeld(); });

// 窗口失焦 / 页面隐藏（用户在页面外操作）：只松开手动按住的音、复位修饰键，
// 不打断自动演奏/回放——音频走 Web Audio 时钟已排程，页面外操作不应使其停止
function releaseHeld(){
  State.left = State.right = State.mid = false;
  heldVoices.forEach(v => AudioEngine.noteOffVoice(v));
  heldVoices.clear();
  // 熄灭高亮时保留自动演奏/回放正在发声的孔
  holeEls.forEach((h, i) => {
    const autoSounding = [...Performer.voices].some(v => v.keyIndex === i);
    if(!autoSounding) h.classList.remove('active');
  });
  refreshStatus(); refreshMods();
}

/* ---------- 乐谱 UI ---------- */
let currentSong = null;
let chipEls = []; // 音符 chip（不含小节线），dataset.idx 记录其在 notes 中的原始下标

function buildSongs(){
  SONGS.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'tab';
    b.innerHTML = s.name + '<small>' + s.en + ' · ' + s.bpm + 'BPM</small>';
    b.addEventListener('click', () => selectSong(i));
    songTabs.appendChild(b);
  });
  selectSong(0);
}
function selectSong(i){
  currentSong = SONGS[i];
  Performer.stop();
  if(Follow.active) Follow.stop();
  else { renderChips(-1); setExpected(null); setModeTag('自由演奏'); }
  [...songTabs.children].forEach((b, j) => b.classList.toggle('on', i === j));
  songNotes.innerHTML = '';
  chipEls = [];
  let mEl = null, mCount = 0;
  const newMeasure = () => { // 另起一小节：左侧小节线 + 小节编号
    mEl = document.createElement('div');
    mEl.className = 'measure';
    const no = document.createElement('span');
    no.className = 'measure-no';
    no.textContent = String(++mCount).padStart(2, '0');
    mEl.appendChild(no);
    songNotes.appendChild(mEl);
  };
  newMeasure();
  currentSong.notes.forEach((nd, i) => {
    if(nd === '|'){ // 小节线：结束当前小节
      if(mEl.children.length > 1) newMeasure();
      return;
    }
    const c = document.createElement('span');
    const isRest = nd[0] === '-';
    c.dataset.idx = i;
    if(isRest){
      c.dataset.kind = 'rest';
      c.textContent = '–';
    } else {
      const pk = parseNote(nd[0]);
      // 降调（低八度）单独归为 down 显示为蓝色，升半音/降半音/升调仍为 acc 橙色
      c.dataset.kind = pk.oct < 0 ? 'down' : (pk.acc !== 0 || pk.oct > 0) ? 'acc' : 'note';
      // 键位为主 + 角标：右上 = 半音/升调，右下 = 降调
      const main = document.createElement('b');
      main.textContent = pk.key;
      c.appendChild(main);
      const sup = (pk.acc === 1 ? '♯' : pk.acc === -1 ? '♭' : '') + (pk.oct > 0 ? '↑' : '');
      if(sup){ const s = document.createElement('sup'); s.className = 'chip-sup'; s.textContent = sup; c.appendChild(s); }
      if(pk.oct < 0){ const s = document.createElement('sub'); s.className = 'chip-sub'; s.textContent = '↓'; c.appendChild(s); }
    }
    mEl.appendChild(c);
    chipEls.push(c);
  });
  if(mEl && mEl.children.length <= 1 && mEl.parentNode) mEl.parentNode.removeChild(mEl); // 去掉末尾空小节
  hint('已选择《' + currentSong.name + '》· 点「跟弹引导」逐音练习，或「自动演奏」');
}
function renderChips(cursor){
  chipEls.forEach(c => {
    const i = Number(c.dataset.idx);
    c.className = ['chip',
      c.dataset.kind === 'acc' ? 'accidental' : '',
      c.dataset.kind === 'down' ? 'down' : '',
      i < cursor ? 'done' : '',
      i === cursor ? 'current' : ''].filter(Boolean).join(' ');
  });
}
function setExpected(idx){
  holeEls.forEach((h, i) => h.classList.toggle('expected', i === idx));
}
function hint(t){ songHint.textContent = t; }

/* ---------- 跟弹引导 ---------- */
const Follow = {
  active:false, song:null, cursor:0,

  start(song, idx = 0){
    this.song = song; this.active = true; this.cursor = idx;
    this.skipRests();
    this.mark();
    setModeTag('跟弹引导');
    followBtn.classList.add('on'); followBtn.textContent = '■ 停止引导';
    hint('跟弹中：按下金色高亮键（鼠标修饰键同样生效）');
  },
  stop(){
    this.active = false; this.song = null; this.cursor = 0;
    followBtn.classList.remove('on'); followBtn.textContent = '✋ 跟弹引导';
    renderChips(-1); setExpected(null);
    setModeTag('自由演奏');
    hint('已选择《' + currentSong.name + '》');
  },
  // 跳过休止符与小节线（两者都不需要按键）
  skipRests(){
    const n = this.song.notes;
    while(this.cursor < n.length && (n[this.cursor] === '|' || n[this.cursor][0] === '-')) this.cursor++;
  },
  check(k){
    if(!this.active) return;
    const n = this.song.notes;
    if(this.cursor >= n.length) return;
    if(k.toUpperCase() === parseNote(n[this.cursor][0]).key){
      this.cursor++;
      this.skipRests();
      if(this.cursor >= n.length){ this.finish(); return; }
      this.mark();
    }
  },
  finish(){
    this.active = false;
    renderChips(-1); setExpected(null);
    followBtn.classList.remove('on'); followBtn.textContent = '✋ 跟弹引导';
    setModeTag('自由演奏');
    hint('✓ 演奏完成');
  },
  mark(){
    renderChips(this.cursor);
    const n = this.song.notes;
    const tok = this.cursor < n.length ? n[this.cursor][0] : null;
    const pk = tok ? parseNote(tok).key : null;
    setExpected(pk && pk !== '-' ? KEY_MAP[pk.toLowerCase()] : null);
  }
};

/* ---------- 自动演奏 / 回放 调度器 ---------- */
const Performer = {
  mode:'idle', token:0, timers:[], voices:new Set(), voicesByKey:new Map(), lastCursor:0,

  later(fn, ms){
    const tok = this.token;
    const id = setTimeout(() => { if(tok === this.token) fn(); }, Math.max(0, ms));
    this.timers.push(id);
  },
  hasKey(idx){ return this.voicesByKey.has(idx); },

  stop(){
    this.token++;
    this.timers.forEach(clearTimeout); this.timers = [];
    // 强制停止所有已排程的 voice：取消未来的起振/释音事件，避免歌曲继续播完
    this.voices.forEach(v => AudioEngine.noteOffVoice(v, null, true));
    this.voices.clear(); this.voicesByKey.clear();
    // 熄灭自动演奏点亮的高亮，但保留用户正按住的音
    holeEls.forEach((h, i) => { if(!heldVoices.has(i)) h.classList.remove('active'); });
    if(this.mode === 'auto'){
      autoBtn.classList.remove('on'); autoBtn.textContent = '▶ 自动演奏';
    }
    this.mode = 'idle';
    if(!Follow.active) renderChips(-1);
  },

  playSong(song){
    this.stop();
    this.mode = 'auto';
    setModeTag('自动演奏');
    autoBtn.classList.add('on'); autoBtn.textContent = '■ 停止';
    hint('自动演奏中……点击页面任意处或按演奏键可随时接管');
    const beat = 60 / song.bpm, ctx = AudioEngine.ctx;
    let t = ctx.currentTime + 0.3;
    song.notes.forEach((nd, i) => {
      if(nd === '|') return; // 小节线：不占时值、不发声
      const key = nd[0], dur = nd[1] * beat;
      if(key !== '-'){
        const pk = parseNote(key); // 支持 '#X' 半音、'X_' 降调、'X^' 升调（可叠加）
        const idx = KEY_MAP[pk.key.toLowerCase()];
        const midi = BASE_MIDI[idx] + pk.acc + pk.oct * 12;
        const v = AudioEngine.noteOn(idx, midi, t);
        this.voices.add(v);
        AudioEngine.noteOffVoice(v, t + dur * 0.92);
        const onMs = (t - ctx.currentTime) * 1000;
        this.later(() => {
          this.voices.delete(v);
          this.lastCursor = i; renderChips(i);
          if(!heldVoices.has(idx)) holeOn(idx);
          bigNote.textContent = midiName(midi);
        }, onMs);
        this.later(() => { if(!heldVoices.has(idx)) holeOff(idx); }, onMs + dur * 920);
      } else {
        this.later(() => { this.lastCursor = i; renderChips(i); }, (t - ctx.currentTime) * 1000);
      }
      t += dur;
    });
    this.later(() => {
      this.stop(); renderChips(-1);
      setModeTag('自由演奏'); bigNote.textContent = '—';
      hint('演奏完毕 · 按「跟弹引导」试试自己弹一遍');
    }, (t - ctx.currentTime) * 1000 + 700);
  }
};

// 自动演奏 / 回放中，页面内任意点击（非按钮）或按下演奏键即接管
function takeover(){
  if(Performer.mode === 'idle') return;
  const wasAuto = Performer.mode === 'auto';
  const resume = Performer.lastCursor;
  Performer.stop();
  if(wasAuto && currentSong && !Follow.active){
    Follow.start(currentSong, resume || 0);
  } else {
    setModeTag(Follow.active ? '跟弹引导' : '自由演奏');
  }
  hint('已接管 · ' + (Follow.active ? '跟弹引导' : '自由演奏'));
}

/* ---------- 录音回放 ---------- */
const Recorder = {
  recording:false, events:[], t0:0, tick:null,

  toggle(){
    AudioEngine.ensure();
    if(!this.recording){
      Performer.stop(); // 页面内操作：开始录音前先停下自动演奏/回放
      this.recording = true; this.events = []; this.t0 = AudioEngine.ctx.currentTime;
      recBtn.classList.add('rec-on'); recBtn.textContent = '■ 停止';
      setModeTag('● 录音中');
      this.tick = setInterval(() => {
        const s = Math.max(0, AudioEngine.ctx.currentTime - this.t0);
        recStatus.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' +
                                String(Math.floor(s % 60)).padStart(2, '0');
      }, 250);
      hint('录音中……用 Z ~ , 演奏你的旋律，再按一次停止');
    } else {
      this.stopRec();
    }
  },
  stopRec(){
    this.recording = false;
    clearInterval(this.tick);
    recBtn.classList.remove('rec-on'); recBtn.textContent = '● REC';
    setModeTag(Follow.active ? '跟弹引导' : '自由演奏');
    if(this.events.length) playRecBtn.disabled = false;
    hint(this.events.length
      ? '已保存录音 · 点击「▶ 回放」试听'
      : '录音为空');
  },
  onNoteOn(idx){
    if(this.recording) this.events.push({ t:AudioEngine.ctx.currentTime, k:idx, m:0, midi:effectiveMidi(idx) });
  },
  onNoteOff(idx){
    if(this.recording) this.events.push({ t:AudioEngine.ctx.currentTime, k:idx, m:1 });
  },
  play(){
    if(!this.events.length) return;
    if(this.recording) this.stopRec();
    AudioEngine.ensure();
    Performer.stop();
    Performer.mode = 'playback';
    setModeTag('回放中');
    hint('回放中……点击页面任意处或按演奏键可随时接管');
    const t0 = this.events[0].t;
    for(const ev of this.events){
      const ms = (ev.t - t0) * 1000;
      if(ev.m === 0){
        Performer.later(() => {
          const v = AudioEngine.noteOn(ev.k, ev.midi);
          Performer.voices.add(v); Performer.voicesByKey.set(ev.k, v);
          holeOn(ev.k); bigNote.textContent = midiName(ev.midi);
        }, ms);
      } else {
        Performer.later(() => {
          const v = Performer.voicesByKey.get(ev.k);
          if(v){
            AudioEngine.noteOffVoice(v);
            Performer.voices.delete(v); Performer.voicesByKey.delete(ev.k);
          }
          if(!heldVoices.has(ev.k)) holeOff(ev.k);
        }, ms);
      }
    }
    const end = (this.events[this.events.length - 1].t - t0) * 1000 + 500;
    Performer.later(() => {
      Performer.mode = 'idle';
      setModeTag('自由演奏'); bigNote.textContent = '—';
    }, end);
  }
};

/* ---------- 面板按钮 ---------- */
followBtn.addEventListener('click', () => {
  if(!currentSong) return hint('请先选择曲目');
  if(Follow.active){ Follow.stop(); }
  else { Performer.stop(); Follow.start(currentSong, 0); }
});
autoBtn.addEventListener('click', () => {
  AudioEngine.ensure();
  if(!currentSong) return hint('请先选择曲目');
  if(Performer.mode === 'auto'){
    Performer.stop(); setModeTag('自由演奏'); hint('已停止自动演奏');
  } else {
    Performer.playSong(currentSong);
  }
});
recBtn.addEventListener('click', () => Recorder.toggle());
playRecBtn.addEventListener('click', () => Recorder.play());

/* ---------- 启动 ---------- */
buildHarmonica();
buildSongs();
refreshStatus();
refreshMods();
