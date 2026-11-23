/**
 * Draw a signature (or initials) to place on the PDF. Exported as a PNG with
 * a transparent background, trimmed to the ink, so it sits on the page like
 * a pen signature. A visible mark only — not a digital signature (DSC).
 */
import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/modules/workstation/components';

export function SignaturePad({ onCancel, onDone }: { onCancel: () => void; onDone: (data: string, aspect: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<[number, number] | null>(null);
  const [empty, setEmpty] = useState(true);
  const [color, setColor] = useState('#1e3a8a');

  useEffect(() => {
    const c = ref.current!;
    c.width = 1200; c.height = 400;
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * e.currentTarget.width, ((e.clientY - r.top) / r.height) * e.currentTarget.height];
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const ctx = e.currentTarget.getContext('2d')!;
    const p = pos(e);
    ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(...last.current); ctx.lineTo(...p); ctx.stroke();
    last.current = p;
    setEmpty(false);
  };
  const up = () => { drawing.current = false; last.current = null; };
  const clear = () => { const c = ref.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); setEmpty(true); };

  function done() {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let x0 = c.width; let y0 = c.height; let x1 = 0; let y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 <= x0 || y1 <= y0) return;
    const pad = 8;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width, x1 + pad); y1 = Math.min(c.height, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0; out.height = y1 - y0;
    out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    onDone(out.toDataURL('image/png'), out.width / out.height);
  }

  return (
    <Modal open title="Draw your signature" onClose={onCancel} width="w-[640px]"
      footer={(
        <div className="flex items-center gap-2 w-full">
          <button type="button" className="h-9 px-3 text-13 rounded-lg border border-neutral-200 bg-white" onClick={clear}>Clear</button>
          <span className="inline-flex gap-1 ml-1">
            {['#1e3a8a', '#000000', '#1d4ed8'].map((c) => (
              <button key={c} type="button" aria-label={`Ink ${c}`} onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-full ${color === c ? 'ring-2 ring-primary ring-offset-1' : ''}`} style={{ background: c }} />
            ))}
          </span>
          <div className="flex-1" />
          <button type="button" className="h-9 px-3 text-13 rounded-lg border border-neutral-200 bg-white" onClick={onCancel}>Cancel</button>
          <button type="button" disabled={empty} onClick={done} className="h-9 px-4 text-13 font-medium rounded-lg bg-primary text-white disabled:opacity-50">
            Place on the PDF
          </button>
        </div>
      )}>
      <canvas ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        className="w-full aspect-[3/1] rounded-lg border border-dashed border-neutral-300 bg-white touch-none cursor-crosshair" />
      <p className="text-12 text-neutral-500 mt-2">
        Sign with the mouse, a trackpad or a finger. This places a picture of your signature — it is not a digital signature (DSC).
      </p>
    </Modal>
  );
}
