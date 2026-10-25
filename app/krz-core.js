/*
 * KurzFiler for macOS — core library
 * A modern re-implementation of KurzFiler (c) 2001-08 Marc Halbrügge, Sven Thoennissen (GPL v2 or later).
 * Reads and writes Kurzweil K2000 / K2500 / K2600 files (.krz .k25 .k26),
 * imports WAV / AIFF / IFF-8SVX audio and exports WAV.
 *
 * This file has no dependencies and runs both in the browser and in Node (for tests).
 * Licensed under the GNU General Public License v3 or later (see LICENSE).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KRZ = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- hashes
  const T_PROGRAM = 36, T_KEYMAP = 37, T_SAMPLE = 38, T_SETUP = 41, T_STUDIO = 44;
  const T_QABANK = 111, T_SONG = 112, T_EFFECT = 113;
  const TYPE_NAMES = {
    36: 'Program', 37: 'Keymap', 38: 'Sample', 41: 'Setup', 44: 'Studio',
    111: 'QA Bank', 112: 'Song', 113: 'Effect'
  };
  const PKS = new Set([T_PROGRAM, T_KEYMAP, T_SAMPLE]);

  function hashType(h) { return (h & 0x8000) ? (h >>> 10) : (h >>> 8); }
  function hashID(h) {
    if (h & 0x8000) return h & 1023;
    const t = hashType(h), s = h & 255;
    if (t === T_EFFECT) return s < 38 ? s : ((s - 8) % 10 + 10 * ((s - 28) - (s - 8) % 10));
    if (t === T_SONG || t === T_QABANK) return 1023 & (((s - 16) % 20) + 5 * ((s - 56) - ((s - 16) % 20)));
    return s;
  }
  // only valid for the 32..63 range of types (programs, keymaps, samples, setups, studios ...)
  function makeHash(id, type) { return ((type << 10) + id) & 0xffff; }
  function typeName(h) { return TYPE_NAMES[hashType(h)] || 'Object'; }

  // ---------------------------------------------------------------- notes
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NOTE_NUM = { A: 9, B: 11, C: 0, D: 2, E: 4, F: 5, G: 7 };
  function noteName(n) {
    n = n | 0;
    if (n < 0) n += 256; // java prints bytes oddly; keep it sane
    return NOTE_NAMES[n % 12] + String(Math.floor(n / 12) - 1);
  }
  function toByte(x) { x = x & 255; return x > 127 ? x - 256 : x; }
  function toShort(x) { x = x & 0xffff; return x > 32767 ? x - 65536 : x; }
  function parseJavaByte(s) {
    if (!/^[+-]?\d+$/.test(s)) throw new Error('not a number');
    const v = parseInt(s, 10);
    if (v < -128 || v > 127) throw new Error('out of range');
    return v;
  }
  /** Parses "C4", "F#3", "Bb2" or a MIDI number (KurzFiler rules, plus flats). Throws on error. */
  function parseNote(text) {
    let h = String(text).trim().toUpperCase();
    let b;
    if (h.length && h[0] >= 'A' && h[0] <= 'G') {
      b = NOTE_NUM[h[0]];
      if (h.length < 2) throw new Error('incomplete note');
      if (h[1] === '#') { b++; h = h.substring(2); }
      else if (h[1] === 'B' && h.length > 2) { b--; h = h.substring(2); }
      else h = h.substring(1);
      b = toByte(b + parseJavaByte(h) * 12 + 12);
    } else {
      b = parseJavaByte(h);
    }
    if (b >= 0 && b < 128) return b;
    throw new Error('note out of range');
  }

  // ---------------------------------------------------------------- binary helpers
  class Reader {
    constructor(u8) { this.buf = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.pos = 0; }
    need(n) { if (this.pos + n > this.buf.length) throw new Error('Unexpected end of file'); }
    u16() { this.need(2); const v = this.dv.getUint16(this.pos); this.pos += 2; return v; }
    i16() { this.need(2); const v = this.dv.getInt16(this.pos); this.pos += 2; return v; }
    i32() { this.need(4); const v = this.dv.getInt32(this.pos); this.pos += 4; return v; }
    i8() { this.need(1); const v = this.dv.getInt8(this.pos); this.pos += 1; return v; }
    u8() { this.need(1); return this.buf[this.pos++]; }
    bytes(n) { this.need(n); const b = this.buf.slice(this.pos, this.pos + n); this.pos += n; return b; }
  }
  class Writer {
    constructor(cap) { this.buf = new Uint8Array(cap || 65536); this.len = 0; }
    ensure(n) {
      if (this.len + n <= this.buf.length) return;
      let c = this.buf.length * 2; while (c < this.len + n) c *= 2;
      const nb = new Uint8Array(c); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
    }
    u8(v) { this.ensure(1); this.buf[this.len++] = v & 255; }
    u16(v) { this.ensure(2); this.buf[this.len++] = (v >>> 8) & 255; this.buf[this.len++] = v & 255; }
    i32(v) { this.ensure(4); this.buf[this.len++] = (v >>> 24) & 255; this.buf[this.len++] = (v >>> 16) & 255; this.buf[this.len++] = (v >>> 8) & 255; this.buf[this.len++] = v & 255; }
    bytes(b) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
    setI32(at, v) { this.buf[at] = (v >>> 24) & 255; this.buf[at + 1] = (v >>> 16) & 255; this.buf[at + 2] = (v >>> 8) & 255; this.buf[at + 3] = v & 255; }
    setU16(at, v) { this.buf[at] = (v >>> 8) & 255; this.buf[at + 1] = v & 255; }
    result() { return this.buf.slice(0, this.len); }
  }
  function nameToBytes(name) {
    const b = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i++) b[i] = name.charCodeAt(i) & 255;
    return b;
  }
  function bytesToName(b) {
    let s = '';
    for (let i = 0; i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  /** Make a user-typed name safe for the instrument (printable ASCII). */
  function cleanName(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_');
  }

  // ---------------------------------------------------------------- objects
  class KObject {
    constructor(hash, name) { this.hash = hash; this.name = name || ''; }
    get type() { return hashType(this.hash); }
    get id() { return hashID(this.hash); }
    get typeName() { return typeName(this.hash); }
    dependants() { return []; }
    description() { return ''; }
    /** body bytes after the name */
    body() { return new Uint8Array(0); }
    /** Serialise the object exactly like KObject.writestart/writefinish of the original */
    serialize(nameMax) {
      let name = this.name;
      if (nameMax && name.length > nameMax) name = name.substring(0, nameMax);
      const nb = nameToBytes(name);
      const body = this.body();
      const n = nb.length;
      const nameField = (n & 1) === 0 ? n + 2 : n + 1;
      const ofs = (n & 1) === 0 ? n + 4 : n + 3;
      let total = 6 + nameField + body.length;
      if (total & 1) total++;
      const out = new Uint8Array(total);
      out[0] = (this.hash >>> 8) & 255; out[1] = this.hash & 255;
      out[2] = (total >>> 8) & 255; out[3] = total & 255;
      out[4] = (ofs >>> 8) & 255; out[5] = ofs & 255;
      out.set(nb, 6);
      out.set(body, 6 + nameField);
      return out;
    }
    size() { return this.serialize().length; }
    copyBase(o) { o.hash = this.hash; o.name = this.name; return o; }
  }

  class KDefault extends KObject {
    constructor(hash, name, data) { super(hash, name); this.data = data || new Uint8Array(0); }
    body() { return this.data; }
    clone() { return this.copyBase(new KDefault(0, '', this.data)); }
    updateLinks() { }
  }

  // ---- programs
  const SEG = { PGM: 8, LYR: 9, FX: 15, ASR: 16, LFO: 20, FUN: 24, ENC: 32, ENV: 33, IMP: 39, CAL: 64, HOB: 80, KDFX: 104, KB3: 120 };
  function segLen(tag) {
    if (tag === SEG.PGM) return 15;
    if (tag === SEG.LYR) return 15;
    if (tag === SEG.FX) return 7;
    switch (tag & 0xf8) {
      case SEG.FUN: return 3;
      case SEG.ASR: case SEG.LFO: case SEG.KDFX: return 7;
      case SEG.ENC: case SEG.HOB: return 15;
      case SEG.CAL: case SEG.KB3: return 31;
    }
    return 0;
  }

  class KProgram extends KObject {
    constructor(hash, name, raw) { super(hash, name); this.raw = raw || null; this._segs = null; }
    get segs() {
      if (!this._segs) {
        const segs = [];
        const r = this.raw || new Uint8Array(0);
        let p = 0;
        while (p < r.length) {
          const tag = r[p];
          const len = segLen(tag);
          const data = new Uint8Array(len);
          data.set(r.subarray(p + 1, Math.min(r.length, p + 1 + len)));
          p += 1 + len;
          if (tag !== 0) segs.push({ tag, data });
        }
        this._segs = segs;
      }
      return this._segs;
    }
    set segs(v) { this._segs = v; this.raw = null; }
    body() {
      if (this.raw) return this.raw;
      let n = 2; for (const s of this.segs) n += 1 + s.data.length;
      const out = new Uint8Array(n); let p = 0;
      for (const s of this.segs) { out[p++] = s.tag; out.set(s.data, p); p += s.data.length; }
      return out; // last two bytes are the terminating zero word
    }
    clone() {
      const p = new KProgram(0, '', this.raw);
      if (!this.raw) p._segs = this.segs.map(s => ({ tag: s.tag, data: s.data.slice() }));
      return this.copyBase(p);
    }
    pgmSeg() { return this.segs.find(s => s.tag === SEG.PGM); }
    mode() { const s = this.pgmSeg(); return s ? toByte(s.data[0]) : 0; }
    numLayers() { const s = this.pgmSeg(); return s ? toByte(s.data[1]) : 0; }
    description() {
      let s = this.numLayers() + ' Layer' + (this.numLayers() === 1 ? '' : 's');
      const m = this.mode();
      if (m === 3) s += ' · requires K2500';
      else if (m === 4) s += ' · requires KDFX';
      return s;
    }
    keymapIDs() {
      const ids = [];
      for (const s of this.segs) {
        if (s.tag === SEG.CAL) {
          const k1 = (toByte(s.data[7]) << 8) + s.data[8];
          const k2 = (toByte(s.data[11]) << 8) + s.data[12];
          ids.push(k1, k2);
        }
      }
      return ids;
    }
    dependants() {
      const out = new Set();
      for (const k of this.keymapIDs()) if (k !== 0) out.add(makeHash(k & 0xffff, T_KEYMAP));
      return [...out].sort((a, b) => a - b);
    }
    /** returns a modified copy, or this if nothing changes */
    withLinks(map) {
      let changed = false;
      const segs = this.segs.map(s => {
        if (s.tag !== SEG.CAL) return s;
        let d = s.data;
        for (const at of [7, 11]) {
          const km = (toByte(s.data[at]) << 8) + s.data[at + 1];
          const nh = map.get(makeHash(km & 0xffff, T_KEYMAP));
          if (nh !== undefined) {
            const nid = hashID(nh);
            if (d === s.data) d = s.data.slice();
            d[at] = (nid >>> 8) & 255; d[at + 1] = nid & 255;
            changed = true;
          }
        }
        return d === s.data ? s : { tag: s.tag, data: d };
      });
      if (!changed) return this;
      const p = new KProgram(this.hash, this.name, null);
      p._segs = segs;
      return p;
    }
    /** strip for older instruments: target 2 = K2000, 3 = K2500 without KDFX */
    stripped(target) {
      if (this.mode() <= target) return this;
      const segs = [];
      for (const s of this.segs) {
        if (s.tag === SEG.PGM) { const d = s.data.slice(); d[0] = target; segs.push({ tag: s.tag, data: d }); continue; }
        if (target === 2 && s.tag === SEG.IMP) continue;
        if ((s.tag & 96) === 96) continue;
        segs.push(s);
      }
      const p = new KProgram(this.hash, this.name, null);
      p._segs = segs;
      return p;
    }
  }

  /** build a program like KProgram.makePGMblock() + addLayer() of the original */
  function makeProgram(hash, name, keymapID, stereo) {
    const segs = [];
    const seg = (tag) => { const s = { tag, data: new Uint8Array(segLen(tag)) }; segs.push(s); return s; };
    let s = seg(SEG.PGM);
    s.data[0] = 2; s.data[1] = 0; s.data[3] = 0x37; s.data[4] = 64;
    s = seg(SEG.LYR);
    s.data[1] = 0x18; s.data[4] = 0x7f; s.data[6] = 0x7f; s.data[8] = stereo ? 0x24 : 0x04;
    seg(SEG.ENC);
    s = seg(SEG.ENV); s.data[1] = 100; s.data[7] = 100;
    s = seg(SEG.CAL);
    s.data[0] = 0x7f; s.data[3] = 0x2b; s.data[29] = 1;
    const km = keymapID & 255; // the original wrote getID(getID(hash)), links are fixed on import
    s.data[7] = (km >>> 8) & 255; s.data[8] = km & 255; s.data[11] = (km >>> 8) & 255; s.data[12] = km & 255;
    s = seg(0x50); s.data[0] = 62;
    s = seg(0x51); s.data[0] = 60;
    s = seg(0x52); s.data[0] = 60;
    s = seg(0x53); s.data[0] = 1; s.data[2] = 0x70; s.data[13] = 4; s.data[14] = stereo ? 0x90 : 0x00;
    segs[0].data[1]++;
    const p = new KProgram(hash, name, null);
    p._segs = segs;
    return p;
  }

  // ---- keymaps
  function methodSize(m) {
    let r = 0;
    if (m & 0x10) r += 2; else if (m & 0x08) r += 1;
    if (m & 0x04) r += 1;
    if (m & 0x02) r += 2;
    if (m & 0x01) r += 1;
    return r;
  }
  const LEVEL_NAMES = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];

  class KKeymap extends KObject {
    constructor(hash, name) {
      super(hash, name);
      this.raw = null;           // original body, kept until modified
      this.sampleId = 0; this.method = 0; this.basePitch = 0; this.centsPerEntry = 100; this.entriesPerVel = 127;
      this.maps = [];            // array of arrays of entries {tuning, vol, sid, ss}
      this.velo = [0, 0, 0, 0, 0, 0, 0, 0]; // index into maps for each velocity level
    }
    static parse(hash, name, body) {
      const k = new KKeymap(hash, name);
      const r = new Reader(body);
      k.sampleId = r.i16(); k.method = r.i16(); k.basePitch = r.i16(); k.centsPerEntry = r.i16();
      k.entriesPerVel = r.i16(); k.entrySizeField = r.i16();
      const lev = []; for (let j = 0; j < 8; j++) lev.push(r.i16() - (8 - j) * 2);
      const m = k.method, n = k.entriesPerVel + 1, lsize = n * methodSize(m);
      let count = 1;
      if (lsize > 0) count = Math.max(...lev) / lsize + 1;
      if (!Number.isInteger(count) || count < 1 || count > 8) {
        // fall back to the original algorithm
        count = 1; for (let j = 1; j < 8; j++) if (lev[j] !== lev[j - 1]) count++;
      }
      for (let c = 0; c < count; c++) {
        const entries = [];
        for (let i = 0; i < n; i++) {
          const e = { tuning: 0, vol: 0, sid: 0, ss: 0 };
          if (m & 0x10) e.tuning = r.i16(); else if (m & 0x08) e.tuning = r.i8();
          if (m & 0x04) e.vol = r.i8();
          if (m & 0x02) e.sid = r.i16();
          if (m & 0x01) e.ss = r.i8();
          entries.push(e);
        }
        k.maps.push(entries);
      }
      for (let j = 0; j < 8; j++) k.velo[j] = lsize > 0 ? Math.min(count - 1, Math.max(0, Math.round(lev[j] / lsize))) : 0;
      k.raw = body;
      return k;
    }
    get compactable() { return (this.method & 2) === 2; }
    get entrySize() { return methodSize(this.method); }
    body() {
      if (this.raw) return this.raw;
      const w = new Writer(64 + this.maps.length * (this.entriesPerVel + 1) * 5);
      const m = this.method, es = methodSize(m), lsize = (this.entriesPerVel + 1) * es;
      w.u16(this.sampleId); w.u16(m); w.u16(this.basePitch); w.u16(this.centsPerEntry); w.u16(this.entriesPerVel); w.u16(es);
      for (let j = 0; j < 8; j++) w.u16((8 - j) * 2 + this.velo[j] * lsize);
      for (const entries of this.maps) {
        for (const e of entries) {
          if (m & 0x10) w.u16(e.tuning); else if (m & 0x08) w.u8(e.tuning);
          if (m & 0x04) w.u8(e.vol);
          if (m & 0x02) w.u16(e.sid);
          if (m & 0x01) w.u8(e.ss);
        }
      }
      return w.result();
    }
    clone() {
      const k = new KKeymap(0, '');
      this.copyBase(k);
      k.raw = this.raw; k.sampleId = this.sampleId; k.method = this.method; k.basePitch = this.basePitch;
      k.centsPerEntry = this.centsPerEntry; k.entriesPerVel = this.entriesPerVel; k.entrySizeField = this.entrySizeField;
      k.maps = this.maps.map(es => es.map(e => ({ tuning: e.tuning, vol: e.vol, sid: e.sid, ss: e.ss })));
      k.velo = this.velo.slice();
      return k;
    }
    numLevels() { return this.maps.length; }
    description() { const n = this.numLevels(); return n + ' Velocity Level' + (n === 1 ? '' : 's'); }
    /** sample id (not hash) and subsample (1-based) of an entry */
    entrySample(e) {
      return { sid: this.compactable ? e.sid : this.sampleId, ss: (this.method & 1) ? e.ss : 1 };
    }
    dependants() {
      const out = new Set();
      if (!this.compactable) { if (this.sampleId) out.add(makeHash(this.sampleId & 1023, T_SAMPLE)); }
      else for (const es of this.maps) for (const e of es) if (e.sid !== 0) out.add(makeHash(e.sid & 1023, T_SAMPLE));
      return [...out].sort((a, b) => a - b);
    }
    /** convert to per-entry sample ids (method | 2) */
    makeCompactable() {
      if (this.compactable) return;
      for (const es of this.maps) for (const e of es) e.sid = this.sampleId;
      if (!(this.method & 1)) { for (const es of this.maps) for (const e of es) e.ss = 1; this.method |= 1; }
      this.method |= 2; this.raw = null;
    }
    withLinks(map) {
      const conv = (sid) => { const nh = map.get(makeHash(sid & 1023, T_SAMPLE)); return nh === undefined ? sid : hashID(nh); };
      if (!this.compactable) {
        const ns = conv(this.sampleId);
        if (ns === this.sampleId) return this;
        const k = this.clone(); k.sampleId = ns; k.raw = null; return k;
      }
      let changed = false;
      for (const es of this.maps) for (const e of es) if (e.sid && conv(e.sid) !== e.sid) changed = true;
      if (!changed) return this;
      const k = this.clone(); k.raw = null;
      for (const es of k.maps) for (const e of es) if (e.sid) e.sid = conv(e.sid);
      return k;
    }
    /** If every used entry refers to the same sample, drop per-entry sample IDs (KKeymap.compact) */
    compact() {
      if (!this.compactable) return;
      let id = 0;
      for (const es of this.maps) for (const e of es) {
        const used = (this.method & 1) ? e.ss !== 0 : true;
        if (used) { if (id === 0) id = e.sid; else if (id !== e.sid) return; }
      }
      this.sampleId = id; this.method &= 253; this.raw = null;
    }
    /** min and max velocity level (0..7) that use map index i */
    veloRange(i) {
      let lo = -1, hi = -1;
      for (let j = 0; j < 8; j++) if (this.velo[j] === i) { if (lo < 0) lo = j; hi = j; }
      return [lo, hi];
    }
  }

  // ---- samples
  class SoundHeader {
    constructor() {
      this.rootkey = 60; this.flags = 0x70; this.volumeAdjust = 0; this.altVolumeAdjust = 0;
      this.maxPitch = 0; this.offsetToName = 0;
      this.sampleStart = 0; this.altSampleStart = 0; this.sampleLoopStart = 0; this.sampleEnd = 0;
      this.offsetToEnvelope = 0; this.altOffsetToEnvelope = 0; this.samplePeriod = 22675;
      this.data = null; // Uint8Array, 16 bit big endian, covers sampleStart..sampleEnd
    }
    static read(r, warnings) {
      const h = new SoundHeader();
      h.rootkey = r.i8(); h.flags = r.u8(); h.volumeAdjust = r.i8(); h.altVolumeAdjust = r.i8();
      h.maxPitch = r.i16(); h.offsetToName = r.i16();
      h.sampleStart = r.i32(); h.altSampleStart = r.i32(); h.sampleLoopStart = r.i32(); h.sampleEnd = r.i32();
      h.offsetToEnvelope = r.i16(); h.altOffsetToEnvelope = r.i16(); h.samplePeriod = r.i32();
      if (h.samplePeriod < 1) { h.samplePeriod = 22675; h.setRootKey(h.rootkey); warnings.push('Bad sampling frequency reset to 44100 Hz.'); }
      if (h.sampleStart > h.sampleEnd) { h.sampleStart = 0; warnings.push('Bad sample start reset to 0.'); }
      if (h.sampleLoopStart > h.sampleEnd) { h.sampleLoopStart = 0; warnings.push('Bad sample loop start reset to 0.'); }
      if (h.sampleEnd < 0) { h.sampleEnd = 0; warnings.push('Bad sample end reset to 0.'); }
      return h;
    }
    clone() { const h = Object.assign(new SoundHeader(), this); return h; }
    get needsLoad() { return (this.flags & 0x40) === 0x40; }
    get looped() { return (this.flags & 0x80) === 0; }
    get frames() { return this.sampleEnd - this.sampleStart + 1; }
    get sampleRate() { return 1e9 / this.samplePeriod; }
    ramSize() { return this.needsLoad ? (this.sampleEnd - this.sampleStart + 1) * 2 : 0; }
    setRootKey(r) {
      this.rootkey = r;
      this.maxPitch = toShort(Math.ceil(1200.0 * Math.log(96000.0 / 1000000000 * this.samplePeriod) / Math.log(2.0)) + 100 * r - 1200);
    }
    /** relative positions (sample data starts at 0) like Soundfilehead.prewrite */
    rel() {
      const s = this.sampleStart;
      let end = this.sampleEnd - s, loop = this.sampleLoopStart - s, alt = this.altSampleStart - s;
      if (alt > end) alt = 0;
      return { end, loop, alt };
    }
    write(w, offset) {
      let start = this.sampleStart, alt = this.altSampleStart, loop = this.sampleLoopStart, end = this.sampleEnd;
      if (this.needsLoad) { const r = this.rel(); start = offset; end = r.end + offset; loop = r.loop + offset; alt = r.alt + offset; }
      w.u8(this.rootkey); w.u8(this.flags); w.u8(this.volumeAdjust); w.u8(this.altVolumeAdjust);
      w.u16(this.maxPitch); w.u16(this.offsetToName);
      w.i32(start); w.i32(alt); w.i32(loop); w.i32(end);
      w.u16(this.offsetToEnvelope); w.u16(this.altOffsetToEnvelope); w.i32(this.samplePeriod);
    }
    /** Float32 samples for preview */
    toFloat() {
      const d = this.data; if (!d) return new Float32Array(0);
      const n = d.length >> 1, out = new Float32Array(n);
      for (let i = 0; i < n; i++) { let v = (d[2 * i] << 8) | d[2 * i + 1]; if (v > 32767) v -= 65536; out[i] = v / 32768; }
      return out;
    }
  }

  function defaultEnvelopes() {
    // two envelopes of six shorts: -1, 1, 0, 0, -1600, 0
    const e = new Uint8Array(24);
    const vals = [-1, 1, 0, 0, -1600, 0];
    for (let k = 0; k < 2; k++) for (let i = 0; i < 6; i++) { const v = vals[i] & 0xffff; e[k * 12 + 2 * i] = v >>> 8; e[k * 12 + 2 * i + 1] = v & 255; }
    return e;
  }

  class KSample extends KObject {
    constructor(hash, name) {
      super(hash, name);
      this.baseID = 1; this.headersOfs = 8; this.flags = 0; this.ks1 = 0; this.copyID = 0; this.ks2 = 0;
      this.headers = [];
      this.tail = defaultEnvelopes();  // envelopes + extra data, written back unchanged
      this.recalcEnvOffsets = true;    // new samples: compute envelope offsets like the original
    }
    static parse(hash, name, body, warnings) {
      const s = new KSample(hash, name);
      const r = new Reader(body);
      s.baseID = r.i16(); const numHeaders = r.i16(); s.headersOfs = r.i16();
      s.flags = r.i8(); s.ks1 = r.i8(); s.copyID = r.i16(); s.ks2 = r.i16();
      for (let n = 0; n <= numHeaders; n++) s.headers.push(SoundHeader.read(r, warnings));
      s.tail = body.slice(r.pos);
      s.recalcEnvOffsets = false;
      return s;
    }
    get stereo() { return this.flags === 1; }
    get multiRoot() { return this.stereo ? this.headers.length > 2 : this.headers.length > 1; }
    /** indexes of the headers that start a (mono or stereo) sound */
    soundIndexes() { const out = []; for (let i = 0; i < this.headers.length; i += this.stereo ? 2 : 1) out.push(i); return out; }
    ramSize() { return this.headers.reduce((a, h) => a + h.ramSize(), 0); }
    rootKeyName() { return this.headers.length ? noteName(this.headers[0].rootkey) : ''; }
    description() {
      let s;
      if (this.multiRoot) s = 'MultiRoot ' + (this.stereo ? 'Stereo' : 'Mono');
      else s = this.rootKeyName() + ' ' + (this.stereo ? 'Stereo' : 'Mono');
      return s + ' · ' + Math.floor(this.ramSize() / 1024) + ' KB';
    }
    clone() {
      const s = new KSample(0, '');
      this.copyBase(s);
      s.baseID = this.baseID; s.headersOfs = this.headersOfs; s.flags = this.flags; s.ks1 = this.ks1;
      s.copyID = this.copyID; s.ks2 = this.ks2; s.tail = this.tail; s.recalcEnvOffsets = this.recalcEnvOffsets;
      s.headers = this.headers.map(h => h.clone());
      return s;
    }
    setRootKey(r) {
      this.headers[0].setRootKey(r);
      if (this.stereo && this.headers[1]) this.headers[1].setRootKey(r);
    }
    /** body with sample-data offsets; `offsets` = array of word offsets per header */
    bodyWith(offsets) {
      const w = new Writer(12 + this.headers.length * 32 + this.tail.length);
      const H = this.headers.length;
      w.u16(this.baseID); w.u16(H - 1); w.u16(8); w.u8(this.flags); w.u8(this.ks1); w.u16(this.copyID); w.u16(this.ks2);
      this.headers.forEach((h, n) => {
        if (this.recalcEnvOffsets) {
          const envofs = H * 32 - 32 - 32 * n;
          h.offsetToEnvelope = envofs + 8; h.altOffsetToEnvelope = envofs + 6;
        }
        h.write(w, offsets ? offsets[n] : 0);
      });
      w.bytes(this.tail);
      return w.result();
    }
    body() { return this.bodyWith(null); }
  }

  // ---------------------------------------------------------------- file document
  function parseObject(r, warnings) {
    const start = r.pos;
    const hash = r.u16();
    const size = r.u16();
    const ofs = r.u16();
    const nameBytes = r.bytes(ofs - 2);
    const name = bytesToName(nameBytes);
    const bodyLen = size - ofs - 4;
    if (bodyLen < 0) throw new Error('Corrupt object at byte ' + start);
    const body = r.bytes(bodyLen);
    switch (hashType(hash)) {
      case T_SAMPLE: return KSample.parse(hash, name, body, warnings);
      case T_KEYMAP: return KKeymap.parse(hash, name, body);
      case T_PROGRAM: return new KProgram(hash, name, body);
      default: return new KDefault(hash, name, body);
    }
  }

  /** Parse a .krz/.k25/.k26 file. Returns {objects: Map(hash -> object), warnings: [], header} */
  function parseKRZ(u8) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
    const warnings = [];
    if (u8.length < 36 || u8[0] !== 0x50 || u8[1] !== 0x52 || u8[2] !== 0x41 || u8[3] !== 0x4d)
      throw new Error('Not a K2x00 file (the file does not start with "PRAM").');
    const r = new Reader(u8);
    r.pos = 4;
    const osize = r.i32();
    const rest = []; for (let i = 0; i < 6; i++) rest.push(r.i32());
    const objects = new Map();
    let block = r.i32(); let pos = r.pos;
    while (block < 0) {
      const sub = new Reader(u8.subarray(0, Math.min(u8.length, pos - 4 - block)));
      sub.pos = pos;
      const o = parseObject(sub, warnings);
      if (objects.has(o.hash)) warnings.push('Duplicate object ' + o.typeName + ' ' + o.id + ' ignored.');
      else objects.set(o.hash, o);
      r.pos = pos - block - 4;
      block = r.i32(); pos = r.pos;
    }
    // sample data
    const samples = [...objects.values()].filter(o => o instanceof KSample).sort((a, b) => a.hash - b.hash);
    for (const s of samples) {
      for (const h of s.headers) {
        if (!h.needsLoad) continue;
        const from = osize + h.sampleStart * 2;
        const len = (h.sampleEnd - h.sampleStart + 1) * 2;
        if (from < 0 || from + len > u8.length) {
          const avail = Math.max(1, Math.floor((u8.length - from) / 2));
          warnings.push('Sample data of "' + s.name + '" is incomplete (file truncated?). It was shortened.');
          const d = new Uint8Array(avail * 2);
          if (from >= 0 && from < u8.length) d.set(u8.subarray(from, Math.min(u8.length, from + avail * 2)));
          h.data = d;
          h.sampleEnd = h.sampleStart + avail - 1;
          if (h.sampleLoopStart > h.sampleEnd) h.sampleLoopStart = h.sampleEnd;
        } else {
          h.data = u8.slice(from, from + len);
        }
        const st = h.sampleStart;
        h.sampleEnd -= st; h.sampleLoopStart -= st; h.altSampleStart -= st; h.sampleStart = 0;
        if (h.altSampleStart > h.sampleEnd) h.altSampleStart = 0;
      }
    }
    return { objects, warnings: [...new Set(warnings)], header: { osize, rest } };
  }

  const FORMATS = {
    krz: { key: 'krz', label: 'K2000 (.krz)', ext: '.krz', strip: 2, nameMax: 16 },
    k25: { key: 'k25', label: 'K2500 without KDFX (.k25)', ext: '.k25', strip: 3, nameMax: 0 },
    k26: { key: 'k26', label: 'K2600 / K2500 with KDFX (.k26 / .k25)', ext: '.k26', strip: 0, nameMax: 0 },
    raw: { key: 'raw', label: 'Keep everything as is', ext: '', strip: 0, nameMax: 0 }
  };

  /** Write objects (Map or array) to a K2x00 file. format: 'krz' | 'k25' | 'k26' | 'raw' */
  function writeKRZ(objects, format) {
    const fmt = FORMATS[format || 'raw'] || FORMATS.raw;
    let list = [...(objects instanceof Map ? objects.values() : objects)].sort((a, b) => a.hash - b.hash);
    if (fmt.strip) list = list.map(o => o instanceof KProgram ? o.stripped(fmt.strip) : o);
    // sample data offsets (prewrite)
    const offsets = new Map();
    let off = 0;
    for (const o of list) {
      if (!(o instanceof KSample)) continue;
      const arr = [];
      for (const h of o.headers) { arr.push(off); if (h.needsLoad) off = h.rel().end + off + 1; }
      offsets.set(o, arr);
    }
    let total = 32 + 4;
    for (const o of list) total += 8 + 64 + (o instanceof KSample ? 32 * o.headers.length + o.tail.length : o.body().length);
    const w = new Writer(total + off * 2 + 16);
    w.bytes([0x50, 0x52, 0x41, 0x4d]); w.i32(0);
    w.i32(0); w.i32(0); w.i32(353); w.i32(0); w.i32(0); w.i32(0);
    for (const o of list) {
      const at = w.len; w.i32(0);
      let bytes;
      if (o instanceof KSample) {
        const tmp = Object.create(o); tmp.body = () => o.bodyWith(offsets.get(o));
        bytes = KObject.prototype.serialize.call(tmp, fmt.nameMax);
      } else bytes = o.serialize(fmt.nameMax);
      w.bytes(bytes);
      while (w.len & 3) w.u8(0);
      w.setI32(at, at - w.len);
    }
    w.i32(0);
    w.setI32(4, w.len);
    for (const o of list) {
      if (!(o instanceof KSample)) continue;
      for (const h of o.headers) {
        if (!h.needsLoad) continue;
        const n = (h.rel().end + 1) * 2;
        const d = h.data || new Uint8Array(0);
        if (d.length >= n) w.bytes(d.subarray(0, n));
        else { w.bytes(d); w.bytes(new Uint8Array(n - d.length)); }
      }
    }
    return w.result();
  }

  // ---------------------------------------------------------------- fill modes / import
  const FILL = { FILL: 'fill', APPEND: 'append', MERGE: 'merge' };

  function nextHash(h) {
    const t = hashType(h);
    if (t >= 32 && t < 64) {
      let id = hashID(h) + 1; if (id > 999) id = 1;
      return makeHash(id, t);
    }
    let lo = (h & 255) + 1; if (lo > 255) lo = 1;
    return (h & 0xff00) | lo;
  }
  function findFree(start, taken) {
    let h = start, n = 0;
    while (taken(h)) { h = nextHash(h); if (++n > 1100) throw new Error('No free object number left for ' + typeName(start) + 's.'); }
    return h;
  }

  /**
   * Insert foreign objects into `target` (a Map) following KFile.importData of the original:
   * samples first, then keymaps, then everything else; links are updated on the way.
   * Returns the list of new hashes.
   */
  function importObjects(target, incoming, fillMode, fillStart) {
    fillMode = fillMode || FILL.FILL; fillStart = fillStart || 200;
    let pool = new Map();
    for (const o of (incoming instanceof Map ? incoming.values() : incoming)) pool.set(o.hash, o);
    const added = [];
    const newHashFor = (h) => {
      const t = hashType(h);
      if (fillMode === FILL.MERGE) return h;
      if (fillMode === FILL.FILL && PKS.has(t)) return findFree(makeHash(fillStart, t), x => target.has(x));
      return findFree(h, x => target.has(x));
    };
    const phase = (pred) => {
      const map = new Map();
      const ids = [...pool.keys()].filter(h => pred(hashType(h))).sort((a, b) => a - b);
      for (const h of ids) {
        let o = pool.get(h);
        const nh = newHashFor(h);
        if (nh !== h) { o = o.clone(); o.hash = nh; map.set(h, nh); }
        target.set(nh, o); added.push(nh);
        pool.delete(h);
      }
      if (map.size) {
        const np = new Map();
        for (const [h, o] of pool) np.set(h, o.withLinks ? o.withLinks(map) : o);
        pool = np;
      }
    };
    phase(t => t === T_SAMPLE);
    phase(t => t === T_KEYMAP);
    phase(() => true);
    return added;
  }

  /** Renumber programs, keymaps and samples consecutively from `start` (Remap IDs). */
  function remapIDs(objects, start) {
    const incoming = [...objects.values()];
    const target = new Map();
    importObjects(target, incoming, FILL.FILL, start || 200);
    return target;
  }

  // ---------------------------------------------------------------- dependants
  function directDependants(objects, h) {
    const o = objects.get(h); if (!o) return [];
    return o.dependants().filter(d => objects.has(d));
  }
  function dependantsRecursive(objects, h) {
    const out = new Set(); const todo = [h];
    while (todo.length) {
      const x = todo.pop();
      for (const d of directDependants(objects, x)) if (!out.has(d)) { out.add(d); todo.push(d); }
    }
    out.delete(h);
    return [...out].sort((a, b) => a - b);
  }
  function users(objects, h) {
    const out = [];
    for (const [k, o] of objects) if (o.dependants().includes(h)) out.push(k);
    return out.sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------- audio import
  function ascii(u8, p, n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[p + i]); return s; }
  function le32(u8, p) { return (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0; }
  function le16(u8, p) { return u8[p] | (u8[p + 1] << 8); }
  function be32(u8, p) { return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0; }
  function be16(u8, p) { return (u8[p] << 8) | u8[p + 1]; }
  function ext80(u8, p) { // IEEE 754 80 bit extended -> number
    const exp = ((u8[p] & 0x7f) << 8) | u8[p + 1];
    let mant = 0; for (let i = 0; i < 8; i++) mant = mant * 256 + u8[p + 2 + i];
    if (exp === 0 && mant === 0) return 0;
    return (u8[p] & 0x80 ? -1 : 1) * mant * Math.pow(2, exp - 16383 - 63);
  }

  /** Build a KSample like LoadWaveMethod.Wav2KSample of the original. channels: array of Int16Array */
  function buildSample(name, channels, rate, info) {
    info = info || {};
    const frames = channels[0].length;
    if (frames < 1) throw new Error('The audio file contains no samples.');
    const s = new KSample(makeHash(200, T_SAMPLE), cleanName(name).substring(0, 16));
    s.flags = channels.length === 2 ? 1 : 0;
    for (const ch of channels) {
      const h = new SoundHeader();
      h.samplePeriod = info.samplePeriod || Math.floor(1000000000 / rate);
      h.flags = 0x70;
      h.setRootKey(info.rootKey == null ? 60 : info.rootKey);
      h.sampleStart = 0; h.altSampleStart = 0;
      if (info.loop) {
        h.sampleEnd = Math.min(info.loop.end, frames - 1);
        h.sampleLoopStart = Math.max(0, Math.min(info.loop.start, h.sampleEnd));
      } else { h.sampleEnd = frames - 1; h.sampleLoopStart = h.sampleEnd; }
      const n = h.sampleEnd + 1;
      const d = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) { const v = ch[i]; d[2 * i] = (v >> 8) & 255; d[2 * i + 1] = v & 255; }
      h.data = d;
      s.headers.push(h);
    }
    return s;
  }

  function clamp16(x) { return x > 32767 ? 32767 : x < -32768 ? -32768 : x; }

  /** WAV (PCM 8/16/24/32 bit, float 32/64, WAVE_FORMAT_EXTENSIBLE), mono or stereo */
  function parseWAV(u8, fileName) {
    if (ascii(u8, 0, 4) !== 'RIFF') throw new Error('Unknown file format (expected RIFF).');
    if (ascii(u8, 8, 4) !== 'WAVE') throw new Error('Unknown file format (expected WAVE).');
    let p = 12, fmt = null, data = null, smpl = null;
    const end = Math.min(u8.length, le32(u8, 4) + 8);
    while (p + 8 <= end) {
      const id = ascii(u8, p, 4); let len = le32(u8, p + 4);
      const body = p + 8;
      if (body + len > u8.length) len = u8.length - body;
      if (id === 'fmt ') {
        let tag = le16(u8, body);
        const bits = le16(u8, body + 14);
        if (tag === 0xfffe && len >= 26) tag = le16(u8, body + 24);
        fmt = { tag, channels: le16(u8, body + 2), rate: le32(u8, body + 4), align: le16(u8, body + 12), bits };
      } else if (id === 'data' && !data) {
        data = u8.subarray(body, body + len);
      } else if (id === 'smpl' && !smpl && len >= 36) {
        smpl = { period: le32(u8, body + 8), root: le32(u8, body + 12), loops: le32(u8, body + 28) };
        if (smpl.loops >= 1 && len >= 60) {
          smpl.loopStart = le32(u8, body + 36 + 8); smpl.loopEnd = le32(u8, body + 36 + 12);
        }
      }
      p = body + len + (len & 1);
    }
    if (!fmt) throw new Error('The WAV file has no format chunk.');
    if (!data) throw new Error('The WAV file has no audio data.');
    if (fmt.tag !== 1 && fmt.tag !== 3) throw new Error('Unsupported WAV format (compressed audio). Please use PCM.');
    let rate = fmt.rate;
    if (Math.abs(rate - 44100) < 2) rate = 44100; else if (Math.abs(rate - 22050) < 2) rate = 22050;
    const nch = fmt.channels;
    if (nch < 1) throw new Error('The WAV file has no channels.');
    const bps = fmt.bits / 8;
    const frameBytes = fmt.align || bps * nch;
    const frames = Math.floor(data.length / frameBytes);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const useCh = Math.min(nch, 2);
    const chans = []; for (let c = 0; c < useCh; c++) chans.push(new Int16Array(frames));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < useCh; c++) {
        const q = i * frameBytes + c * bps;
        let v;
        if (fmt.tag === 3) v = clamp16(Math.round((bps === 8 ? dv.getFloat64(q, true) : dv.getFloat32(q, true)) * 32767));
        else if (bps === 1) v = (data[q] - 128) << 8;
        else if (bps === 2) v = dv.getInt16(q, true);
        else if (bps === 3) v = (data[q + 2] << 24 >> 16) | data[q + 1]; // keep the top 16 bits
        else if (bps === 4) v = dv.getInt32(q, true) >> 16;
        else throw new Error('Unsupported WAV bit depth: ' + fmt.bits);
        chans[c][i] = v;
      }
    }
    const info = {};
    if (smpl) {
      if (smpl.period) info.samplePeriod = smpl.period;
      info.rootKey = toByte(smpl.root) & 127;
      if (smpl.loops >= 1 && smpl.loopEnd !== undefined) info.loop = { start: smpl.loopStart, end: smpl.loopEnd };
    }
    const warn = nch > 2 ? 'Only the first two of ' + nch + ' channels were imported.' : null;
    // the original used the file name including ".wav", lower case
    const s = buildSample(fileName.toLowerCase(), chans, rate, info);
    s.importWarning = warn;
    return s;
  }

  /** AIFF and AIFF-C (uncompressed 'NONE'/'twos'/'sowt'/'fl32'), with loop & root from INST/MARK */
  function parseAIFF(u8, fileName) {
    if (ascii(u8, 0, 4) !== 'FORM') throw new Error('Not an AIFF file.');
    const form = ascii(u8, 8, 4);
    if (form !== 'AIFF' && form !== 'AIFC') throw new Error('Not an AIFF file.');
    let p = 12, comm = null, ssnd = null, marks = {}, inst = null;
    while (p + 8 <= u8.length) {
      const id = ascii(u8, p, 4), len = be32(u8, p + 4), b = p + 8;
      if (id === 'COMM') {
        comm = { ch: be16(u8, b), frames: be32(u8, b + 2), bits: be16(u8, b + 6), rate: ext80(u8, b + 8), comp: 'NONE' };
        if (form === 'AIFC' && len >= 22) comm.comp = ascii(u8, b + 18, 4);
      } else if (id === 'SSND') {
        const offset = be32(u8, b);
        ssnd = u8.subarray(b + 8 + offset, Math.min(u8.length, b + len));
      } else if (id === 'MARK') {
        const n = be16(u8, b); let q = b + 2;
        for (let i = 0; i < n; i++) { const mid = be16(u8, q), pos = be32(u8, q + 2), sl = u8[q + 6]; marks[mid] = pos; q += 7 + sl + ((sl + 1) & 1); }
      } else if (id === 'INST') {
        inst = { base: u8[b], playMode: be16(u8, b + 8), begin: be16(u8, b + 10), end: be16(u8, b + 12) };
      }
      p = b + len + (len & 1);
    }
    if (!comm || !ssnd) throw new Error('The AIFF file is incomplete.');
    const comp = comm.comp;
    if (!['NONE', 'twos', 'sowt', 'fl32', 'FL32'].includes(comp)) throw new Error('Unsupported AIFF-C compression: ' + comp);
    const bps = Math.ceil(comm.bits / 8), useCh = Math.min(comm.ch, 2);
    const fb = bps * comm.ch, frames = Math.min(comm.frames, Math.floor(ssnd.length / fb));
    const dv = new DataView(ssnd.buffer, ssnd.byteOffset, ssnd.byteLength);
    const chans = []; for (let c = 0; c < useCh; c++) chans.push(new Int16Array(frames));
    for (let i = 0; i < frames; i++) for (let c = 0; c < useCh; c++) {
      const q = i * fb + c * bps; let v;
      if (comp === 'fl32' || comp === 'FL32') v = clamp16(Math.round(dv.getFloat32(q, false) * 32767));
      else if (comp === 'sowt') v = bps === 2 ? dv.getInt16(q, true) : bps === 1 ? dv.getInt8(q) << 8 : (ssnd[q + bps - 1] << 24 >> 16) | ssnd[q + bps - 2];
      else if (bps === 1) v = dv.getInt8(q) << 8;
      else v = dv.getInt16(q, false); // 16/24/32 bit big endian: top 16 bits
      chans[c][i] = v;
    }
    const info = {};
    if (inst) {
      info.rootKey = inst.base & 127;
      if (inst.playMode && marks[inst.begin] !== undefined && marks[inst.end] !== undefined && marks[inst.end] > marks[inst.begin])
        info.loop = { start: marks[inst.begin], end: marks[inst.end] - 1 };
    }
    return buildSample(fileName.toLowerCase(), chans, comm.rate, info);
  }

  /** IFF 8SVX (Amiga), like LoadIffMethod of the original */
  function parseIFF(u8, fileName) {
    if (ascii(u8, 0, 4) !== 'FORM' || ascii(u8, 8, 4) !== '8SVX') throw new Error('Unsupported IFF format (only 8SVX).');
    let p = 12, vhdr = null, body = null;
    let name = fileName.replace(/\.iff$/i, '');
    while (p + 8 <= u8.length) {
      const id = ascii(u8, p, 4), len = be32(u8, p + 4), b = p + 8;
      if (id === 'VHDR') {
        vhdr = { oneShot: be32(u8, b), repeat: be32(u8, b + 4), rate: be16(u8, b + 12), octaves: u8[b + 14], comp: u8[b + 15] };
        if (vhdr.octaves !== 1) throw new Error('Number of octaves not supported');
        if (vhdr.comp !== 0) throw new Error('Compression not supported');
      } else if (id === 'BODY') body = u8.subarray(b, Math.min(u8.length, b + len));
      else if (id === 'NAME') name = bytesToName(u8.subarray(b, b + len));
      p = b + len + (len & 1);
    }
    if (!vhdr) throw new Error('Could not find IFF-VHDR information');
    if (!body) throw new Error('Could not find IFF-BODY information');
    const ch = new Int16Array(body.length);
    for (let i = 0; i < body.length; i++) ch[i] = (body[i] << 24 >> 16);
    const info = {};
    if (vhdr.repeat > 0) info.loop = { start: vhdr.oneShot, end: vhdr.oneShot + vhdr.repeat - 1 };
    const s = buildSample(name, [ch], vhdr.rate, info);
    if (!vhdr.repeat) { const h = s.headers[0]; h.sampleEnd = Math.min(h.sampleEnd, Math.max(0, vhdr.oneShot - 1)); h.sampleLoopStart = h.sampleEnd; h.data = h.data.slice(0, (h.sampleEnd + 1) * 2); }
    return s;
  }

  /** decide by contents. Returns {kind:'krz'|'audio', objects?|sample?} */
  function detectKind(u8) {
    const id = ascii(u8, 0, 4);
    if (id === 'PRAM') return 'krz';
    if (id === 'RIFF') return 'wav';
    if (id === 'FORM') { const f = ascii(u8, 8, 4); if (f === 'AIFF' || f === 'AIFC') return 'aiff'; if (f === '8SVX') return 'iff'; }
    return null;
  }
  function parseAudio(u8, fileName) {
    switch (detectKind(u8)) {
      case 'wav': return parseWAV(u8, fileName);
      case 'aiff': return parseAIFF(u8, fileName);
      case 'iff': return parseIFF(u8, fileName);
    }
    throw new Error('Don\'t know how to load "' + fileName + '".');
  }

  // ---------------------------------------------------------------- WAV export
  /** Returns [{name, data}] — one WAV per (mono or stereo) sound, like SaveWaveMethod */
  function exportWAVs(samples, baseName) {
    const out = [];
    let counter = 0;
    for (const s of samples) {
      for (const hi of s.soundIndexes()) {
        const h = s.headers[hi];
        if (!h.data) continue;
        let period = h.samplePeriod || 22675;
        let rate = Math.floor(1000000000 / period);
        if (Math.abs(rate - 44100) < 2) rate = 44100; else if (Math.abs(rate - 22050) < 2) rate = 22050;
        const nch = s.stereo ? 2 : 1;
        const h2 = s.stereo ? s.headers[hi + 1] : null;
        const n = h.data.length >> 1;
        const pcm = new Uint8Array(n * 2 * nch);
        for (let i = 0; i < n; i++) {
          pcm[i * 2 * nch] = h.data[2 * i + 1]; pcm[i * 2 * nch + 1] = h.data[2 * i];
          if (h2) { const d2 = h2.data || new Uint8Array(0); pcm[i * 4 + 2] = d2[2 * i + 1] || 0; pcm[i * 4 + 3] = d2[2 * i] || 0; }
        }
        const looped = h.looped;
        const smplLen = looped ? 60 : 36;
        const total = 12 + 24 + 8 + pcm.length + 8 + smplLen;
        const b = new Uint8Array(total); const dv = new DataView(b.buffer);
        const str = (p, s4) => { for (let i = 0; i < 4; i++) b[p + i] = s4.charCodeAt(i); };
        str(0, 'RIFF'); dv.setUint32(4, total - 8, true); str(8, 'WAVE');
        str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
        dv.setUint32(24, rate, true); dv.setUint32(28, rate * nch * 2, true); dv.setUint16(32, nch * 2, true); dv.setUint16(34, 16, true);
        str(36, 'data'); dv.setUint32(40, pcm.length, true); b.set(pcm, 44);
        let q = 44 + pcm.length;
        str(q, 'smpl'); dv.setUint32(q + 4, smplLen, true);
        dv.setUint32(q + 8 + 8, period, true); dv.setUint32(q + 8 + 12, h.rootkey & 255, true);
        if (looped) {
          dv.setUint32(q + 8 + 28, 1, true);
          dv.setUint32(q + 8 + 36 + 8, h.sampleLoopStart, true); dv.setUint32(q + 8 + 36 + 12, h.sampleEnd, true);
        }
        counter++;
        out.push({ name: (baseName ? baseName + ' ' + counter : s.name.trim() || ('Sample ' + s.id)) + ' ' + noteName(h.rootkey) + '.wav', data: b });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- generators
  /** fill gaps like VeloLevel.fillSpacesBetweenSamples (alternating, one per pass) */
  function fillSpaces(map) {
    const used = (e) => e.ss !== 0;
    let fill;
    do {
      fill = false;
      for (let i = 1; i < map.length; i++) {
        if (!used(map[i]) && used(map[i - 1])) { map[i] = map[i - 1]; i++; fill = true; }
      }
      for (let i = map.length - 2; i >= 0; i--) {
        if (!used(map[i]) && used(map[i + 1])) { map[i] = map[i + 1]; i--; fill = true; }
      }
    } while (fill);
    for (let i = 0; i < map.length; i++) map[i] = Object.assign({}, map[i]);
  }
  function emptyMap(n) { const m = []; for (let i = 0; i < n; i++) m.push({ tuning: 0, vol: 0, sid: 0, ss: 0 }); return m; }

  /** New Instrument: chromatic keymap, each sound at its root key, gaps filled */
  function makeInstrument(samples, keymapName, programName) {
    const kk = new KKeymap(makeHash(200, T_KEYMAP), keymapName || 'chromatic Keymap');
    kk.method = 3; kk.entriesPerVel = 127; kk.centsPerEntry = 100; kk.basePitch = 0;
    const map = emptyMap(128);
    for (const s of samples) {
      for (const hi of s.soundIndexes()) {
        const root = s.headers[hi].rootkey - 12;
        if (root < 0 || root > 127) throw new Error('Root key of "' + s.name + '" is out of range for a keymap.');
        map[root] = { tuning: 100 * (root - root), vol: 0, sid: s.id, ss: hi + 1 };
      }
    }
    fillSpaces(map);
    kk.maps = [map]; kk.velo = [0, 0, 0, 0, 0, 0, 0, 0];
    const kp = makeProgram(makeHash(200, T_PROGRAM), programName || 'Instrument', 200, samples[0].stereo);
    return [kk, kp];
  }
  /** New Drumset: one sound per key starting at C1 (key 24), no transposition */
  function makeDrumset(samples, keymapName, programName) {
    const kk = new KKeymap(makeHash(200, T_KEYMAP), keymapName || 'Drum Keymap');
    kk.method = 0x13; kk.entriesPerVel = 127; kk.centsPerEntry = 100; kk.basePitch = 0;
    const map = emptyMap(128);
    let j = 24;
    for (const s of samples) {
      for (const hi of s.soundIndexes()) {
        if (j > 127) throw new Error('Too many samples for one drum keymap (max. 104).');
        const root = s.headers[hi].rootkey - 12;
        map[j] = { tuning: toShort(100 * (root - j)), vol: 0, sid: s.id, ss: hi + 1 };
        j++;
      }
    }
    kk.maps = [map]; kk.velo = [0, 0, 0, 0, 0, 0, 0, 0];
    const kp = makeProgram(makeHash(200, T_PROGRAM), programName || 'Drumset', 200, samples[0].stereo);
    return [kk, kp];
  }
  /** Velocity split keymap. levels = array of {keymap, index}; choice = 8 indexes into levels */
  function makeVelocitySplit(levels, choice, keymapName, programName) {
    const first = levels[choice[0]].keymap;
    const kk = new KKeymap(makeHash(200, T_KEYMAP), keymapName || 'Velosplit Keymap');
    kk.entriesPerVel = first.entriesPerVel; kk.centsPerEntry = first.centsPerEntry; kk.basePitch = first.basePitch;
    let method = 3;
    const used = []; // level indexes in insertion order
    for (let i = 0; i < 8; i++) {
      const L = levels[choice[i]];
      const k = L.keymap;
      if (k.entriesPerVel !== kk.entriesPerVel || k.centsPerEntry !== kk.centsPerEntry || k.basePitch !== kk.basePitch)
        throw new Error('The chosen keymaps have a different layout (number of entries or pitch spacing) and cannot be combined.');
      method |= k.method;
      let at = used.indexOf(choice[i]);
      if (at < 0) { used.push(choice[i]); at = used.length - 1; }
      kk.velo[i] = at;
    }
    kk.maps = used.map(li => {
      const L = levels[li], k = L.keymap;
      return k.maps[L.index].map(e => {
        const s = k.entrySample(e);
        return { tuning: e.tuning, vol: e.vol, sid: s.sid, ss: s.ss };
      });
    });
    // 1-byte and 2-byte tuning both set -> 2 byte wins, like the original
    kk.method = method;
    const kp = makeProgram(makeHash(200, T_PROGRAM), programName || 'Program', 200, false);
    return [kk, kp];
  }

  /**
   * KCompact: merge all samples of a keymap into one multi-root sample.
   * Returns a Map of replacements {hash -> object|null} to apply, or throws with a reason.
   */
  function compactKeymap(objects, keymapHash) {
    const km = objects.get(keymapHash);
    if (!(km instanceof KKeymap)) throw new Error('Not a keymap.');
    if (!km.compactable) throw new Error('This keymap already uses a single sample.');
    const sampleHashes = km.dependants();
    if (sampleHashes.length === 0) throw new Error('This keymap does not use any sample.');
    if (sampleHashes.length === 1) {
      // one sample only: just drop the per-entry sample numbers (smaller keymap)
      const k = km.clone(); k.raw = null; k.compact();
      if (k.compactable) throw new Error('This keymap cannot be compacted.');
      return new Map([[keymapHash, k]]);
    }
    if (sampleHashes.length > 255) throw new Error('Too many samples (more than 255) to combine into one.');
    const samples = sampleHashes.map(h => objects.get(h));
    if (samples.some(s => !s)) throw new Error('Some samples used by this keymap are missing from the file.');
    if (samples.some(s => s.multiRoot)) throw new Error('This keymap uses MultiRoot samples, which cannot be combined again.');
    const stereo = samples[0].stereo;
    if (samples.some(s => s.stereo !== stereo)) throw new Error('This keymap mixes mono and stereo samples, which cannot be combined.');
    const ns = new KSample(sampleHashes[0], km.name);
    ns.flags = stereo ? 1 : 0;
    const exch = new Map(); // sample id -> subsample number of the new sample
    for (const s of samples) {
      exch.set(s.id, ns.headers.length + 1);
      ns.headers.push(s.headers[0].clone());
      if (stereo) ns.headers.push(s.headers[1].clone());
    }
    const result = new Map();
    for (const h of sampleHashes) result.set(h, null);
    result.set(ns.hash, ns);
    // every keymap that uses one of these samples gets updated
    for (const [h, o] of objects) {
      if (!(o instanceof KKeymap)) continue;
      const deps = o.dependants();
      if (!deps.some(d => exch.has(hashID(d)))) continue;
      const k = o.clone(); k.raw = null;
      k.makeCompactable();
      for (const es of k.maps) for (const e of es) {
        const ss = (k.method & 1) ? e.ss : 1;
        if (ss === 1 && exch.has(e.sid)) { e.ss = exch.get(e.sid); e.sid = ns.id; }
      }
      k.compact();
      result.set(h, k);
    }
    return result;
  }

  return {
    T_PROGRAM, T_KEYMAP, T_SAMPLE, T_SETUP, T_STUDIO, TYPE_NAMES, LEVEL_NAMES, FORMATS, FILL,
    hashType, hashID, makeHash, typeName, noteName, parseNote, cleanName,
    KObject, KDefault, KProgram, KKeymap, KSample, SoundHeader,
    parseKRZ, writeKRZ, importObjects, remapIDs,
    directDependants, dependantsRecursive, users,
    parseWAV, parseAIFF, parseIFF, parseAudio, detectKind, exportWAVs,
    makeInstrument, makeDrumset, makeVelocitySplit, compactKeymap, makeProgram
  };
});
