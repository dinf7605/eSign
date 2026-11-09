// 마우스·터치·펜으로 서명을 그리는 캔버스
export class SignaturePad {
  constructor(canvas, { color = '#111a3a', width = 2.6, onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.lineWidth = width;
    this.onChange = onChange;
    this.strokes = [];
    this.current = null;
    this.scale = 1;

    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    canvas.addEventListener('pointerup', () => this.#up());
    canvas.addEventListener('pointercancel', () => this.#up());
  }

  /** 화면 크기에 맞춰 내부 해상도를 다시 잡는다 (모달이 열린 뒤 호출) */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.scale = dpr;
    this.#redraw();
  }

  isEmpty() { return this.strokes.length === 0; }

  clear() {
    this.strokes = [];
    this.#redraw();
    this.onChange?.();
  }

  undo() {
    this.strokes.pop();
    this.#redraw();
    this.onChange?.();
  }

  #point(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * this.scale, y: (e.clientY - rect.top) * this.scale, p: e.pressure || 0.5 };
  }

  #down(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.current = [this.#point(e)];
    this.strokes.push(this.current);
    this.#redraw();
  }

  #move(e) {
    if (!this.current) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) this.current.push(this.#point(ev));
    this.#redraw();
  }

  #up() {
    if (!this.current) return;
    this.current = null;
    this.onChange?.();
  }

  #drawStrokes(ctx, strokes, scale, offsetX = 0, offsetY = 0) {
    ctx.strokeStyle = this.color;
    ctx.fillStyle = this.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.lineWidth * scale;
    for (const s of strokes) {
      const pts = s.map((p) => ({ x: (p.x - offsetX) * (scale / this.scale), y: (p.y - offsetY) * (scale / this.scale) }));
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      // 점 사이를 2차 곡선으로 이어 부드럽게
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i += 1) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
  }

  #redraw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.#drawStrokes(this.ctx, this.strokes, this.scale || 1);
  }

  /**
   * 서명 부분만 잘라서, 서명란 비율(가로/세로)에 맞춘 투명 PNG로 내보낸다.
   * → 서버는 받은 이미지를 서명란 크기 그대로 붙이면 된다.
   */
  toPng(aspect) {
    const pts = this.strokes.flat();
    const pad = this.lineWidth * this.scale * 2;
    const minX = Math.min(...pts.map((p) => p.x)) - pad;
    const maxX = Math.max(...pts.map((p) => p.x)) + pad;
    const minY = Math.min(...pts.map((p) => p.y)) - pad;
    const maxY = Math.max(...pts.map((p) => p.y)) + pad;
    const inkW = maxX - minX;
    const inkH = maxY - minY;

    const outH = 240;
    const outW = Math.round(Math.min(outH * aspect, 1600));
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const margin = 0.08;
    const fit = Math.min((outW * (1 - margin * 2)) / inkW, (outH * (1 - margin * 2)) / inkH);
    const ctx = out.getContext('2d');
    ctx.translate((outW - inkW * fit) / 2, (outH - inkH * fit) / 2);
    // 선 굵기는 크기 조정 비율을 반영
    this.#drawStrokes(ctx, this.strokes, fit * this.scale, minX, minY);
    return out.toDataURL('image/png');
  }
}
