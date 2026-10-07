// The synthetic scene, recorded once so GNU Radio can read it (ADR-0044).
//
// With nothing open, a session shows the scene `web/src/scene.js` computes from absolute
// sample index. GNU Radio reads files, and computing the scene in JS costs about a quarter of
// a second of the server's thread per second of signal, which a waterfall's prefill multiplies
// by its rows. So the server writes the first SCENE_S seconds to disk, once, on a thread of its
// own, and the GNU Radio engine reads that file the way it reads any capture. Past its end the
// JS scene answers, as it always did; the samples are the same ones either way.
//
// The file is named for the scene's source, so an edit to the scene records it afresh rather
// than serving the old one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker, isMainThread, workerData } from 'node:worker_threads';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCENE_JS = path.join(HERE, '../../web/src/scene.js');
const SCENE_S = 60;
const CHUNK = 1 << 16;

const recordings = new Map();   // dir → { path, durationS, ready }

/**
 * The recording in `dir`: ready at once if an earlier run left it there, otherwise started in
 * the background and `ready` once written. Callers read `ready` each time rather than waiting.
 */
export function sceneRecording(dir, { seconds = SCENE_S, log = () => {} } = {}) {
  const key = `${dir}|${seconds}`;
  if (recordings.has(key)) return recordings.get(key);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(SCENE_JS)).digest('hex').slice(0, 12);
  const file = path.join(dir, `scene-${hash}-${seconds}s.cf32`);
  const rec = { path: file, durationS: seconds, ready: false };
  recordings.set(key, rec);
  import('../../web/src/scene.js').then(({ SOURCE }) => {
    const bytes = Math.round(seconds * SOURCE.sampleRate) * 8;
    if (fs.existsSync(file) && fs.statSync(file).size === bytes) { rec.ready = true; return; }
    const started = performance.now();
    const w = new Worker(new URL(import.meta.url), { workerData: { file, seconds } });
    w.on('exit', (code) => {
      if (code === 0 && fs.existsSync(file) && fs.statSync(file).size === bytes) {
        rec.ready = true;
        log(`synthetic scene recorded for GNU Radio: ${seconds} s in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      } else {
        log(`synthetic scene was not recorded (exit ${code}); it stays in JS`);
      }
    });
    w.on('error', (err) => log(`synthetic scene was not recorded: ${err.message}`));
  });
  return rec;
}

async function record({ file, seconds }) {
  const scene = await import('../../web/src/scene.js');
  const total = Math.round(seconds * scene.SOURCE.sampleRate);
  // Written beside its final name and moved into place, so a half-written file is never read.
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    for (let k = 0; k < total; k += CHUNK) {
      const iq = scene.read(k, Math.min(CHUNK, total - k));
      fs.writeSync(fd, new Uint8Array(iq.buffer, iq.byteOffset, iq.byteLength));
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

if (!isMainThread && workerData && workerData.file) await record(workerData);
