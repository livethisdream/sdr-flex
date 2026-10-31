// Listen's de-emphasis: on after broadcast FM, off after anything else, and the reason
// said either way (ADR-0017).

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/engine.js';
import * as scene from '../src/scene.js';

async function listenAfter(offsetHz, widthHz) {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  const c = e.root.out.centerHz + offsetHz;
  const sel = { f0: c - widthHz / 2, f1: c + widthHz / 2 };
  const t = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: sel, at: 0.5 });
  const d = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 0.5 });
  return e.addNode({ parent: d.id, op: 'core.audio', at: 0.5 });
}

test('Listen de-emphasizes wideband FM at 75 µs, and says why', async () => {
  const l = await listenAfter(scene.WFM_INFO.offsetHz, 200_000);
  assert.equal(l.params.deemphasisUs.value, '75');
  assert.equal(l.params.deemphasisUs.mode, 'auto');
  assert.match(l.params.deemphasisUs.auto.from, /wideband FM/);
});

test('Listen leaves narrowband FM alone', async () => {
  const l = await listenAfter(-140_000, 16_000);
  assert.equal(l.params.deemphasisUs.value, '0');
  assert.match(l.params.deemphasisUs.auto.from, /narrowband FM/);
});
