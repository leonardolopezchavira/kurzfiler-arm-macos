const fs = require('fs'), K = require('../app/krz-core.js'), { execFileSync } = require('child_process');
const path = require('path');
const A = path.join(__dirname, '.work', 'audio') + '/', JAVA = process.env.JAVA || 'java';
const T = path.join(process.env.KF_ORIG || path.join(__dirname, '.work', 'kurzfiler'), 'tests') + '/';
const CP = (process.env.KF_JAR || path.join(__dirname, '.work', 'KurzFiler.jar')) + ':' + path.join(__dirname, '.work', 'classes');
const rd = p => new Uint8Array(fs.readFileSync(p));
let fail = 0;
function eq(name, a, b) { const ok = a.length === b.length && a.every((x, i) => x === b[i]); console.log((ok ? '  ok   ' : '  FAIL ') + name); if (!ok) fail++; }
function viaCore(f) { const o = new Map(); K.importObjects(o, [K.parseAudio(rd(A + f), f)], 'fill', 200); return o; }
for (const f of ['stereo16.wav', 'mono8.wav', 'mono16_22k.wav']) {
  execFileSync(JAVA, ['-Djava.awt.headless=true', '-cp', CP, 'Ref', 'wavimport', A + f, A + f + '.ref.krz'], { env: {} });
  eq(f + ' identical to original import', K.writeKRZ(viaCore(f), 'raw'), rd(A + f + '.ref.krz'));
}
const pcm = o => [...o.values()][0].headers.map(h => Buffer.from(h.data).toString('hex')).join();
const s16 = pcm(viaCore('stereo16.wav'));
eq('24-bit stereo gives the same audio as 16-bit', [pcm(viaCore('stereo24.wav')) === s16], [true]);
const fl = [...viaCore('stereofloat.wav').values()][0].headers[0].toFloat(), ref = [...viaCore('stereo16.wav').values()][0].headers[0].toFloat();
eq('float stereo within 1 LSB of 16-bit', [fl.every((v, i) => Math.abs(v - ref[i]) <= 1.5 / 32768)], [true]);
const ai = [...viaCore('stereo.aiff').values()][0];
eq('AIFF stereo audio same as WAV', [ai.headers.map(h => Buffer.from(h.data.slice(0, 2000 * 2)).toString('hex')).join() === [...viaCore('stereo16.wav').values()][0].headers.map(h => Buffer.from(h.data.slice(0, 2000 * 2)).toString('hex')).join()], [true]);
eq('AIFF root key G4 (67) + loop 1000..2499', [ai.headers[0].rootkey, ai.headers[0].sampleLoopStart, ai.headers[0].sampleEnd, ai.stereo], [67, 1000, 2499, true]);
const bad = K.parseKRZ(rd(T + 'bug061029/kurz1.krz'));
console.log('  kurz1.krz warnings: ' + bad.warnings.join(' | '));
eq('kurz1.krz (bad sample rate) repaired like "kurz1 fixed.krz"', K.writeKRZ(bad.objects, 'raw'), K.writeKRZ(K.parseKRZ(rd(T + 'bug061029/kurz1 fixed.krz')).objects, 'raw'));
// export -> import round trip of a stereo sample
const st = [...viaCore('stereo16.wav').values()][0];
const w = K.exportWAVs([st], 'x')[0];
const back = K.parseWAV(w.data, 'x.wav');
eq('stereo WAV export/import round trip', [back.headers.map(h => Buffer.from(h.data).toString('hex')).join()], [s16]);
console.log(fail ? fail + ' failed' : 'all audio tests passed');
