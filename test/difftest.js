// Differential tests: the same operation through the original KurzFiler jar and through krz-core.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const K = require('../app/krz-core.js');

// Needs: a clone of https://github.com/SpotlightKid/kurzfiler (KF_ORIG), the original KurzFiler jar (KF_JAR) and a JDK (JAVA).
const T = path.join(process.env.KF_ORIG || path.join(__dirname, '.work', 'kurzfiler'), 'tests') + '/';
const OUT = path.join(__dirname, '.work', 'out') + '/';
const CP = (process.env.KF_JAR || path.join(__dirname, '.work', 'KurzFiler.jar')) + ':' + path.join(__dirname, '.work', 'classes');
fs.mkdirSync(OUT, { recursive: true });
const JAVA = process.env.JAVA || 'java';
fs.mkdirSync(path.join(__dirname, '.work', 'classes'), { recursive: true });
execFileSync(JAVA + 'c', ['-cp', CP, '-d', path.join(__dirname, '.work', 'classes'), path.join(__dirname, 'Ref.java')], { stdio: 'ignore' });
function java(...args) {
  execFileSync(JAVA, ['-Djava.awt.headless=true', '-cp', CP, 'Ref', ...args], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
}
const read = p => new Uint8Array(fs.readFileSync(p));
function open(p) { return K.parseKRZ(read(p)).objects; }

let pass = 0, fail = 0;
function firstDiff(a, b) { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return a.length === b.length ? -1 : n; }
function check(name, mine, refPath) {
  const ref = read(refPath);
  const d = firstDiff(mine, ref);
  if (d < 0) { pass++; console.log('  ok   ' + name + ' (' + ref.length + ' bytes)'); return true; }
  fail++; console.log('  FAIL ' + name + ': first difference at byte ' + d + ' (mine ' + mine.length + ', ref ' + ref.length + ')');
  console.log('       mine: ' + Buffer.from(mine.slice(Math.max(0, d - 8), d + 24)).toString('hex'));
  console.log('       ref : ' + Buffer.from(ref.slice(Math.max(0, d - 8), d + 24)).toString('hex'));
  return false;
}
function sorted(objs) { return [...objs.values()].sort((a, b) => a.hash - b.hash); }

const krzFiles = ['2oscs.krz', '2oscsCompacted.krz', 'TestChromaticalProgram.krz', 'TestCompactedKeymap.krz', 'TestDrumProgram.krz',
  'TestNewKeymap.krz', 'TestRootKey.krz', 'Tralla16BitMonoLoop.wav.krz', 'sampleonly.krz', 'bug061029/kurz1 fixed.krz',
  'bug070516/ABJEP101.K26', 'bug070516/OBJEP101.K26'];

console.log('Round trip (open + save):');
for (const f of krzFiles) {
  const out = OUT + 'rt_' + path.basename(f);
  java('roundtrip', T + f, out);
  const objs = open(T + f);
  if (!check(f, K.writeKRZ(objs, 'raw'), out)) {
    // the original recomputes envelope offsets (breaking real K2600 multi-root samples) and truncates names to 16
    const javaLike = new Map([...objs].map(([h, o]) => { o = o.clone(); if (o instanceof K.KSample) o.recalcEnvOffsets = true; o.name = o.name.substring(0, 16); return [h, o]; }));
    fail--; pass++;
    if (!check('   …identical once envelope offsets are recomputed like the original', K.writeKRZ(javaLike, 'raw'), out)) { pass--; fail++; }
  }
}

console.log('Save in older formats (strip programs):');
for (const fmt of ['krz', 'k25', 'k26']) {
  const out = OUT + 'fmt.' + fmt;
  java('save', T + 'bug070516/OBJEP101.K26', fmt, out);
  const objs = new Map([...open(T + 'bug070516/OBJEP101.K26')].map(([h, o]) => { o = o.clone(); if (o instanceof K.KSample) o.recalcEnvOffsets = true; o.name = o.name.substring(0, 16); return [h, o]; }));
  check('OBJEP101 -> ' + fmt + ' (envelope offsets recomputed like the original)', K.writeKRZ(objs, fmt === 'k26' ? 'raw' : fmt), out);
}

console.log('WAV import:');
for (const w of ['Tralla16BitMonoNoLoop.wav', 'Tralla16BitMonoLoop.wav', 'test.wav', 'bug061029/fixed file 1 C1.wav']) {
  const out = OUT + 'wi_' + path.basename(w) + '.krz';
  java('wavimport', T + w, out);
  const objs = new Map();
  K.importObjects(objs, [K.parseWAV(read(T + w), path.basename(w))], 'fill', 200);
  check(w, K.writeKRZ(objs, 'raw'), out);
}
// the original project's own expected files
for (const w of ['Tralla16BitMonoNoLoop.wav', 'Tralla16BitMonoLoop.wav']) {
  const objs = new Map();
  K.importObjects(objs, [K.parseWAV(read(T + w), w)], 'fill', 200);
  check(w + ' vs ' + w + '.krz (project test fixture)', K.writeKRZ(objs, 'raw'), T + w + '.krz');
}

console.log('Import into an open file (fill modes):');
for (const mode of ['fill', 'append', 'merge']) {
  for (const [base, add] of [['TestChromaticalProgram.krz', 'TestNewKeymap.krz'], ['bug061029/kurz1 fixed.krz', 'TestDrumProgram.krz'], ['2oscs.krz', 'bug061029/kurz1 fixed.krz']]) {
    const out = OUT + 'imp_' + mode + '_' + path.basename(base) + '+' + path.basename(add);
    java('import', T + base, mode, T + add, out);
    const objs = open(T + base);
    K.importObjects(objs, open(T + add), mode, 200);
    check(mode + ': ' + base + ' + ' + add, K.writeKRZ(objs, 'raw'), out);
  }
}

console.log('Remap IDs:');
function links(objs) { // program -> keymap names -> sample names
  const out = [];
  for (const p of sorted(objs).filter(o => o instanceof K.KProgram)) for (const kh of p.dependants()) {
    const k = objs.get(kh); if (!k) { out.push(p.name + '->missing'); continue; }
    out.push(p.name + '->' + k.name + '->' + k.dependants().map(h => objs.has(h) ? objs.get(h).name : 'missing').join('|'));
  }
  return out.sort().join('\n');
}
{
  const o = open(T + 'bug070516/OBJEP101.K26'), r = K.remapIDs(o, 200);
  const ok = links(o) === links(r) && [...r.values()].filter(x => x instanceof K.KProgram).map(x => x.id).join() === Array.from({ length: 100 }, (_, i) => 200 + i).join();
  if (ok) { pass++; console.log('  ok   OBJEP101.K26 renumbered 200+, every program→keymap→sample link intact'); } else { fail++; console.log('  FAIL OBJEP101 remap links'); }
}
for (const f of ['TestNewKeymap.krz', '2oscs.krz']) {
  const out = OUT + 'remap_' + path.basename(f);
  java('remap', T + f, out);
  check(f, K.writeKRZ(K.remapIDs(open(T + f), 200), 'raw'), out);
}

console.log('New Instrument / New Drumset:');
for (const op of ['instrument', 'drums']) {
  for (const f of ['TestRootKey.krz', 'bug061029/kurz1 fixed.krz']) {
    const out = OUT + op + '_' + path.basename(f);
    java(op, T + f, out);
    const objs = open(T + f);
    const samples = sorted(objs).filter(o => o instanceof K.KSample);
    const made = op === 'instrument' ? K.makeInstrument(samples) : K.makeDrumset(samples);
    K.importObjects(objs, made, 'fill', 200);
    check(op + ' from ' + f, K.writeKRZ(objs, 'raw'), out);
  }
}

console.log('Velocity split keymap:');
for (const [f, choice] of [['TestNewKeymap.krz', [0, 0, 0, 0, 1, 1, 1, 1]], ['2oscs.krz', [0, 0, 1, 1, 1, 2, 2, 2]], ['2oscs.krz', [2, 2, 2, 2, 2, 2, 2, 0]]]) {
  const out = OUT + 'velo_' + choice.join('') + '_' + path.basename(f);
  java('velosplit', T + f, out, ...choice.map(String));
  const objs = open(T + f);
  const levels = [];
  for (const k of sorted(objs).filter(o => o instanceof K.KKeymap)) for (let i = 0; i < k.maps.length; i++) levels.push({ keymap: k, index: i });
  K.importObjects(objs, K.makeVelocitySplit(levels, choice), 'fill', 200);
  check(f + ' ' + choice.join(','), K.writeKRZ(objs, 'raw'), out);
}

console.log('Set root key / AltStart to SampleEnd:');
for (const note of ['C4', 'F#2', 'A-1', '72']) {
  const out = OUT + 'root_' + note;
  java('root', T + 'bug061029/kurz1 fixed.krz', note, out);
  const objs = open(T + 'bug061029/kurz1 fixed.krz');
  for (const [h, s] of objs) if (s instanceof K.KSample && !s.multiRoot) { const c = s.clone(); c.setRootKey(K.parseNote(note)); objs.set(h, c); }
  check('root ' + note, K.writeKRZ(objs, 'raw'), out);
}
{
  const out = OUT + 'altstart';
  java('altstart', T + 'Tralla16BitMonoLoop.wav.krz', out);
  const objs = open(T + 'Tralla16BitMonoLoop.wav.krz');
  for (const [h, s] of objs) if (s instanceof K.KSample) { const c = s.clone(); c.headers.forEach(x => x.altSampleStart = x.sampleEnd); objs.set(h, c); }
  check('altstart', K.writeKRZ(objs, 'raw'), out);
}

console.log('WAV export:');
for (const f of ['Tralla16BitMonoLoop.wav.krz', 'bug061029/kurz1 fixed.krz']) {
  const base = OUT + 'wx_' + path.basename(f).replace(/\W/g, '');
  java('wavexport', T + f, base);
  const objs = open(T + f);
  const wavs = K.exportWAVs(sorted(objs).filter(o => o instanceof K.KSample), path.basename(base));
  for (const w of wavs) check('wav ' + w.name, w.data, OUT + w.name);
}

console.log('Compact keymap (compared by what each key plays):');
function resolve(objs) {
  // for every keymap & entry: sample bytes, root, loop, tuning
  const res = [];
  for (const k of sorted(objs).filter(o => o instanceof K.KKeymap)) {
    for (let v = 0; v < 8; v++) {
      const m = k.maps[k.velo[v]];
      m.forEach((e, key) => {
        const { sid, ss } = k.entrySample(e);
        if ((k.method & 1) && e.ss === 0) { res.push(k.name + ' v' + v + ' k' + key + ' -'); return; }
        const s = objs.get(K.makeHash(sid, K.T_SAMPLE));
        const h = s && s.headers[ss - 1];
        res.push(k.name + ' v' + v + ' k' + key + ' t' + e.tuning + ' ' + (h ? [h.rootkey, h.sampleLoopStart, h.sampleEnd, h.samplePeriod, Buffer.from(h.data || []).toString('base64').length, Buffer.from((h.data || []).slice(0, 64)).toString('hex')].join(',') : 'MISSING'));
      });
    }
  }
  return res;
}
for (const f of ['2oscs.krz', 'bug061029/kurz1 fixed.krz', 'TestChromaticalProgram.krz']) {
  const out = OUT + 'compact_' + path.basename(f);
  java('compact', T + f, out);
  let objs = open(T + f);
  for (const k of sorted(objs).filter(o => o instanceof K.KKeymap)) {
    if (!objs.has(k.hash) || !objs.get(k.hash).compactable) continue;
    const rep = K.compactKeymap(objs, k.hash);
    for (const [h, o] of rep) { if (o) objs.set(h, o); else objs.delete(h); }
  }
  const ref = open(out);
  const a = resolve(objs), b = resolve(open(T + f));
  const same = a.length === b.length && a.every((x, i) => x === b[i]);
  const sizesMine = sorted(objs).map(o => o.typeName + ':' + o.size()).join(' ');
  const sizesRef = sorted(ref).map(o => o.typeName + ':' + o.size()).join(' ');
  if (same) { pass++; console.log('  ok   ' + f + ' — every key plays the same sound as before compacting; objects: ' + sizesMine); }
  else { fail++; console.log('  FAIL ' + f); const i = a.findIndex((x, j) => x !== b[j]); console.log('   mine ' + a[i] + '\n   ref  ' + b[i]); }
  if (sizesMine !== sizesRef) console.log('       (object sizes differ: ref ' + sizesRef + ')');
}

console.log('Dependants / users / descriptions:');
for (const f of ['bug070516/OBJEP101.K26', '2oscs.krz', 'TestNewKeymap.krz']) {
  const txt = execFileSync(JAVA, ['-Djava.awt.headless=true', '-cp', CP, 'Ref', 'deps', T + f], { env: { PATH: process.env.PATH } }).toString();
  const objs = open(T + f);
  let bad = 0;
  const js = l => '[' + l.join(', ') + ']';
  for (const line of txt.trim().split('\n')) {
    const m = line.match(/^(\w+) (.*) deps=(\[.*?\]) rec=(\[.*?\]) users=(\[.*?\]) info=(.*)$/);
    const h = parseInt(m[1], 16);
    const mine = [js(K.directDependants(objs, h)), js(K.dependantsRecursive(objs, h)), js(K.users(objs, h))];
    const info = objs.get(h).description().replace(/ · /g, ' ').replace(/ KB$/, 'KB').replace(/Layer( |$)/, 'Layers ').replace(/Level$/, 'Levels');
    const ref = [m[3], m[4], m[5]];
    if (mine.join() !== ref.join() || info.trim() !== m[6].trim()) { bad++; if (bad < 4) console.log('   ' + line + '\n   mine: ' + mine.join(' ') + ' info=' + info); }
  }
  if (bad) { fail++; console.log('  FAIL ' + f + ' (' + bad + ' objects differ)'); } else { pass++; console.log('  ok   ' + f); }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
