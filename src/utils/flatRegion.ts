import { KaraokePanel } from '../types/karaoke';

/**
 * Find a large flat-coloured rectangle in a frame.
 *
 * Fan-chant and lyric templates usually leave a solid block of empty space for
 * the text. Detecting it means an imported template lands with the lyric panel
 * already in the right place instead of over someone's face.
 *
 * The scan is column-then-row: find the widest run of columns that are uniform
 * top to bottom, then trim that band vertically. That is enough for the
 * rectangular panels these templates use, and it fails cheaply — returning null
 * — on ordinary footage, where the caller falls back to a lower third.
 */
export function detectFlatPanel(
  source: CanvasImageSource,
  width: number,
  height: number
): KaraokePanel | null {
  if (width <= 0 || height <= 0) return null;

  // Work at reduced resolution; the panel edges do not need pixel precision.
  const scale = Math.min(1, 480 / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(source, 0, 0, w, h);
  } catch {
    return null;
  }

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }

  const at = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };

  // Tolerance absorbs compression noise, which is heavy on flat colour.
  const TOL = 26;
  const near = (a: readonly number[], b: readonly number[]) =>
    Math.abs(a[0] - b[0]) <= TOL && Math.abs(a[1] - b[1]) <= TOL && Math.abs(a[2] - b[2]) <= TOL;

  const step = Math.max(1, Math.floor(h / 90));
  const columnIsFlat: boolean[] = [];
  const columnColor: (readonly number[])[] = [];

  for (let x = 0; x < w; x++) {
    const ref = at(x, Math.floor(h / 2));
    let flat = true;
    for (let y = 2; y < h - 2; y += step) {
      if (!near(at(x, y), ref)) {
        flat = false;
        break;
      }
    }
    columnIsFlat.push(flat);
    columnColor.push(ref);
  }

  // Widest run of flat columns that all share roughly one colour.
  let best = { start: 0, end: 0 };
  let runStart = -1;
  for (let x = 0; x <= w; x++) {
    const continues =
      x < w && columnIsFlat[x] && (runStart < 0 || near(columnColor[x], columnColor[runStart]));
    if (continues) {
      if (runStart < 0) runStart = x;
    } else if (runStart >= 0) {
      if (x - runStart > best.end - best.start) best = { start: runStart, end: x };
      runStart = -1;
    }
  }

  const runWidth = best.end - best.start;
  // Demand a genuinely large block, or this fires on letterboxing and skies.
  if (runWidth < w * 0.2 || runWidth * h < w * h * 0.12) return null;

  // Trim vertically against the run's own colour.
  const probeX = Math.floor((best.start + best.end) / 2);
  const ref = at(probeX, Math.floor(h / 2));
  let top = 0;
  let bottom = h - 1;
  while (top < h - 1 && near(at(probeX, top), ref)) top++;
  while (bottom > top && near(at(probeX, bottom), ref)) bottom--;
  // Those loops walk to the first NON-matching row, so the flat band is the
  // span between them; when the whole column matches they cross over.
  if (top >= bottom) {
    top = 0;
    bottom = h - 1;
  }

  const inv = 1 / scale;
  // Inset so text does not kiss the panel edges.
  const padX = runWidth * inv * 0.06;
  const padY = (bottom - top) * inv * 0.08;

  const panel: KaraokePanel = {
    x: Math.round(best.start * inv + padX),
    y: Math.round(top * inv + padY),
    width: Math.round(runWidth * inv - padX * 2),
    height: Math.round((bottom - top) * inv - padY * 2),
  };

  if (panel.width < 40 || panel.height < 40) return null;
  return panel;
}
