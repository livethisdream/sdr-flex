// A live radio session (the synthetic driver: a real process writing a real ring), stereo tab
// drawing: frame jitter, then retunes of the channel while live.
import { chromium } from 'playwright';
const b = await chromium.launch(); const page = await (await b.newContext({ viewport: { width: 880, height: 960 } })).newPage();
page.setDefaultTimeout(180000);
await page.goto(`http://127.0.0.1:${process.env.PORT || 8722}/index.html`);
await page.waitForFunction(() => window.sdrflex && window.sdrflex.engine && window.sdrflex.engine.root, null, { timeout: 60000 });
const info = await page.evaluate(async () => {
  const a = window.sdrflex, e = a.engine;
  window._arr = []; const call = e.call.bind(e);
  e.call = (op, args) => { const p = call(op, args); if (op === 'frames' && args.reqs.some((r) => r.live)) p.then(() => window._arr.push(performance.now())); return p; };
  await e.openRadio('synthetic', { sampleRate: 480_000, centerHz: 433_920_000 });
  a.afterOpen && a.afterOpen();
  await new Promise((r) => setTimeout(r, 3000));          // let the ring fill a little
  a.current = e.root.id; a.channel = e.root.id;
  const cz = e.root.out.centerHz;
  await a.applyOp('core.tuner', { f0: cz + 40e3, f1: cz + 220e3 });   // the scene's WBFM
  const tuner = a.current;
  await a.applyOp('core.fm_discriminator');
  await a.applyOp('core.stereo');
  window._tuner = tuner;
  return { behind: (e.span()[1] - e.t).toFixed(2), playing: e.playing };
});
await page.waitForTimeout(3000);
await page.evaluate(() => { window._arr = []; });
await page.waitForTimeout(10000);
const t = await page.evaluate(() => window._arr);
const iv = t.slice(1).map((v, i) => v - t[i]).sort((x, y) => x - y), q = (p) => iv[Math.min(iv.length - 1, Math.floor(iv.length * p))];
const mean = iv.reduce((s, v) => s + v, 0) / iv.length, sd = Math.sqrt(iv.reduce((s, v) => s + (v - mean) ** 2, 0) / iv.length);
console.log(`live, ${info.behind} s behind the newest sample: ${(iv.length / 10).toFixed(1)} frames/s, median ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)}, p99 ${q(0.99).toFixed(1)}; jitter (sd) ${sd.toFixed(1)} ms`);
const knob = await page.evaluate(async () => {
  const e = window.sdrflex.engine, tuner = window._tuner, base = e.node(tuner).params.centerHz.value, out = [];
  for (let k = 0; k < 6; k++) {
    const to = base + (k % 2 === 0 ? 10_000 : 0), t0 = performance.now();
    await e.setParam(tuner, 'centerHz', to, 'manual');
    let first = e.frame(tuner, { bins: 1024 });
    for (;;) { await new Promise((r) => setTimeout(r, 2)); const f = e.frame(tuner, { bins: 1024 }); if (f && f.kind === 'spectrum' && f !== first) { out.push(Math.round(performance.now() - t0)); break; } if (performance.now() - t0 > 5000) { out.push(NaN); break; } }
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
});
console.log(`retune a channel while live, to a new frame (ms): ${knob.join(' ')}`);
await b.close();
