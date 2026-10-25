/* KurzFiler for macOS — user interface. GPL v3 or later. */
(function () {
  'use strict';
  const K = window.KRZ;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  const isMac = /Mac/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);

  // ------------------------------------------------------------------ host (Electron or browser)
  const native = window.kfNative || null;
  const AUDIO_EXT = ['wav', 'wave', 'aif', 'aiff', 'aifc', 'iff', '8svx', 'svx'];
  const KRZ_EXT = ['krz', 'k25', 'k26'];
  const extOf = n => (n.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  const baseName = p => p.split(/[\\/]/).pop();

  const host = native ? {
    native: true,
    open: (kind, multi) => native.openDialog({ kind, multi }),
    save: (defaultName, fmt) => native.saveDialog({ defaultName, fmt }),
    write: (path, data) => native.writeFile(path, data),
    writeMany: (dir, files) => native.writeFiles(dir, files),
    read: (path) => native.readFile(path),
    title: (t) => native.setTitle(t),
    menu: (states) => native.updateMenu(states),
    recent: (p) => native.addRecent(p)
  } : {
    native: false,
    open(kind, multi) {
      return new Promise(resolve => {
        const inp = $('#filepick');
        inp.multiple = !!multi;
        inp.accept = (kind === 'krz' ? KRZ_EXT : KRZ_EXT.concat(AUDIO_EXT)).map(e => '.' + e).join(',');
        inp.value = '';
        inp.onchange = async () => {
          const out = [];
          for (const f of inp.files) out.push({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) });
          resolve(out);
        };
        inp.click();
      });
    },
    async save(defaultName) { return defaultName; },
    async write(name, data) { download(name, data); return true; },
    async writeMany(dir, files) { for (const f of files) download(f.name, f.data); return true; },
    read: null,
    title(t) { document.title = (t.dirty ? '• ' : '') + t.title + ' — KurzFiler'; },
    menu() { },
    recent() { }
  };
  function download(name, data) {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  // ------------------------------------------------------------------ settings
  const settings = { fillMode: 'fill', fillStart: 200 };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('kf-settings') || '{}')); } catch (e) { }
  function saveSettings() { try { localStorage.setItem('kf-settings', JSON.stringify(settings)); } catch (e) { } }

  // ------------------------------------------------------------------ document state
  const state = {
    objects: new Map(), path: null, name: null, format: 'raw', saved: null,
    undo: [], redo: [], sel: new Set(), anchor: null, filter: 'all', search: '', sort: { col: 'hash', dir: 1 },
    focusHash: null, editing: null
  };
  state.saved = state.objects;
  const dirty = () => state.objects !== state.saved;
  const objList = () => [...state.objects.values()];

  /** apply a change: fn receives a copy of the object map and mutates it */
  function change(label, fn) {
    const next = new Map(state.objects);
    const result = fn(next);
    if (result === false) return false;
    state.undo.push({ label, objects: state.objects });
    if (state.undo.length > 500) state.undo.shift();
    state.redo = [];
    state.objects = next;
    for (const h of [...state.sel]) if (!next.has(h)) state.sel.delete(h);
    update();
    return true;
  }
  function undo() {
    const u = state.undo.pop(); if (!u) return;
    state.redo.push({ label: u.label, objects: state.objects });
    state.objects = u.objects; pruneSel(); update(); toast('Undo ' + u.label);
  }
  function redo() {
    const r = state.redo.pop(); if (!r) return;
    state.undo.push({ label: r.label, objects: state.objects });
    state.objects = r.objects; pruneSel(); update(); toast('Redo ' + r.label);
  }
  function pruneSel() { for (const h of [...state.sel]) if (!state.objects.has(h)) state.sel.delete(h); }
  function resetDoc(objects, path, name, format) {
    state.objects = objects; state.saved = objects; state.path = path; state.name = name; state.format = format || 'raw';
    state.undo = []; state.redo = []; state.sel.clear(); state.anchor = null; state.focusHash = null;
    stopAudio(); update();
  }

  // ------------------------------------------------------------------ selection helpers
  const selected = () => [...state.sel].filter(h => state.objects.has(h)).sort((a, b) => a - b).map(h => state.objects.get(h));
  const selOf = cls => selected().filter(o => o instanceof cls);
  const selSamples = () => selOf(K.KSample);
  const selMonoRoot = () => selSamples().filter(s => !s.multiRoot);
  const selKeymaps = () => selOf(K.KKeymap);
  function select(hashes, keepFocus) {
    state.sel = new Set(hashes);
    if (!keepFocus) state.focusHash = hashes.length ? hashes[hashes.length - 1] : null;
    state.anchor = hashes.length ? hashes[0] : null;
    update();
    if (hashes.length) scrollToHash(state.focusHash || hashes[0]);
  }

  // ------------------------------------------------------------------ table model
  const TYPE_COLORS = { 36: 'var(--t-program)', 37: 'var(--t-keymap)', 38: 'var(--t-sample)', 41: 'var(--t-setup)', 44: 'var(--t-studio)' };
  const typeColor = t => TYPE_COLORS[t] || 'var(--t-other)';
  const sizeCache = new WeakMap();
  const sizeOf = o => { let s = sizeCache.get(o); if (s === undefined) { s = o.size(); sizeCache.set(o, s); } return s; };
  function visibleRows() {
    let list = objList();
    const f = state.filter;
    if (f === 'program') list = list.filter(o => o.type === K.T_PROGRAM);
    else if (f === 'keymap') list = list.filter(o => o.type === K.T_KEYMAP);
    else if (f === 'sample') list = list.filter(o => o.type === K.T_SAMPLE);
    else if (f === 'other') list = list.filter(o => ![36, 37, 38].includes(o.type));
    const q = state.search.trim().toLowerCase();
    if (q) list = list.filter(o => o.name.toLowerCase().includes(q) || String(o.id) === q || o.description().toLowerCase().includes(q));
    const { col, dir } = state.sort;
    const key = {
      hash: o => o.hash, id: o => o.id * 1000 + o.type, type: o => o.typeName + String(o.id).padStart(5, '0'),
      name: o => o.name.toLowerCase(), info: o => o.description(), size: o => sizeOf(o)
    }[col] || (o => o.hash);
    list.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.hash - b.hash) * dir; });
    return list;
  }

  // ------------------------------------------------------------------ rendering
  let rowsCache = [];
  function update() {
    renderSidebar(); renderTable(); renderInspector(); renderStatus(); syncCommands();
  }
  function renderSidebar() {
    const all = objList();
    const counts = { all: all.length, program: 0, keymap: 0, sample: 0, other: 0 };
    for (const o of all) { if (o.type === 36) counts.program++; else if (o.type === 37) counts.keymap++; else if (o.type === 38) counts.sample++; else counts.other++; }
    const items = [['all', 'All Objects', 'var(--muted)'], ['program', 'Programs', typeColor(36)], ['keymap', 'Keymaps', typeColor(37)], ['sample', 'Samples', typeColor(38)], ['other', 'Other', typeColor(0)]];
    $('#typelist').innerHTML = items.map(([k, label, c]) =>
      `<li data-filter="${k}" class="${state.filter === k ? 'on' : ''}"><span class="dot" style="background:${c}"></span>${label}<span class="n">${counts[k]}</span></li>`).join('');
    const fm = { fill: ['Fill', 'New objects get the first free numbers from ' + settings.fillStart + '.'], append: ['Append', 'Objects keep their numbers, or move to the next free one.'], merge: ['Merge', 'Objects keep their numbers and replace existing ones.'] }[settings.fillMode];
    $('#fillbox').innerHTML = `<b>${fm[0]}</b><small>${fm[1]}</small>`;
    let pram = 0, ram = 0;
    for (const o of all) { pram += sizeOf(o); if (o instanceof K.KSample) ram += o.ramSize(); }
    $('#lcd-pram').textContent = fmtBytes(pram);
    $('#lcd-ram').textContent = fmtBytes(ram);
    $('#lcd-count').textContent = all.length;
  }
  let tableSig = null;
  function renderTable(force) {
    const sig = [state.objects, state.filter, state.search, state.sort.col, state.sort.dir];
    if (!force && tableSig && sig.every((v, i) => v === tableSig[i])) {
      $$('#rows tr[data-h]').forEach(tr => tr.classList.toggle('sel', state.sel.has(+tr.dataset.h)));
      return;
    }
    tableSig = sig;
    const rows = visibleRows();
    rowsCache = rows;
    $$('#objects th').forEach(th => { const on = th.dataset.sort === state.sort.col; th.classList.toggle('sorted', on); th.classList.toggle('desc', on && state.sort.dir < 0); });
    const html = [];
    for (const o of rows) {
      html.push(`<tr data-h="${o.hash}" class="${state.sel.has(o.hash) ? 'sel' : ''}"><td class="id">${o.id}</td><td><span class="tag"><i style="background:${typeColor(o.type)}"></i>${o.typeName}</span></td><td class="name">${esc(o.name)}</td><td class="info">${esc(o.description())}</td><td class="size">${sizeOf(o).toLocaleString()}</td></tr>`);
    }
    $('#rows').innerHTML = html.join('');
    $('#empty').classList.toggle('show', state.objects.size === 0);
    if (state.objects.size && !rows.length) $('#rows').innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">No objects match.</td></tr>';
  }
  function renderStatus() {
    const name = state.path ? baseName(state.path) : (state.name || 'Untitled');
    $('#st-file').innerHTML = (dirty() ? '<span class="dirty-dot">●</span> ' : '') + esc(name) + (state.format !== 'raw' ? ' · ' + K.FORMATS[state.format].label : '');
    const n = state.sel.size;
    $('#st-sel').textContent = n ? n + ' of ' + state.objects.size + ' selected' : state.objects.size + ' objects';
    host.title({ title: name, path: state.path, dirty: dirty() });
  }
  function scrollToHash(h) {
    const tr = $(`#rows tr[data-h="${h}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ inspector
  let inspectorKey = null;
  let veloTab = 0, subSound = 0;
  function renderInspector() {
    const el = $('#inspector');
    const sel = selected();
    if (sel.length !== 1) {
      inspectorKey = null;
      if (!state.objects.size) { el.innerHTML = '<div class="insp-empty"><p>Open a file to see its programs, keymaps and samples.</p></div>'; return; }
      if (!sel.length) {
        el.innerHTML = `<div class="insp-empty"><div class="big">${state.objects.size}</div><p>objects in this file.<br>Select one to see its details.</p></div>`;
        return;
      }
      const bytes = sel.reduce((a, o) => a + sizeOf(o), 0), ram = sel.reduce((a, o) => a + (o.ramSize ? o.ramSize() : 0), 0);
      el.innerHTML = `<div class="insp-head"><div class="insp-badge" style="background:var(--accent)">${sel.length}</div><div><div class="insp-title">${sel.length} objects selected</div><div class="insp-sub">${fmtBytes(bytes)} program RAM · ${fmtBytes(ram)} sample RAM</div></div></div>
        <div class="card"><h4>Actions</h4><div class="actions">${actionButtons()}</div></div>`;
      return;
    }
    const o = sel[0];
    const key = o.hash + ':' + (o === state.objects.get(o.hash) ? sizeOf(o) : 0) + ':' + o.name;
    if (inspectorKey && inspectorKey.obj === o) { refreshActions(); return; }
    inspectorKey = { obj: o };
    veloTab = 0; subSound = 0;
    const head = `<div class="insp-head"><div class="insp-badge" style="background:${typeColor(o.type)}">${o.typeName[0]}</div><div><div class="insp-title">${esc(o.name) || '<i>unnamed</i>'}</div><div class="insp-sub">${o.typeName} ${o.id} · ${sizeOf(o).toLocaleString()} bytes</div></div></div>`;
    let body = '';
    if (o instanceof K.KSample) body = sampleInspector(o);
    else if (o instanceof K.KKeymap) body = keymapInspector(o);
    else if (o instanceof K.KProgram) body = programInspector(o);
    else body = `<div class="card"><h4>${o.typeName}</h4><p class="hint">KurzFiler keeps this object exactly as it is when saving. Object type ${o.type}.</p></div>` + usersCard(o);
    el.innerHTML = head + body + `<div class="card"><h4>Actions</h4><div class="actions" id="insp-actions">${actionButtons()}</div></div>`;
    if (o instanceof K.KSample) drawWave(o);
    if (o instanceof K.KKeymap) drawKeyboard(o);
    void key;
  }
  function refreshActions() { const a = $('#insp-actions'); if (a) a.innerHTML = actionButtons(); }
  function actionButtons() {
    const b = (cmd, label) => commands[cmd].enabled() ? `<button class="btn small" data-cmd="${cmd}">${label}</button>` : '';
    return [b('rename', 'Rename…'), b('setRoot', 'Set Root Key…'), b('guessRoot', 'Guess Root'), b('newInstrument', 'New Instrument…'), b('newDrumset', 'New Drumset…'),
      b('compact', 'Compact Keymap'), b('velosplit', 'Velocity Split…'), b('selectDependants', 'Select Dependants'), b('selectUsers', 'Select Users'),
      b('exportWav', 'Export WAV…'), b('saveSelected', 'Save Selected…'), b('delete', 'Delete')].join('');
  }
  function linkItem(h, extra) {
    const o = state.objects.get(h);
    if (!o) return `<li><span class="missing">${K.typeName(h)} ${K.hashID(h)} — not in this file</span>${extra ? '<span class="r">' + extra + '</span>' : ''}</li>`;
    return `<li><span class="tag"><i style="background:${typeColor(o.type)}"></i></span><a data-goto="${h}">${o.id} ${esc(o.name)}</a><span class="r">${extra || esc(o.description())}</span></li>`;
  }
  function usersCard(o) {
    const u = K.users(state.objects, o.hash);
    return `<div class="card"><h4>Used by</h4>${u.length ? '<ul class="linklist">' + u.map(h => linkItem(h)).join('') + '</ul>' : '<p class="hint">Nothing in this file uses it.</p>'}</div>`;
  }
  function sampleInspector(s) {
    const h = s.headers[s.soundIndexes()[0]] || s.headers[0];
    const sounds = s.soundIndexes();
    const sub = sounds.length > 1 ? `<div class="subsel" id="subsel">${sounds.map((hi, i) => `<button type="button" data-sub="${i}" class="${i === 0 ? 'on' : ''}">${K.noteName(s.headers[hi].rootkey)}</button>`).join('')}</div>` : '';
    return `<div class="card"><h4>Waveform</h4>${sub}<canvas class="wave" id="wave" width="600" height="240"></canvas>
      <div class="wave-tools"><button class="btn small" id="play" type="button">▶ Play</button><label><input type="checkbox" id="loopplay" checked> Loop</label><span class="hint" id="wave-info"></span></div></div>
      <div class="card"><h4>Sample</h4><dl class="kv" id="sample-kv">${sampleKV(s, h)}</dl></div>` + usersCard(s);
  }
  function sampleKV(s, h) {
    const rate = h.sampleRate, frames = h.frames;
    const rows = [
      ['Channels', s.stereo ? 'Stereo' : 'Mono'], ['Root key', K.noteName(h.rootkey) + ' (' + h.rootkey + ')'],
      ['Sample rate', (Math.round(rate * 10) / 10).toLocaleString() + ' Hz'], ['Length', frames.toLocaleString() + ' samples · ' + (frames / rate).toFixed(2) + ' s'],
      ['Loop', h.looped ? 'On · ' + h.sampleLoopStart.toLocaleString() + ' – ' + h.sampleEnd.toLocaleString() : 'Off'],
      ['Alt start', h.altSampleStart.toLocaleString()], ['Sounds', s.soundIndexes().length + (s.multiRoot ? ' (multi-root)' : '')],
      ['Sample RAM', fmtBytes(s.ramSize())]
    ];
    if (!h.needsLoad) rows.push(['Data', 'In ROM / not in this file']);
    return rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  }
  function keymapInspector(k) {
    const tabs = '<div class="velo-tabs" id="velotabs">' + K.LEVEL_NAMES.map((n, i) => `<button type="button" data-velo="${i}" class="${i === veloTab ? 'on' : ''}" title="Velocity level ${n} uses map ${k.velo[i] + 1}">${n}</button>`).join('') + '</div>';
    const deps = k.dependants();
    return `<div class="card"><h4>Keyboard</h4>${tabs}<div class="kbd" id="kbd"></div><div class="kbd-legend"><span>C-1</span><span>C4</span><span>G9</span></div><p class="hint" id="kbd-info">Click a key to hear what it plays.</p></div>
      <div class="card"><h4>Keymap</h4><dl class="kv">${[['Velocity levels', k.numLevels()], ['Entries', k.entriesPerVel + 1 + ' × ' + k.centsPerEntry + ' cents'], ['Mode', k.compactable ? 'One sample per key (' + k.method + ')' : 'Single sample (' + k.method + ')'], ['Samples used', deps.length]].map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl></div>
      <div class="card"><h4>Uses samples</h4>${deps.length ? '<ul class="linklist">' + deps.map(h => linkItem(h)).join('') + '</ul>' : '<p class="hint">No samples.</p>'}</div>` + usersCard(k);
  }
  function programInspector(p) {
    const deps = p.dependants();
    const m = p.mode();
    const req = m >= 4 ? 'K2500 / K2600 with KDFX' : m === 3 ? 'K2500 or K2600' : 'K2000 or later';
    return `<div class="card"><h4>Program</h4><dl class="kv">${[['Layers', p.numLayers()], ['Mode', m], ['Runs on', req]].map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>
      ${m > 2 ? '<p class="hint">Saving as K2000 removes the K2500/KDFX parts' + (m > 3 ? '; saving as K2500 without KDFX removes the KDFX parts.' : '.') + '</p>' : ''}</div>
      <div class="card"><h4>Uses keymaps</h4>${deps.length ? '<ul class="linklist">' + deps.map(h => linkItem(h)).join('') + '</ul>' : '<p class="hint">Uses only ROM keymaps, or none.</p>'}</div>` + usersCard(p);
  }

  // waveform
  const peakCache = new WeakMap();
  function peaks(h, w) {
    let c = peakCache.get(h); if (c && c.w === w) return c;
    const d = h.data; const n = d ? d.length >> 1 : 0;
    const mins = new Float32Array(w), maxs = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const a = Math.floor(x * n / w), b = Math.max(a + 1, Math.floor((x + 1) * n / w));
      let lo = 1, hi = -1;
      const step = Math.max(1, Math.floor((b - a) / 400));
      for (let i = a; i < b && i < n; i += step) { let v = (d[2 * i] << 8) | d[2 * i + 1]; if (v > 32767) v -= 65536; v /= 32768; if (v < lo) lo = v; if (v > hi) hi = v; }
      mins[x] = lo > hi ? 0 : lo; maxs[x] = lo > hi ? 0 : hi;
    }
    c = { w, mins, maxs }; peakCache.set(h, c); return c;
  }
  function drawWave(s) {
    const cv = $('#wave'); if (!cv) return;
    const hi = s.soundIndexes()[subSound] || 0;
    const h = s.headers[hi];
    const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
    const css = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, W, H);
    const n = h.data ? h.data.length >> 1 : 0;
    const chans = s.stereo ? [h, s.headers[hi + 1]] : [h];
    if (h.looped && n) {
      ctx.fillStyle = css.getPropertyValue('--loop');
      const x0 = h.sampleLoopStart / n * W, x1 = (h.sampleEnd + 1) / n * W;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
    }
    ctx.fillStyle = css.getPropertyValue('--wave');
    chans.forEach((c, ci) => {
      if (!c || !c.data) return;
      const band = H / chans.length, mid = band * ci + band / 2;
      const p = peaks(c, W);
      for (let x = 0; x < W; x++) { const y0 = mid - p.maxs[x] * band / 2 * .92, y1 = mid - p.mins[x] * band / 2 * .92; ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0)); }
    });
    if (!n) { ctx.fillStyle = css.getPropertyValue('--muted'); ctx.font = '22px -apple-system, sans-serif'; ctx.fillText('No sample data in this file', 20, H / 2); }
    const kv = $('#sample-kv'); if (kv) kv.innerHTML = sampleKV(s, h);
  }

  // keyboard
  function drawKeyboard(k) {
    const el = $('#kbd'); if (!el) return;
    const map = k.maps[k.velo[veloTab]] || [];
    const n = Math.min(128, map.length);
    const isBlack = i => [1, 3, 6, 8, 10].includes(i % 12);
    let whites = 0; for (let i = 0; i < n; i++) if (!isBlack(i)) whites++;
    const ww = 100 / whites;
    const colors = new Map(); const palette = ['#13896b', '#2a6fc4', '#c07a12', '#7a4fd0', '#c03a7c', '#5c8a1a', '#b5462a', '#1f8fa6'];
    const colorFor = (e) => { if ((k.method & 1) && e.ss === 0) return null; const s = k.entrySample(e); const key = s.sid + ':' + s.ss; if (!colors.has(key)) colors.set(key, palette[colors.size % palette.length]); return colors.get(key); };
    let html = '', wi = 0;
    for (let i = 0; i < n; i++) {
      const c = colorFor(map[i]);
      if (!isBlack(i)) {
        html += `<div class="k w" data-key="${i}" style="left:${wi * ww}%;width:${ww}%;background:${c ? c + '55' : 'transparent'}"></div>`; wi++;
      } else {
        html += `<div class="k b" data-key="${i}" style="left:${wi * ww - ww * .3}%;width:${ww * .6}%;${c ? 'box-shadow: inset 0 -6px 0 ' + c : ''}"></div>`;
      }
    }
    el.innerHTML = html;
  }

  // ------------------------------------------------------------------ audio
  let actx = null, playing = null;
  function stopAudio() { if (playing) { try { playing.stop(); } catch (e) { } playing = null; const b = $('#play'); if (b) b.textContent = '▶ Play'; } }
  function playHeader(s, hi, cents, loop) {
    stopAudio();
    const h = s.headers[hi]; if (!h || !h.data || !h.data.length) { toast('This sample has no audio data in the file.'); return; }
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const L = h.toFloat(); const R = s.stereo && s.headers[hi + 1] ? s.headers[hi + 1].toFloat() : null;
    const rate = Math.min(384000, Math.max(3000, h.sampleRate));
    const buf = actx.createBuffer(R ? 2 : 1, L.length, rate);
    buf.copyToChannel(L, 0); if (R) buf.copyToChannel(R.length === L.length ? R : L, 1);
    const src = actx.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (cents || 0) / 1200);
    if (loop && h.looped && h.sampleLoopStart < h.sampleEnd) { src.loop = true; src.loopStart = h.sampleLoopStart / rate; src.loopEnd = (h.sampleEnd + 1) / rate; }
    const g = actx.createGain(); g.gain.value = .9; src.connect(g).connect(actx.destination);
    src.onended = () => { if (playing === src) { playing = null; const b = $('#play'); if (b) b.textContent = '▶ Play'; } };
    src.start(); playing = src;
    if (src.loop) setTimeout(() => { if (playing === src) stopAudio(); }, 8000);
    const b = $('#play'); if (b) b.textContent = '■ Stop';
  }

  // ------------------------------------------------------------------ dialogs
  function dialog(title, bodyHTML, buttons, onOpen) {
    return new Promise(resolve => {
      const d = $('#dlg');
      $('#dlg-title').textContent = title;
      $('#dlg-body').innerHTML = bodyHTML;
      $('#dlg-buttons').innerHTML = buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''} ${b.left ? 'left' : ''}" value="${i}" ${b.primary ? 'autofocus' : ''}>${esc(b.label)}</button>`).join('');
      const done = (v) => { d.onclose = null; d.oncancel = null; resolve(v); };
      d.onclose = () => {
        const i = d.returnValue === '' ? -1 : +d.returnValue;
        const b = buttons[i];
        if (!b || b.cancel) return done(null);
        const val = b.collect ? b.collect($('#dlg-body')) : b.value;
        done(val === undefined ? true : val);
      };
      d.returnValue = '';
      d.onkeydown = (ev) => {
        if (ev.key === 'Enter' && !ev.target.matches('select, textarea, button')) {
          ev.preventDefault();
          const pb = $('#dlg-buttons .btn.primary'); if (pb) pb.click();
        }
      };
      d.showModal();
      const first = $('#dlg-body input.tf, #dlg-body select.tf');
      if (first) { first.focus(); if (first.select) first.select(); }
      if (onOpen) onOpen($('#dlg-body'), d);
    });
  }
  const alertBox = (title, html) => dialog(title, html, [{ label: 'OK', primary: true }]);
  const nameInput = (val, attrs) => `<input class="tf" type="text" maxlength="16" spellcheck="false" value="${esc(val)}" ${attrs || ''}>`;

  // ------------------------------------------------------------------ toasts
  function toast(msg, err) {
    const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), err ? 6000 : 2400);
  }

  // ------------------------------------------------------------------ file operations
  async function askSaveChanges(verb) {
    if (!dirty()) return true;
    const name = state.path ? baseName(state.path) : 'Untitled';
    const r = await dialog('Save changes?', `<p>Do you want to save the changes you made to <b>${esc(name)}</b> before ${verb}?</p><p class="hint">Your changes will be lost if you don't save them.</p>`,
      [{ label: "Don't Save", value: 'discard', left: true }, { label: 'Cancel', cancel: true }, { label: 'Save', value: 'save', primary: true }]);
    if (!r) return false;
    if (r === 'save') return await doSave();
    return true;
  }
  function formatForName(n) { const e = extOf(n); return e === 'krz' ? 'krz' : e === 'k25' ? 'k25' : e === 'k26' ? 'k26' : 'raw'; }

  async function openFiles(files) {
    files = files.filter(Boolean);
    if (!files.length) return;
    const krz = files.filter(f => K.detectKind(f.data) === 'krz');
    if (!krz.length) return importFiles(files);
    const first = krz[0];
    let parsed;
    try { parsed = K.parseKRZ(first.data); } catch (e) { return alertBox('Could not open the file', `<p><b>${esc(first.name)}</b></p><p>${esc(e.message)}</p>`); }
    // the original renumbered on open in Fill mode; here the instrument's numbers are kept
    resetDoc(parsed.objects, first.path, first.name, 'raw');
    if (first.path) host.recent(first.path);
    if (parsed.warnings.length) toast(first.name + ': ' + parsed.warnings.join(' '), true);
    const rest = files.filter(f => f !== first);
    if (rest.length) await importFiles(rest, true);
    else toast('Opened ' + first.name + ' — ' + state.objects.size + ' objects');
  }
  async function importFiles(files, mergedIntoOpen) {
    const incoming = []; const errors = [];
    for (const f of files) {
      try {
        const kind = K.detectKind(f.data);
        if (kind === 'krz') {
          const p = K.parseKRZ(f.data);
          incoming.push(p.objects);
          if (p.warnings.length) errors.push(f.name + ': ' + p.warnings.join(' '));
        } else {
          const s = K.parseAudio(f.data, f.name);
          if (s.importWarning) errors.push(f.name + ': ' + s.importWarning);
          incoming.push([s]);
        }
      } catch (e) { errors.push(f.name + ': ' + e.message); }
    }
    if (!incoming.length) { if (errors.length) alertBox('Could not import', '<p>' + errors.map(esc).join('<br>') + '</p>'); return; }
    let added = [];
    const ok = change(mergedIntoOpen ? 'Open' : 'Import', m => {
      for (const objs of incoming) {
        try { added = added.concat(K.importObjects(m, objs, settings.fillMode, settings.fillStart)); }
        catch (e) { errors.push(e.message); }
      }
      if (!added.length) return false;
    });
    if (ok) {
      select(added.sort((a, b) => a - b));
      toast((mergedIntoOpen ? 'Added ' : 'Imported ') + added.length + ' object' + (added.length === 1 ? '' : 's'));
    }
    if (errors.length) toast(errors.join('  •  '), true);
  }
  async function doSave() {
    if (!state.path) return doSaveAs();
    return writeDoc(state.path, state.format);
  }
  async function writeDoc(path, fmt) {
    try {
      const data = K.writeKRZ(state.objects, fmt);
      const ok = await host.write(path, data);
      if (!ok) return false;
      state.saved = state.objects; state.path = host.native ? path : null; state.name = baseName(path); state.format = fmt;
      if (host.native) host.recent(path);
      update(); toast('Saved ' + baseName(path) + ' (' + fmtBytes(data.length) + ')');
      return true;
    } catch (e) { alertBox('Could not save', `<p>${esc(e.message)}</p>`); return false; }
  }
  async function chooseFormat(title, objs) {
    const progs = objs.filter(o => o instanceof K.KProgram);
    const kdfx = progs.filter(p => p.mode() > 3).length, k25 = progs.filter(p => p.mode() === 3).length;
    const longNames = objs.filter(o => o.name.length > 16).length;
    const cur = state.format !== 'raw' ? state.format : (state.name ? formatForName(state.name) : 'krz');
    const opt = (k, label, note) => `<label class="radio"><input type="radio" name="fmt" value="${k}" ${cur === k || (cur === 'raw' && k === 'k26') ? 'checked' : ''}><span><b>${label}</b><small>${note}</small></span></label>`;
    return dialog(title, `<p>Which instrument should the file be made for?</p>
      ${opt('krz', 'K2000 (.krz)', (kdfx + k25 ? (kdfx + k25) + ' program' + (kdfx + k25 === 1 ? '' : 's') + ' will be reduced to K2000 features.' : 'All programs are already K2000 compatible.') + (longNames ? ' Names longer than 16 characters are shortened.' : ''))}
      ${opt('k25', 'K2500 without KDFX (.k25)', kdfx ? kdfx + ' program' + (kdfx === 1 ? '' : 's') + ' will lose their KDFX parts.' : 'Keeps K2500 program features.')}
      ${opt('k26', 'K2600 / K2500 with KDFX (.k26)', 'Keeps everything as it is.')}`,
      [{ label: 'Cancel', cancel: true }, { label: 'Continue', primary: true, collect: b => $('input[name=fmt]:checked', b).value }]);
  }
  async function doSaveAs() {
    const fmt = await chooseFormat('Save As', objList()); if (!fmt) return false;
    const base = (state.name || 'Untitled').replace(/\.[^.]+$/, '');
    const path = await host.save(base + K.FORMATS[fmt].ext, fmt); if (!path) return false;
    return writeDoc(path, fmt);
  }

  // ------------------------------------------------------------------ commands
  const commands = {
    new: { enabled: () => state.objects.size > 0 || !!state.path || dirty(), run: async () => { if (await askSaveChanges('starting a new file')) resetDoc(new Map(), null, null, 'raw'); } },
    open: { enabled: () => true, run: async () => { if (!(await askSaveChanges('opening another file'))) return; const f = await host.open('krz', true); if (f && f.length) openFiles(f); } },
    revert: {
      enabled: () => !!state.path && !!host.read && dirty(), run: async () => {
        const r = await dialog('Revert to saved?', `<p>Throw away all changes since the last save?</p>`, [{ label: 'Cancel', cancel: true }, { label: 'Revert', primary: true, danger: true }]);
        if (!r) return; const f = await host.read(state.path); if (f) openFiles([f]);
      }
    },
    import: { enabled: () => true, run: async () => { const f = await host.open('any', true); if (f && f.length) { if (!state.objects.size && !state.path && f.some(x => K.detectKind(x.data) === 'krz')) openFiles(f); else importFiles(f); } } },
    remap: {
      enabled: () => state.objects.size > 0, run: async () => {
        const r = await dialog('Remap IDs', `<p>Renumber all programs, keymaps and samples consecutively, starting at:</p><div class="field"><label>First ID</label><input class="tf" type="number" min="1" max="999" value="${settings.fillStart}"></div><p class="hint">Links between programs, keymaps and samples are kept. Setups and other objects keep their numbers.</p>`,
          [{ label: 'Cancel', cancel: true }, { label: 'Remap', primary: true, collect: b => +$('input', b).value }]);
        if (!r || r < 1 || r > 999) return;
        change('Remap IDs', m => { const n = K.remapIDs(m, r); m.clear(); for (const [h, o] of n) m.set(h, o); });
        state.sel.clear(); update();
      }
    },
    save: { enabled: () => state.objects.size > 0 || dirty(), run: doSave },
    saveAs: { enabled: () => state.objects.size > 0, run: doSaveAs },
    saveSelected: {
      enabled: () => state.sel.size > 0, run: async () => {
        let hashes = selected().map(o => o.hash);
        const deps = new Set(); for (const h of hashes) for (const d of K.dependantsRecursive(state.objects, h)) if (!hashes.includes(d)) deps.add(d);
        if (deps.size) {
          const r = await dialog('Save dependants?', `<p>The selection uses ${deps.size} other object${deps.size === 1 ? '' : 's'} (keymaps or samples). Save ${deps.size === 1 ? 'it' : 'them'} too?</p><p class="hint">Without them, the programs or keymaps will not play on the instrument unless it already has those objects.</p>`,
            [{ label: 'Cancel', cancel: true, left: true }, { label: 'Selection Only', value: 'no' }, { label: 'Include Dependants', value: 'yes', primary: true }]);
          if (!r) return; if (r === 'yes') hashes = hashes.concat([...deps]);
        }
        const objs = hashes.map(h => state.objects.get(h));
        const fmt = await chooseFormat('Save Selected', objs); if (!fmt) return;
        const path = await host.save('Selection' + K.FORMATS[fmt].ext, fmt); if (!path) return;
        try { await host.write(path, K.writeKRZ(objs, fmt)); toast('Saved ' + objs.length + ' objects to ' + baseName(path)); }
        catch (e) { alertBox('Could not save', `<p>${esc(e.message)}</p>`); }
      }
    },
    exportWav: {
      enabled: () => selSamples().length > 0, run: async () => {
        const samples = selSamples().filter(s => s.headers.some(h => h.data && h.data.length));
        if (!samples.length) return toast('The selected samples have no audio data in this file.', true);
        const wavs = K.exportWAVs(samples, null);
        if (host.native) {
          const dir = await window.kfNative.chooseFolder(); if (!dir) return;
          const n = await host.writeMany(dir, wavs);
          toast('Exported ' + n + ' WAV file' + (n === 1 ? '' : 's'));
        } else { await host.writeMany(null, wavs); toast('Exported ' + wavs.length + ' WAV file' + (wavs.length === 1 ? '' : 's')); }
      }
    },
    fileInfo: {
      enabled: () => state.objects.size > 0, run: () => {
        const all = objList(); let pram = 0, ram = 0; const by = {};
        for (const o of all) { pram += sizeOf(o); if (o instanceof K.KSample) ram += o.ramSize(); by[o.typeName] = (by[o.typeName] || 0) + 1; }
        const progs = all.filter(o => o instanceof K.KProgram);
        const need = progs.some(p => p.mode() > 3) ? 'K2500 / K2600 with KDFX' : progs.some(p => p.mode() === 3) ? 'K2500 or K2600' : 'K2000 or later';
        alertBox('File Information', `<dl class="stat"><dt>File</dt><dd>${esc(state.path ? baseName(state.path) : 'Untitled')}</dd><dt>Number of objects</dt><dd>${all.length}</dd>
          ${Object.entries(by).map(([k, v]) => `<dt>&nbsp;&nbsp;${k}s</dt><dd>${v}</dd>`).join('')}
          <dt>Program RAM (PRAM) needed</dt><dd>${pram.toLocaleString()} bytes</dd><dt>Sample RAM needed</dt><dd>${Math.floor(ram / 1024).toLocaleString()} KB</dd><dt>Programs need</dt><dd>${need}</dd></dl>`);
      }
    },
    undo: { enabled: () => state.undo.length > 0, run: undo },
    redo: { enabled: () => state.redo.length > 0, run: redo },
    delete: {
      enabled: () => state.sel.size > 0, run: async () => {
        const del = new Set(selected().map(o => o.hash));
        const deps = new Set(); for (const h of del) for (const d of K.dependantsRecursive(state.objects, h)) if (!del.has(d)) deps.add(d);
        if (deps.size) {
          // only offer dependants nothing else will use afterwards
          const removable = [...deps].filter(d => K.users(state.objects, d).every(u => del.has(u) || deps.has(u)));
          if (removable.length) {
            const r = await dialog('Delete dependants?', `<p>The selection uses ${removable.length} keymap${removable.length === 1 ? '' : 's'}/sample${removable.length === 1 ? '' : 's'} that nothing else uses. Delete ${removable.length === 1 ? 'it' : 'them'} as well?</p>`,
              [{ label: 'Cancel', cancel: true, left: true }, { label: 'Selection Only', value: 'no' }, { label: 'Delete Dependants Too', value: 'yes', primary: true }]);
            if (!r) return;
            if (r === 'yes') removable.forEach(d => del.add(d));
          }
        }
        change('Delete', m => { for (const h of del) m.delete(h); });
        toast('Deleted ' + del.size + ' object' + (del.size === 1 ? '' : 's'));
      }
    },
    selectAll: { enabled: () => state.objects.size > 0, run: () => select(rowsCache.map(o => o.hash), true) },
    deselect: { enabled: () => state.sel.size > 0, run: () => select([]) },
    selectDependants: {
      enabled: () => selected().some(o => K.directDependants(state.objects, o.hash).length), run: () => {
        const out = new Set(); for (const o of selected()) for (const d of K.dependantsRecursive(state.objects, o.hash)) out.add(d);
        state.filter = 'all'; select([...out].sort((a, b) => a - b));
      }
    },
    selectUsers: {
      enabled: () => state.sel.size > 0, run: () => {
        const out = new Set(); for (const o of selected()) for (const u of K.users(state.objects, o.hash)) out.add(u);
        if (!out.size) return toast('Nothing in this file uses the selection.');
        state.filter = 'all'; select([...out].sort((a, b) => a - b));
      }
    },
    rename: {
      enabled: () => state.sel.size > 0, run: async () => {
        const sel = selected();
        if (sel.length === 1) return startInlineRename(sel[0].hash);
        const r = await dialog('Rename ' + sel.length + ' objects', sel.map(o => `<div class="field"><label>${o.typeName} ${o.id}<small>${esc(o.name)}</small></label>${nameInput(o.name, 'data-h="' + o.hash + '"')}</div>`).join(''),
          [{ label: 'Cancel', cancel: true }, { label: 'Rename', primary: true, collect: b => $$('input', b).map(i => [+i.dataset.h, i.value]) }]);
        if (!r) return;
        renameObjects(r);
      }
    },
    setRoot: {
      enabled: () => selMonoRoot().length > 0, run: async () => {
        const list = selMonoRoot();
        const r = await dialog('Set Root Key', `<p class="hint">Type a note like C4, F#3 or Bb2 (C4 = middle C = 60), or a MIDI number.</p>` + list.map(s => `<div class="field"><label>${s.id} ${esc(s.name)}<small>${s.stereo ? 'Stereo' : 'Mono'} · now ${s.rootKeyName()}</small></label><input class="tf" type="text" data-h="${s.hash}" value="${s.rootKeyName()}" spellcheck="false"></div>`).join(''),
          [{ label: 'Cancel', cancel: true }, { label: 'Set', primary: true, collect: b => $$('input', b).map(i => [+i.dataset.h, i.value]) }]);
        if (!r) return;
        const bad = [];
        change('Set Root Key', m => {
          let n = 0;
          for (const [h, v] of r) {
            let key; try { key = K.parseNote(v); } catch (e) { bad.push(v); continue; }
            const s = m.get(h); if (s.headers[0].rootkey === key) continue;
            const c = s.clone(); c.setRootKey(key); m.set(h, c); n++;
          }
          if (!n) return false;
        });
        if (bad.length) toast('Not a valid note: ' + bad.join(', ') + ' (ignored)', true);
      }
    },
    guessRoot: {
      enabled: () => selMonoRoot().length > 0, run: () => {
        let n = 0;
        change('Guess Root from Name', m => {
          for (const s of selMonoRoot()) {
            const key = guessRoot(s.name);
            if (key === null || key === s.headers[0].rootkey) continue;
            const c = s.clone(); c.setRootKey(key); m.set(s.hash, c); n++;
          }
          if (!n) return false;
        });
        toast(n ? 'Set the root key of ' + n + ' sample' + (n === 1 ? '' : 's') + ' from the name' : 'No note names found in the sample names.');
      }
    },
    altStart: {
      enabled: () => selSamples().length > 0, run: () => change('AltStart to SampleEnd', m => {
        for (const s of selSamples()) { const c = s.clone(); c.headers.forEach(h => h.altSampleStart = h.sampleEnd); m.set(s.hash, c); }
      })
    },
    compact: {
      enabled: () => selKeymaps().some(k => k.compactable), run: () => {
        const errs = []; let n = 0;
        change('Compact Keymap', m => {
          for (const k of selKeymaps()) {
            if (!m.has(k.hash) || !m.get(k.hash).compactable) continue;
            try { const rep = K.compactKeymap(m, k.hash); for (const [h, o] of rep) { if (o) m.set(h, o); else m.delete(h); } n++; }
            catch (e) { errs.push(k.name + ': ' + e.message); }
          }
          if (!n) return false;
        });
        if (n) toast('Compacted ' + n + ' keymap' + (n === 1 ? '' : 's'));
        if (errs.length) alertBox('Compact Keymap', '<p>' + errs.map(esc).join('<br>') + '</p>');
      }
    },
    velosplit: {
      enabled: () => selKeymaps().length > 0, run: async () => {
        const levels = [];
        for (const k of selKeymaps()) for (let i = 0; i < k.maps.length; i++) {
          const [lo, hi] = k.veloRange(i);
          levels.push({ keymap: k, index: i, label: k.id + ' ' + k.name + ' — level ' + (i + 1) + (lo >= 0 ? ' (' + K.LEVEL_NAMES[lo] + (hi !== lo ? ' to ' + K.LEVEL_NAMES[hi] : '') + ')' : '') });
        }
        const choice = []; for (let i = 0; i < 8; i++) choice.push(Math.floor(levels.length * i / 8));
        const r = await dialog('Velocity Split Keymap', `<p>Choose which keymap plays at each velocity, from softest to loudest.</p>` + K.LEVEL_NAMES.map((n, i) => `<div class="field" style="grid-template-columns:60px 1fr"><label><b>${n}</b></label><select class="tf">${levels.map((l, j) => `<option value="${j}" ${choice[i] === j ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select></div>`).join(''),
          [{ label: 'Cancel', cancel: true }, { label: 'Continue', primary: true, collect: b => $$('select', b).map(s => +s.value) }]);
        if (!r) return;
        let made; try { made = K.makeVelocitySplit(levels, r); } catch (e) { return alertBox('Velocity Split Keymap', `<p>${esc(e.message)}</p>`); }
        createObjects(made, 'New Velocity Split Keymap', 'Velosplit Keymap', 'Program');
      }
    },
    newDrumset: {
      enabled: () => selSamples().length > 0, run: () => {
        let made; try { made = K.makeDrumset(selSamples()); } catch (e) { return alertBox('New Drumset', `<p>${esc(e.message)}</p>`); }
        createObjects(made, 'New Drumset', 'Drum Keymap', 'Drumset');
      }
    },
    newInstrument: {
      enabled: () => selSamples().length > 0, run: () => {
        let made; try { made = K.makeInstrument(selSamples()); } catch (e) { return alertBox('New Instrument', `<p>${esc(e.message)}</p>`); }
        createObjects(made, 'New Instrument', 'chromatic Keymap', 'Instrument');
      }
    },
    play: {
      enabled: () => selSamples().length === 1, run: () => {
        if (playing) return stopAudio();
        const s = selSamples()[0]; playHeader(s, s.soundIndexes()[subSound] || 0, 0, !$('#loopplay') || $('#loopplay').checked);
      }
    },
    fillMode: {
      enabled: () => true, run: async () => {
        const opt = (k, label, note) => `<label class="radio"><input type="radio" name="fm" value="${k}" ${settings.fillMode === k ? 'checked' : ''}><span><b>${label}</b><small>${note}</small></span></label>`;
        const r = await dialog('Fill Mode', `<p>How should objects be numbered when you import files or create new programs?</p>
          ${opt('fill', 'Fill', 'Programs, keymaps and samples get the first free numbers, starting at the ID below.')}
          ${opt('append', 'Append', 'Objects keep their numbers if free, otherwise they move to the next free number.')}
          ${opt('merge', 'Merge', 'Objects keep their numbers and replace objects that already use them.')}
          <div class="field"><label>Start ID for Fill<small>200 = first user bank on the K2000</small></label><input class="tf" type="number" min="1" max="999" value="${settings.fillStart}"></div>`,
          [{ label: 'Cancel', cancel: true }, { label: 'OK', primary: true, collect: b => ({ mode: $('input[name=fm]:checked', b).value, start: +$('input[type=number]', b).value }) }]);
        if (!r) return;
        settings.fillMode = r.mode; if (r.start >= 1 && r.start <= 999) settings.fillStart = Math.floor(r.start);
        saveSettings(); update();
      }
    },
    about: {
      enabled: () => true, run: () => alertBox('About KurzFiler', `<div class="about"><div class="empty-mark">K</div><b style="font-size:16px">KurzFiler for macOS</b><br><small>Version 2.0 · native Apple Silicon</small>
        <p>Manages files for Kurzweil K2000, K2500 and K2600 instruments.</p>
        <p><small>A modern re-creation of KurzFiler by Marc Halbrügge and Sven Thoennissen (2001–2008).<br>Free software under the GNU General Public License, version 3 or later.</small></p></div>`)
    },
    help: {
      enabled: () => true, run: () => alertBox('KurzFiler Help', `<dl class="stat" style="grid-template-columns:auto 1fr">
        <dt>Open</dt><dd style="text-align:left">Open a .krz, .k25 or .k26 file. Choose several to join them into one.</dd>
        <dt>Import</dt><dd style="text-align:left">Add WAV, AIFF or IFF audio as samples, or add the objects of other Kurzweil files. Numbering follows the Fill Mode.</dd>
        <dt>Rename</dt><dd style="text-align:left">Double-click a name, or press Return. Names are limited to 16 characters.</dd>
        <dt>New Instrument</dt><dd style="text-align:left">Select samples: each is placed at its root key and the gaps between them are filled. Set the root keys first.</dd>
        <dt>New Drumset</dt><dd style="text-align:left">Select samples: one per key from C0 upward, at original pitch.</dd>
        <dt>Velocity Split</dt><dd style="text-align:left">Select keymaps and choose which one plays at each of the 8 velocity levels.</dd>
        <dt>Compact Keymap</dt><dd style="text-align:left">Combines all samples of a keymap into one multi-root sample (KCompact).</dd>
        <dt>Save As</dt><dd style="text-align:left">Choose K2000, K2500 or K2600. Newer program features are removed for older instruments.</dd>
        <dt>Space</dt><dd style="text-align:left">Play the selected sample.</dd></dl>`)
    }
  };

  function guessRoot(name) {
    const tryRoot = s => { if (s.length >= 3) { try { return K.parseNote(s.substring(s.length - 3)); } catch (e) { } } if (s.length >= 2) { try { return K.parseNote(s.substring(s.length - 2)); } catch (e) { } } return null; };
    let r = tryRoot(name);
    if (r !== null) return r;
    for (const sep of ['.', ' ', '-', '_']) for (const part of name.split(sep)) { r = tryRoot(part); if (r !== null) return r; }
    return null;
  }

  async function createObjects(made, label, kmDefault, pgDefault) {
    const [kk, kp] = made;
    const r = await dialog('Name New Objects', `<p>Please choose a name for each new object.</p>
      <div class="field"><label>Keymap</label>${nameInput(kmDefault, 'id="nn-k"')}</div><div class="field"><label>Program</label>${nameInput(pgDefault, 'id="nn-p"')}</div>`,
      [{ label: 'Cancel', cancel: true }, { label: 'Create', primary: true, collect: b => [$('#nn-k', b).value, $('#nn-p', b).value] }]);
    if (!r) return;
    kk.name = K.cleanName(r[0]).substring(0, 16); kp.name = K.cleanName(r[1]).substring(0, 16);
    let added = [];
    if (settings.fillMode === 'merge' && (state.objects.has(kk.hash) || state.objects.has(kp.hash))) {
      const ok = await dialog('Replace objects?', `<p>Fill mode is <b>Merge</b>, so the new keymap and program would replace Keymap ${kk.id} / Program ${kp.id} in this file.</p>`, [{ label: 'Cancel', cancel: true }, { label: 'Replace', danger: true, primary: true }]);
      if (!ok) return;
    }
    change(label, m => { added = K.importObjects(m, [kk, kp], settings.fillMode, settings.fillStart); });
    state.filter = 'all';
    select(added.sort((a, b) => a - b));
    toast('Created ' + added.map(h => K.typeName(h) + ' ' + K.hashID(h)).join(' and '));
  }
  function renameObjects(pairs) {
    let truncated = false;
    change('Rename', m => {
      let n = 0;
      for (const [h, v] of pairs) {
        let name = K.cleanName(v);
        if (name.length > 16) { name = name.substring(0, 16); truncated = true; }
        const o = m.get(h); if (!o || o.name === name) continue;
        const c = o.clone(); c.name = name; m.set(h, c); n++;
      }
      if (!n) return false;
    });
    if (truncated) toast('Names longer than 16 characters were shortened.');
  }
  function startInlineRename(h) {
    const tr = $(`#rows tr[data-h="${h}"]`); if (!tr) return;
    scrollToHash(h);
    const td = $('td.name', tr); const o = state.objects.get(h);
    state.editing = h;
    td.innerHTML = `<input class="rename" maxlength="16" spellcheck="false" value="${esc(o.name)}">`;
    const inp = $('input', td); inp.focus(); inp.select();
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true; state.editing = null;
      if (commit && inp.value !== o.name) renameObjects([[h, inp.value]]); else renderTable(true);
      $('#tablewrap').focus();
    };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('mousedown', e => e.stopPropagation());
    inp.addEventListener('dblclick', e => e.stopPropagation());
  }

  async function run(cmd) {
    const c = commands[cmd]; if (!c) return;
    const ae = document.activeElement;
    if (ae && ae.matches && ae.matches('input[type=text], input[type=search], input[type=number], input:not([type])')) {
      // menu shortcuts while typing act on the text field
      if (cmd === 'selectAll') { ae.select(); return; }
      if (cmd === 'undo' || cmd === 'redo') { document.execCommand(cmd); return; }
      if (cmd === 'delete') { document.execCommand('delete'); return; }
    }
    if ($('#dlg').open && cmd !== 'about') return;
    if (!c.enabled()) return;
    try { await c.run(); } catch (e) { console.error(e); alertBox('Something went wrong', `<p>${esc(e.message || e)}</p>`); }
  }
  function syncCommands() {
    const states = {};
    for (const k in commands) states[k] = !!commands[k].enabled();
    $$('[data-cmd]').forEach(b => { if (b.tagName === 'BUTTON') b.disabled = !states[b.dataset.cmd]; });
    host.menu(states);
    refreshActions();
  }

  // ------------------------------------------------------------------ fallback HTML menu (browser only)
  const MENU = [
    ['File', [['new', 'New', '⌘N'], ['open', 'Open…', '⌘O'], ['revert', 'Revert'], ['import', 'Import…', '⌘I'], '-', ['remap', 'Remap IDs…'], '-', ['save', 'Save', '⌘S'], ['saveAs', 'Save As…', '⇧⌘S'], ['saveSelected', 'Save Selected…'], ['exportWav', 'Export Samples as WAV…', '⌘E'], '-', ['fileInfo', 'File Information', '⌘J']]],
    ['Edit', [['undo', 'Undo', '⌘Z'], ['redo', 'Redo', '⇧⌘Z'], '-', ['delete', 'Delete', '⌫'], '-', ['selectAll', 'Select All', '⌘A'], ['deselect', 'Deselect', '⌘D'], ['selectDependants', 'Select Dependants', '⌘↓'], ['selectUsers', 'Select Users', '⌘↑']]],
    ['Object', [['rename', 'Rename', '↩'], '-', 'Sample', ['setRoot', 'Set Root Key…', '⌘R'], ['guessRoot', 'Guess Root from Name'], ['altStart', 'AltStart to SampleEnd'], ['play', 'Play Sample', 'Space'], '-', 'Keymap', ['compact', 'Compact Keymap'], ['velosplit', 'New Velocity Split Keymap…'], '-', 'Program', ['newDrumset', 'New Drumset…'], ['newInstrument', 'New Instrument…']]],
    ['Options', [['fillMode', 'Fill Mode…']]],
    ['Help', [['help', 'KurzFiler Help'], ['about', 'About KurzFiler']]]
  ];
  function buildMenubar() {
    const mb = $('#menubar'); mb.hidden = false;
    mb.innerHTML = MENU.map(([t, items]) => `<div class="mb"><button type="button">${t}</button><div class="menu">${items.map(i => i === '-' ? '<hr>' : typeof i === 'string' ? `<div class="sub-title">${i}</div>` : `<button type="button" data-cmd="${i[0]}">${i[1]}<span class="k">${i[2] || ''}</span></button>`).join('')}</div></div>`).join('');
    mb.addEventListener('click', e => {
      const top = e.target.closest('.mb > button');
      if (top) { const m = top.parentElement; const was = m.classList.contains('open'); $$('.mb', mb).forEach(x => x.classList.remove('open')); if (!was) m.classList.add('open'); e.stopPropagation(); return; }
      if (e.target.closest('.menu [data-cmd]')) $$('.mb', mb).forEach(x => x.classList.remove('open'));
    });
    mb.addEventListener('mouseover', e => { const top = e.target.closest('.mb'); if (top && $('.mb.open', mb) && !top.classList.contains('open')) { $$('.mb', mb).forEach(x => x.classList.remove('open')); top.classList.add('open'); } });
    document.addEventListener('click', () => $$('.mb', mb).forEach(x => x.classList.remove('open')));
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-cmd]');
    if (b && !b.disabled) { run(b.dataset.cmd); return; }
    const f = e.target.closest('[data-filter]');
    if (f) { state.filter = f.dataset.filter; update(); return; }
    const g = e.target.closest('[data-goto]');
    if (g) { const h = +g.dataset.goto; if (!visibleRows().some(o => o.hash === h)) { state.filter = 'all'; state.search = ''; $('#search').value = ''; } select([h]); return; }
    if (e.target.id === 'play') { run('play'); return; }
    const sb = e.target.closest('[data-sub]');
    if (sb) { subSound = +sb.dataset.sub; $$('#subsel button').forEach(x => x.classList.toggle('on', x === sb)); stopAudio(); drawWave(selected()[0]); return; }
    const vb = e.target.closest('[data-velo]');
    if (vb) { veloTab = +vb.dataset.velo; $$('#velotabs button').forEach(x => x.classList.toggle('on', x === vb)); drawKeyboard(selected()[0]); return; }
    const key = e.target.closest('[data-key]');
    if (key) { playKey(+key.dataset.key, key); return; }
    const th = e.target.closest('th[data-sort]');
    if (th) { const c = th.dataset.sort; if (state.sort.col === c) { if (state.sort.dir < 0) state.sort = { col: 'hash', dir: 1 }; else state.sort = { col: c, dir: -1 }; } else state.sort = { col: c, dir: 1 }; renderTable(); }
  });
  function playKey(i, el) {
    const k = selected()[0]; if (!(k instanceof K.KKeymap)) return;
    const e = (k.maps[k.velo[veloTab]] || [])[i]; const info = $('#kbd-info');
    if (!e || ((k.method & 1) && e.ss === 0)) { if (info) info.textContent = K.noteName(i + 12) + ': nothing mapped'; return; }
    const { sid, ss } = k.entrySample(e);
    const s = state.objects.get(K.makeHash(sid, K.T_SAMPLE));
    if (info) info.textContent = K.noteName(i + 12) + ' → ' + (s ? 'Sample ' + sid + ' ' + s.name + (s.multiRoot ? ' (sound ' + ss + ')' : '') : 'Sample ' + sid + ' (ROM or missing)');
    if (!s) return;
    const hi = Math.max(0, Math.min(s.headers.length - 1, ss - 1));
    const note = (i * k.centsPerEntry + k.basePitch) / 100 + 12;
    playHeader(s, hi, (note - s.headers[hi].rootkey) * 100 + e.tuning, true);
    $$('#kbd .k.on').forEach(x => x.classList.remove('on')); el.classList.add('on');
  }

  // table selection
  const tw = $('#tablewrap');
  tw.addEventListener('mousedown', e => {
    const tr = e.target.closest('tr[data-h]');
    if (!tr) { if (!e.target.closest('th') && !e.target.closest('.empty') && state.sel.size) select([]); return; }
    const h = +tr.dataset.h;
    if (e.metaKey || e.ctrlKey) { if (state.sel.has(h)) state.sel.delete(h); else state.sel.add(h); state.anchor = h; state.focusHash = h; update(); }
    else if (e.shiftKey && state.anchor !== null) {
      const ids = rowsCache.map(o => o.hash); const a = ids.indexOf(state.anchor), b = ids.indexOf(h);
      if (a >= 0 && b >= 0) { state.sel = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); state.focusHash = h; update(); }
    } else if (!(state.sel.has(h) && state.sel.size > 1 && e.button === 2)) { state.sel = new Set([h]); state.anchor = h; state.focusHash = h; update(); }
  });
  tw.addEventListener('dblclick', e => {
    const td = e.target.closest('td.name'); const tr = e.target.closest('tr[data-h]');
    if (td && tr) startInlineRename(+tr.dataset.h);
    else if (tr) { const o = state.objects.get(+tr.dataset.h); if (o instanceof K.KSample) run('play'); }
  });

  document.addEventListener('keydown', e => {
    if ($('#dlg').open) return;
    const inField = e.target.matches('input, select, textarea');
    const mod = isMac ? e.metaKey : e.ctrlKey;
    // shortcuts handled by the native menu in the app; here for the browser version
    if (!host.native && mod && !e.altKey) {
      const k = e.key.toLowerCase();
      const map = { n: 'new', o: 'open', s: e.shiftKey ? 'saveAs' : 'save', i: 'import', e: 'exportWav', z: e.shiftKey ? 'redo' : 'undo', y: 'redo', d: 'deselect', r: 'setRoot', j: 'fileInfo' };
      if (k === 'a' && !inField) { e.preventDefault(); run('selectAll'); return; }
      if (map[k]) { e.preventDefault(); run(map[k]); return; }
    }
    if (inField) return;
    if (mod && e.key === 'ArrowDown') { e.preventDefault(); run('selectDependants'); return; }
    if (mod && e.key === 'ArrowUp') { e.preventDefault(); run('selectUsers'); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) { e.preventDefault(); run('delete'); return; }
    if (e.key === 'Enter') { e.preventDefault(); run('rename'); return; }
    if (e.key === ' ') { e.preventDefault(); run('play'); return; }
    if (e.key === 'Escape') { stopAudio(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const ids = rowsCache.map(o => o.hash); if (!ids.length) return;
      let i = ids.indexOf(state.focusHash); i = i < 0 ? (e.key === 'ArrowDown' ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      const h = ids[i];
      if (e.shiftKey && state.anchor !== null) { const a = ids.indexOf(state.anchor); state.sel = new Set(ids.slice(Math.min(a, i), Math.max(a, i) + 1)); state.focusHash = h; update(); scrollToHash(h); }
      else select([h]);
    }
  });
  $('#search').addEventListener('input', e => { state.search = e.target.value; renderTable(); });

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#dropzone').classList.add('show'); e.preventDefault(); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').classList.remove('show'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault(); dragDepth = 0; $('#dropzone').classList.remove('show');
    const files = [];
    for (const f of e.dataTransfer.files) {
      const path = native && native.pathForFile ? native.pathForFile(f) : null;
      files.push({ name: f.name, path, data: new Uint8Array(await f.arrayBuffer()) });
    }
    if (!files.length) return;
    const hasKrz = files.some(f => K.detectKind(f.data) === 'krz');
    if (hasKrz && !state.objects.size && !state.path) openFiles(files);
    else importFiles(files);
  });

  // ------------------------------------------------------------------ native bridge
  if (native) {
    document.body.classList.add('native');
    native.onMenu(cmd => run(cmd));
    native.onOpenFiles(async files => { if (await askSaveChanges('opening another file')) openFiles(files); });
    native.onImportFiles(files => importFiles(files));
    native.onCloseRequest(async () => { native.closeReply(await askSaveChanges('closing')); });
  } else {
    buildMenubar();
    window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
  }

  // expose for automated tests
  window.kf = { state, run, commands, openFiles, importFiles, K };
  update();
})();
