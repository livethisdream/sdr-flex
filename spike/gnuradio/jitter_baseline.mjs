// Frame delivery jitter from today's Node server, as the browser receives it.
import { chromium } from 'playwright';
const b = await chromium.launch(); const page = await (await b.newContext({ viewport: { width: 880, height: 960 } })).newPage();
page.setDefaultTimeout(120000);
await page.goto('http://127.0.0.1:8722/index.html');
await page.waitForFunction(() => window.sdrflex && window.sdrflex.engine && window.sdrflex.engine.root, null, { timeout: 60000 });
await page.evaluate(async () => {
  const a = window.sdrflex, e = a.engine;
  // Record when each batch of frames arrives back from the server.
  window._arr = []; const call = e.call.bind(e);
  e.call = (op, args) => { const p = call(op, args); if (op === 'frames') p.then(() => window._arr.push(performance.now())); return p; };
  const cap = (await e.listCaptures()).find((c) => c.id.startsWith('ctf-sigid-sigid')); await e.openCapture(cap.id); a.afterOpen && a.afterOpen(cap);
  await new Promise((r) => setTimeout(r, 800));
  const cz = a.node().out.centerHz;
  await a.applyOp('core.tuner', { f0: cz - 240e3, f1: cz - 40e3 });
  await a.applyOp('core.fm_discriminator');
  await a.applyOp('core.stereo');
});
for (const [label, setup] of [['stereo tab (both)', null], ['source spectrum', 'root']]) {
  if (setup === 'root') await page.evaluate(() => { const a = window.sdrflex; a.goChannel(a.engine.root.id); a.refresh(); });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window._arr = []; });
  await page.waitForTimeout(10000);
  const t = await page.evaluate(() => window._arr);
  const iv = t.slice(1).map((v, i) => v - t[i]).sort((x, y) => x - y);
  const q = (p) => iv[Math.min(iv.length - 1, Math.floor(iv.length * p))];
  const mean = iv.reduce((s, v) => s + v, 0) / iv.length;
  const sd = Math.sqrt(iv.reduce((s, v) => s + (v - mean) ** 2, 0) / iv.length);
  console.log(`${label.padEnd(18)} ${iv.length + 1} frame batches in 10 s (${(iv.length / 10).toFixed(1)}/s): interval median ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)}, p99 ${q(0.99).toFixed(1)}, max ${iv[iv.length - 1].toFixed(1)}; jitter (sd) ${sd.toFixed(1)} ms`);
}
await b.close();
