// The Ask panel: a question about what is on screen, answered by the assistant on the box
// (ADR-0022).
//
// A floating box like Identify's rather than a pinned panel, because a pinned panel between
// the canvas and the menu charges its width to every operation (docs/08). It opens on a key
// and from the menu, closes on Escape or a click outside, and keeps the conversation while
// closed, so a second question can lean on the first.
//
// While a question runs it says which tool is running — a model calling three tools is
// several seconds of nothing otherwise — and every answer carries its cost, because the
// person reading it is the one paying.

const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const DOING = {
  describe_session: 'reading the chain',
  spectrum_peaks: 'measuring the spectrum',
  read_records: 'reading the decoder output',
  compare_frames: 'comparing frames',
  identify: 'running Identify',
};

/** Paragraphs, `code` and **bold**: what a short answer uses, and nothing that runs. */
function prose(text) {
  return esc(text).split(/\n{2,}/).map((p) => `<p>${p
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>')}</p>`).join('');
}

const money = (usd) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

export class AskPanel {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'ask';
    this.el.hidden = true;
    root.appendChild(this.el);
    this.turns = [];
    this.busy = false;
    this.total = null;
    this.onAsk = null;
    this.onReset = null;
    addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target)) this.close();
    });
    addEventListener('keydown', (e) => {
      if (!this.el.hidden && e.key === 'Escape') { this.close(); e.preventDefault(); }
    });
  }

  get isOpen() { return !this.el.hidden; }
  close() { this.el.hidden = true; }

  /** `about` is what the box said in its hello: `{ model }`. */
  open(at, about) {
    this.about = about;
    this.el.hidden = false;
    this._render();
    this._place(at);
    this.el.querySelector('textarea').focus();
  }

  async _send(q) {
    if (this.busy || !q.trim() || !this.onAsk) return;
    const turn = { q, steps: [], a: null, error: null };
    this.turns.push(turn);
    this.busy = true;
    this._render();
    try {
      const r = await this.onAsk(q, (s) => { turn.steps.push(s.tool); this._render(); });
      turn.a = r.text;
      turn.usd = r.usd;
      this.total = r.total;
    } catch (e) {
      turn.error = e.message || String(e);
    }
    this.busy = false;
    this._render();
    this.el.querySelector('textarea').focus();
  }

  _place({ x, y }) {
    const r = this.el.getBoundingClientRect();
    const pad = 8;
    this.el.style.left = Math.max(pad, Math.min(x, innerWidth - r.width - pad)) + 'px';
    this.el.style.top = Math.max(pad, Math.min(y, innerHeight - r.height - pad)) + 'px';
  }

  _render() {
    const draft = this.el.querySelector('textarea')?.value || '';
    const turns = this.turns.map((t) => `
      <li class="askq">${esc(t.q)}</li>
      <li class="aska">${t.a != null ? `${prose(t.a)}<div class="askcost">${money(t.usd)}</div>`
        : t.error ? `<div class="askerr">${esc(t.error)}</div>`
        : `<div class="askwait">${esc(DOING[t.steps.at(-1)] || 'thinking')}…</div>`}</li>`).join('');
    this.el.innerHTML = `
      <div class="askhead"><b>Ask</b>
        <span>${esc((this.about && this.about.model) || '')}${this.total ? ` · about ${money(this.total.usd)} so far` : ''}</span>
        ${this.turns.length ? '<button class="asknew" title="forget this conversation">new</button>' : ''}
      </div>
      ${turns ? `<ol class="asklist">${turns}</ol>`
        : `<div class="askintro">Ask about what is on screen: what a signal is, why a decode fails,
           which bits of these frames change. It reads the chain, the spectrum and the decoders'
           output; it does not change anything.</div>`}
      <div class="askin"><textarea rows="2" placeholder="What is this?" ${this.busy ? 'disabled' : ''}></textarea></div>
      <div class="askfoot">Summaries of this capture — peaks, decoded text, frames — go to Anthropic's API.</div>`;
    const ta = this.el.querySelector('textarea');
    ta.value = this.busy ? '' : draft;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.close(); e.preventDefault(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(ta.value); }
      e.stopPropagation();      // every key here is typing, not a shortcut
    });
    const nw = this.el.querySelector('.asknew');
    if (nw) nw.addEventListener('click', async () => {
      if (this.busy) return;
      this.turns = [];
      if (this.onReset) await this.onReset();
      this._render();
    });
    const list = this.el.querySelector('.asklist');
    if (list) list.scrollTop = list.scrollHeight;
  }
}
