// The Ask panel: a question about what is on screen, answered by the assistant on the box
// (ADR-0022).
//
// A pill at the end of the top bar, and a panel that drops from it. It began as a floating
// box like Identify's, opened where you clicked, and on a phone that box was the whole
// screen: reading the answer and acting on it could not happen at once. Docked under the
// bar it takes the top of the right-hand side and leaves the stage below it working, and
// folding it back into the pill — Escape, the pill, or touching anything else — keeps the
// conversation, so a second question can lean on the first. On a desktop the panel drags
// sideways by its head, off a signal it covers.
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
  /** `bar` is the top bar the panel hangs from; `pill` and `sep` sit at its end. */
  constructor(root, bar, pill, sep) {
    this.el = document.createElement('div');
    this.el.className = 'ask';
    this.el.hidden = true;
    root.appendChild(this.el);
    this.bar = bar;
    this.pill = pill;
    this.sep = sep;
    this.turns = [];
    this.busy = false;
    this.total = null;
    this.shift = 0;               // px the panel has been dragged left of its dock
    this.onAsk = null;
    this.onReset = null;
    this.onOpen = null;
    pill.addEventListener('click', () => (this.isOpen ? this.close() : this.onOpen && this.onOpen()));
    addEventListener('pointerdown', (e) => {
      if (this.isOpen && !this.el.contains(e.target) && !pill.contains(e.target)) this.close();
    });
    addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') { this.close(); e.preventDefault(); }
    });
    addEventListener('resize', () => { if (this.isOpen) this._place(); });
    this._wireDrag();
  }

  get isOpen() { return !this.el.hidden; }

  /** The pill is there only when the box has an assistant to ask. */
  available(yes) {
    this.pill.hidden = this.sep.hidden = !yes;
    if (!yes) this.close();
  }

  close() {
    // Hidden is not blurred straight away, and a key in the textarea is typing, not `i`.
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
    this.el.hidden = true;
    this.pill.classList.remove('on');
  }

  /** `about` is what the box said in its hello: `{ model }`. */
  open(about) {
    this.about = about;
    this.el.hidden = false;
    this.pill.classList.add('on');
    this._render();
    this._place();
    this.el.querySelector('textarea').focus();
  }

  async _send(q) {
    if (this.busy || !q.trim() || !this.onAsk) return;
    const turn = { q, steps: [], a: null, error: null };
    this.turns.push(turn);
    this.busy = true;
    this.pill.classList.add('busy');
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
    this.pill.classList.remove('busy');
    this._render();
    if (this.isOpen) this.el.querySelector('textarea').focus();
  }

  /** Under the bar, at its right end, less however far it has been dragged. */
  _place() {
    this.el.style.top = this.bar.getBoundingClientRect().bottom + 'px';
    const room = innerWidth - this.el.getBoundingClientRect().width - 16;
    this.shift = Math.max(0, Math.min(this.shift, room));
    this.el.style.setProperty('--shift', this.shift + 'px');
  }

  _wireDrag() {
    this.el.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.askhead');
      if (!head || e.target.closest('button') || matchMedia('(max-width: 600px)').matches) return;
      e.preventDefault();
      const x0 = e.clientX, s0 = this.shift;
      head.setPointerCapture(e.pointerId);
      const move = (m) => { this.shift = s0 + x0 - m.clientX; this._place(); };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
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
