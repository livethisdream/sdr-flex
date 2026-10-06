import { chromium } from 'playwright';
const b = await chromium.launch(); const page = await (await b.newContext()).newPage(); page.setDefaultTimeout(600000);
await page.goto(`http://127.0.0.1:${process.env.PORT || 8722}/index.html`);
await page.waitForFunction(() => window.sdrflex && window.sdrflex.engine && window.sdrflex.engine.root, null, { timeout: 60000 });
const out = await page.evaluate(async () => {
  const e = window.sdrflex.engine;
  const cap = (await e.listCaptures()).find((c) => c.id.startsWith('ctf-sigid-sigid')); await e.openCapture(cap.id);
  const cz = e.root.out.centerHz;
  const t = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: cz - 240e3, f1: cz - 40e3 }, at: 10 });
  const fm = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 10 });
  const rd = await e.addNode({ parent: fm.id, op: 'ext.redsea', at: 10 });
  const t0 = performance.now(); const r = await e.runRecordsSpan(rd.id, 5, 35);
  return { ms: Math.round(performance.now() - t0), n: (r.records || []).length, err: r.error, text: [...new Set((r.records || []).map((x) => x.text))].slice(0, 6) };
});
console.log(JSON.stringify(out)); await b.close();
