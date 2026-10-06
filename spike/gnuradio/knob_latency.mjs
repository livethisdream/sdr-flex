// Knob to visible: retune a tuner on sigid while the stereo tab is drawing, and time how long
// until a frame for that tuner reflects the new center. Engine-side, as the browser sees it.
import { chromium } from 'playwright';
const b = await chromium.launch(); const page = await (await b.newContext({ viewport: { width: 880, height: 960 } })).newPage();
page.setDefaultTimeout(180000);
await page.goto(`http://127.0.0.1:${process.env.PORT || 8722}/index.html`);
await page.waitForFunction(() => window.sdrflex && window.sdrflex.engine && window.sdrflex.engine.root, null, { timeout: 60000 });
const out = await page.evaluate(async () => {
  const a = window.sdrflex, e = a.engine;
  const cap = (await e.listCaptures()).find((c) => c.id.startsWith('ctf-sigid-sigid')); await e.openCapture(cap.id); a.afterOpen && a.afterOpen(cap);
  await new Promise((r) => setTimeout(r, 800));
  const cz = a.node().out.centerHz;
  await a.applyOp('core.tuner', { f0: cz - 260e3, f1: cz - 20e3 });
  const tuner = a.current;
  await a.applyOp('core.fm_discriminator');
  await a.applyOp('core.stereo');
  await new Promise((r) => setTimeout(r, 3000));
  const times = [];
  const base = e.node(tuner).params.centerHz.value;
  for (let k = 0; k < 8; k++) {
    const to = base + (k % 2 === 0 ? 20_000 : 0);
    const t0 = performance.now();
    await e.setParam(tuner, 'centerHz', to, 'manual');
    window._set = (window._set || []).concat(Math.round(performance.now() - t0));
    // Ask for the tuner's spectrum until a frame computed after the change arrives.
    for (;;) {
      const f = e.frame(tuner, { bins: 1024 });
      if (f && f.kind === 'spectrum' && e.node(tuner).params.centerHz.value === to && f.centerHz === e.node(tuner).out.centerHz && f._after !== false) {
        await new Promise((r) => setTimeout(r, 0));
        const g = e.frame(tuner, { bins: 1024 });
        if (g && g.kind === 'spectrum' && g !== f) { times.push(performance.now() - t0); break; }
      }
      await new Promise((r) => setTimeout(r, 2));
      if (performance.now() - t0 > 5000) { times.push(NaN); break; }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { total: times.map((v) => Math.round(v)), setParam: window._set };
});
console.log('setParam alone (ms):', out.setParam.join(' ')); console.log('to a new frame (ms):  ', out.total.join(' '));
await b.close();
