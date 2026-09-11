// The Identify panel.
//
// It opens under the button, lists every decoder that is about to be tried before any
// of them has answered, and fills each row in as its result lands. Three things about
// that are deliberate.
//
// **The plan is drawn first.** The engine sends results one at a time, so the naive
// panel is an empty box that grows — which reads as "nothing found" for the first
// second and gives no sense of how long there is to wait. Because `identify.js` is
// shared and the client already has the adapter list, the panel can work out what is
// about to happen and show it, greyed, immediately.
//
// **What was not tried is shown too.** Below a rule, dimmed, with the reason in plain
// words. A decoder that is not installed and a decoder that wants bandwidth the capture
// never had are both absent from the results, and they are absent for very different
// reasons — an empty list cannot say which.
//
// **A row is a chain, not a decoder.** "direwolf behind an FM demod" is two nodes, and
// picking the row builds both. The report has to be reproducible by clicking it or it
// is a claim rather than an answer (ADR-0017: the evidence travels with the value).

const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

export class IdentifyPanel {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'ident';
    this.el.hidden = true;
    root.appendChild(this.el);
    this.onPick = null;
    this.rows = [];
    addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target)) this.close();
    });
    addEventListener('keydown', (e) => {
      if (!this.el.hidden && e.key === 'Escape') { this.close(); e.preventDefault(); }
    });
  }

  /**
   * @param {{x:number, y:number}} at           where the button is
   * @param {{tried:Array, skipped:Array}} plan what is about to be run
   * @param {{windowS:number, kind:string, sampleRate:number}} about the stream
   */
  open(at, plan, about, onPick) {
    this.onPick = onPick;
    this.about = about;
    this.skipped = plan.skipped;
    this.done = false;
    this.error = null;
    // One row per candidate, keyed the way a result identifies itself.
    this.rows = plan.tried.map((c) => ({ ...c, key: key(c), state: 'waiting' }));
    this.el.hidden = false;
    this._render();
    this._place(at);
  }

  /** A result landed. */
  result(row) {
    const r = this.rows.find((x) => x.key === key(row));
    if (!r) return;
    Object.assign(r, row, { state: 'done' });
    this._sort();
    this._render();
  }

  /** No more are coming. */
  finish(report) {
    this.done = true;
    if (report && report.error) this.error = report.error;
    for (const r of this.rows) if (r.state === 'waiting') r.state = 'done';
    this._sort();
    this._render();
  }

  close() { this.el.hidden = true; }
  get isOpen() { return !this.el.hidden; }

  /** Solid first, thin next, silent last — the same order the engine's report uses. */
  _sort() {
    const tier = (r) => (r.records > 0 && !r.thin ? 0 : r.records > 0 ? 1 : 2);
    this.rows.sort((a, b) => tier(a) - tier(b) || (b.records || 0) - (a.records || 0) ||
                             a.name.localeCompare(b.name) ||
                             String(a.viaLabel).localeCompare(String(b.viaLabel)));
  }

  _place({ x, y }) {
    const r = this.el.getBoundingClientRect();
    const pad = 8;
    this.el.style.left = Math.max(pad, Math.min(x, innerWidth - r.width - pad)) + 'px';
    this.el.style.top = Math.max(pad, Math.min(y, innerHeight - r.height - pad)) + 'px';
  }

  _render() {
    const a = this.about || {};
    const answered = this.rows.filter((r) => r.state === 'done').length;
    const found = this.rows.filter((r) => r.records > 0 && !r.thin).length;

    const head =
      `<div class="idhead"><b>Identify</b>` +
      `<span>${fmtSeconds(a.windowS)} of ${a.kind === 'iq' ? 'spectrum' : 'audio'} · ` +
      `${this.rows.length} decoder${this.rows.length === 1 ? '' : 's'}` +
      `${this.done ? '' : ` · ${answered} done`}</span></div>`;

    const body = this.rows.length
      ? `<ol class="idlist">${this.rows.map((r) => this._row(r)).join('')}</ol>`
      : `<div class="idnone">${esc(this.error || 'no decoder on this engine can read this stream')}</div>`;

    // The summary line is the answer to the question that was asked, so it is stated
    // rather than left to be counted off the list.
    const verdict = !this.done ? ''
      : found ? `<div class="idsum">${found} decoder${found === 1 ? '' : 's'} read something here.</div>`
      : `<div class="idsum idnil">Nothing recognized it. ${this.rows.length} decoder` +
        `${this.rows.length === 1 ? '' : 's'} tried; the chain is still yours to build.</div>`;

    const skipped = (this.skipped || []).length
      ? `<div class="idskip"><div class="idskiph">not tried</div>${
          this.skipped.map((s) => `<div class="idskr"><b>${esc(s.name)}</b> ${esc(s.why)}</div>`).join('')}</div>`
      : '';

    this.el.innerHTML = head + body + verdict + skipped;

    for (const b of this.el.querySelectorAll('.idr[data-key]')) {
      b.addEventListener('click', () => {
        const r = this.rows.find((x) => x.key === b.dataset.key);
        if (!r) return;
        this.close();
        this.onPick && this.onPick(r);
      });
    }
  }

  _row(r) {
    const waiting = r.state !== 'done';
    // A thin result is shown and can be opened, but it is not the answer: it does not
    // get the accent, and it does not get counted.
    const hit = r.records > 0 && !r.thin;
    const any = r.records > 0;
    const via = r.viaLabel ? `<span class="idvia">via ${esc(r.viaLabel)}</span>` : '';
    const count = waiting ? '<span class="idwait">running…</span>'
      : `<span class="idn${hit ? ' hit' : ''}">${r.records} record${r.records === 1 ? '' : 's'}</span>`;
    // One line of what it said. Enough to recognize the answer; the decoder's own pane
    // is one click away and has all of it.
    const say = any ? `<div class="idsay${hit ? '' : ' thin'}">${esc(r.sample[0])}</div>` : '';
    const thin = r.thin
      ? '<div class="idtold">too little to be a message — more likely something found in noise</div>' : '';
    // A decoder that found nothing but measured something says so — the same answer the
    // tool gives everywhere else: here is what the signal actually looked like.
    const told = !hit && r.explained && (r.explained.measured || r.explained.suggestion)
      ? `<div class="idtold">${esc(r.explained.measured || '')}` +
        `${r.explained.suggestion ? `<code>${esc(r.explained.suggestion)}</code>` : ''}</div>`
      // A decoder that produced something and then had it thrown out is not the same as
      // one that produced nothing, and the difference points at a different next move.
      : !hit && r.rejected ? `<div class="idtold">${esc(r.rejected)}</div>` : '';
    const err = !hit && r.error ? `<div class="iderr">${esc(r.error)}</div>` : '';

    return `<li class="idr${hit ? ' hit' : ''}${r.thin ? ' thin' : ''}${waiting ? ' waiting' : ''}"` +
           `${any ? ` data-key="${esc(r.key)}" role="button" tabindex="0" title="build this chain"` : ''}>` +
           `<div class="idtop"><b>${esc(r.name)}</b>${via}${count}</div>${say}${thin}${told}${err}</li>`;
  }
}

const key = (c) => `${c.id}|${c.via || ''}`;

function fmtSeconds(s) {
  if (!(s > 0)) return 'the whole capture';
  return s < 1 ? `${(s * 1000).toFixed(0)} ms` : `${s.toFixed(s < 10 ? 1 : 0)} s`;
}
