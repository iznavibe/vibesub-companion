import {
  Annotation,
  KaraokeBackground,
  KaraokeLine,
  KaraokeStyle,
  LyricProject,
} from '../types/karaoke';
import { groupIntoBlocks } from './karaokeText';

export interface SyllableBox {
  index: number;
  /** Canvas-space left edge and width of this syllable within its row. */
  x: number;
  width: number;
}

export interface RowLayout {
  /** Left edge of this row's text, after alignment. */
  originX: number;
  /** Top edge of this row. */
  originY: number;
  width: number;
  /** Index of the first syllable on this row, used to place ASS breaks. */
  firstSyllable: number;
  syllables: SyllableBox[];
}

export interface LineLayout {
  rows: RowLayout[];
  /** Total vertical space this line occupies, including wrapped rows. */
  height: number;
}

export function cssFont(style: KaraokeStyle, fontSize: number): string {
  const parts: string[] = [];
  if (style.italic) parts.push('italic');
  if (style.bold) parts.push('bold');
  parts.push(`${fontSize}px`);
  parts.push(`"${style.fontFamily}", sans-serif`);
  return parts.join(' ');
}

function applyTextStyle(ctx: CanvasRenderingContext2D, style: KaraokeStyle, fontSize: number) {
  ctx.font = cssFont(style, fontSize);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  // letterSpacing is Chromium-only; WebView2 and Chrome both support it.
  (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
    `${style.letterSpacing}px`;
}

/** Effective font size for a line, honouring its override. */
export function lineFontSize(line: KaraokeLine, style: KaraokeStyle): number {
  return line.fontSize ?? style.fontSize;
}

/** Horizontal glyph scale as a multiplier. */
export function scaleXOf(style: KaraokeStyle): number {
  return (style.scaleX ?? 100) / 100;
}

/** Vertical glyph scale as a multiplier. */
export function scaleYOf(style: KaraokeStyle): number {
  return (style.scaleY ?? 100) / 100;
}

function alignOrigin(
  style: KaraokeStyle,
  panelX: number,
  panelWidth: number,
  rowWidth: number
): number {
  if (style.align === 'center') return panelX + (panelWidth - rowWidth) / 2;
  if (style.align === 'right') return panelX + panelWidth - rowWidth;
  return panelX;
}

/**
 * Lay a lyric line out, wrapping it to the panel width.
 *
 * Narrowing the panel pushes words onto the next row rather than compressing
 * the glyphs — the text keeps its shape and reflows, which is what a text box
 * is expected to do.
 *
 * Widths come from measuring cumulative prefixes rather than summing individual
 * syllable widths, so kerning across syllable boundaries matches what a
 * whole-line shaper (libass/harfbuzz) produces.
 */
export function layoutLine(
  ctx: CanvasRenderingContext2D,
  line: KaraokeLine,
  style: KaraokeStyle,
  panelX: number,
  panelWidth: number,
  y: number
): LineLayout {
  const size = lineFontSize(line, style);
  applyTextStyle(ctx, style, size);

  const sx = scaleXOf(style);
  const measure = (text: string) => ctx.measureText(text).width * sx;
  const maxWidth = Math.max(1, panelWidth);

  const rows: RowLayout[] = [];
  let rowFirst = 0;
  let rowText = '';
  let rowBoxes: SyllableBox[] = [];

  const flushRow = (firstSyllable: number) => {
    if (rowBoxes.length === 0) return;
    // Align on the visible text: a trailing space would push a centred row off.
    const width = measure(rowText.replace(/\s+$/, ''));
    rows.push({
      originX: 0, // filled in below, once every row width is known
      originY: 0,
      width,
      firstSyllable,
      syllables: rowBoxes,
    });
    rowBoxes = [];
    rowText = '';
  };

  for (let i = 0; i < line.syllables.length; i++) {
    const text = line.syllables[i].text;
    const candidate = rowText + text;
    // Trailing spaces should not force a wrap, so measure without them.
    const candidateWidth = measure(candidate.replace(/\s+$/, ''));

    if (rowBoxes.length > 0 && candidateWidth > maxWidth) {
      flushRow(rowFirst);
      rowFirst = i;
    }

    const before = measure(rowText);
    const after = measure(rowText + text);
    rowBoxes.push({ index: i, x: before, width: after - before });
    rowText += text;
  }
  flushRow(rowFirst);

  const lineHeight = style.lineHeight;
  rows.forEach((row, i) => {
    row.originX = alignOrigin(style, panelX, panelWidth, row.width) + line.offsetX;
    row.originY = y + i * lineHeight + line.offsetY;
  });

  return { rows, height: Math.max(1, rows.length) * lineHeight };
}

/** Syllable indices at which a new row begins, for the ASS `\N` breaks. */
export function rowBreaks(layout: LineLayout): number[] {
  return layout.rows.slice(1).map((r) => r.firstSyllable);
}

/**
 * How far the sweep has travelled through syllable `i` at `time`, in 0..1.
 *
 * In 'continuous' mode a syllable keeps sweeping until the next one starts, so
 * a gap in the timing shows up as a slower sweep rather than a pause. In 'hold'
 * mode the fill finishes at its own end time and waits there.
 */
export function sweepProgress(
  line: KaraokeLine,
  i: number,
  time: number,
  mode: KaraokeStyle['sweepMode']
): number {
  const syl = line.syllables[i];
  if (!syl) return 0;
  const next = line.syllables[i + 1];

  const from = syl.start;
  const to = mode === 'continuous' && next ? Math.max(next.start, syl.start) : syl.end;

  if (time <= from) return 0;
  if (to <= from || time >= to) return 1;
  return (time - from) / (to - from);
}

export function isLineVisible(line: KaraokeLine, time: number, duration: number): boolean {
  const from = line.appearAt ?? 0;
  const to = line.disappearAt ?? duration;
  return time >= from && time <= to;
}

/**
 * The two horizontal bands a syllable is painted in: the part the sweep has
 * passed, and the part it has not.
 *
 * They are disjoint and together cover the syllable exactly, so every pixel is
 * painted once. Painting the unsung text under the sung text instead would let
 * it show through whenever the sung colour is semi-transparent, which makes the
 * "opacity after" setting look like it does nothing.
 */
export function sweepBands(
  left: number,
  width: number,
  progress: number
): { sung: { x: number; width: number }; unsung: { x: number; width: number } } {
  const p = Math.max(0, Math.min(1, progress));
  const split = left + width * p;
  return {
    sung: { x: left, width: split - left },
    unsung: { x: split, width: left + width - split },
  };
}

/** Reused between frames so transparent text does not allocate a canvas per draw. */
let scratchCanvas: HTMLCanvasElement | null = null;

/** Draw the shadow/outline/fill stack at full opacity into `target`. */
function paintLayers(
  target: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
  style: KaraokeStyle,
  scale: number
) {
  if (style.shadowOffset > 0) {
    target.fillStyle = style.shadowColor;
    target.fillText(text, x + style.shadowOffset * scale, y + style.shadowOffset * scale);
  }
  if (style.outlineWidth > 0) {
    target.lineJoin = 'round';
    target.miterLimit = 2;
    // ASS `Outline` is a radius; a centred canvas stroke needs twice that.
    target.lineWidth = style.outlineWidth * 2 * scale;
    target.strokeStyle = style.outlineColor;
    target.strokeText(text, x, y);
  }
  target.fillStyle = fill;
  target.fillText(text, x, y);
}

/**
 * Paint one run of text with the style's outline, shadow and glyph scaling.
 *
 * ScaleX/ScaleY are applied as a canvas transform anchored at the text origin,
 * matching how libass scales glyphs about the same point.
 *
 * Below full opacity with an outline, the layers are composed opaquely offscreen
 * and blended in one go. Fading them individually would let the outline show
 * through the letter it surrounds, muddying the fill — libass composites the
 * finished glyph, not each layer separately.
 */
function paintText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
  style: KaraokeStyle,
  scale: number,
  opacity: number,
  /** Canvas-space region this run can affect, used to scope the alpha buffer. */
  bounds: { x: number; y: number; width: number; height: number }
) {
  const alpha = Math.max(0, Math.min(100, opacity)) / 100;
  if (alpha === 0) return;

  const sx = scaleXOf(style);
  const sy = scaleYOf(style);
  const scaled = sx !== 1 || sy !== 1;
  const layered = style.outlineWidth > 0 || style.shadowOffset > 0;

  const applyScale = (target: CanvasRenderingContext2D) => {
    if (!scaled) return;
    target.translate(x, y);
    target.scale(sx, sy);
    target.translate(-x, -y);
  };

  if (alpha >= 1 || !layered) {
    ctx.save();
    ctx.globalAlpha = alpha;
    applyScale(ctx);
    paintLayers(ctx, text, x, y, fill, style, scale);
    ctx.restore();
    return;
  }

  // Offscreen buffer matching the visible canvas, so destination coordinates and
  // the active clip carry over unchanged.
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
  if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas.width = width;
    scratchCanvas.height = height;
  }
  const scratch = scratchCanvas.getContext('2d');
  if (!scratch) {
    // No buffer available: fall back to the direct path rather than skipping.
    ctx.save();
    ctx.globalAlpha = alpha;
    applyScale(ctx);
    paintLayers(ctx, text, x, y, fill, style, scale);
    ctx.restore();
    return;
  }

  const matrix = ctx.getTransform();
  // Only the region this run touches is cleared and copied; clearing the whole
  // buffer per syllable would cost more than the effect is worth.
  const device = {
    left: Math.max(0, Math.floor(matrix.a * bounds.x + matrix.e) - 2),
    top: Math.max(0, Math.floor(matrix.d * bounds.y + matrix.f) - 2),
    right: Math.min(width, Math.ceil(matrix.a * (bounds.x + bounds.width) + matrix.e) + 2),
    bottom: Math.min(height, Math.ceil(matrix.d * (bounds.y + bounds.height) + matrix.f) + 2),
  };
  const dw = device.right - device.left;
  const dh = device.bottom - device.top;
  if (dw <= 0 || dh <= 0) return;

  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.clearRect(device.left, device.top, dw, dh);
  scratch.setTransform(matrix);
  scratch.font = ctx.font;
  scratch.textAlign = ctx.textAlign;
  scratch.textBaseline = ctx.textBaseline;
  (scratch as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = (
    ctx as CanvasRenderingContext2D & { letterSpacing: string }
  ).letterSpacing;

  scratch.save();
  applyScale(scratch);
  paintLayers(scratch, text, x, y, fill, style, scale);
  scratch.restore();

  ctx.save();
  ctx.globalAlpha = alpha;
  // Identity transform: the scratch already holds device-space pixels. The clip
  // set by the caller is in device space too, so it still applies.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(scratchCanvas, device.left, device.top, dw, dh, device.left, device.top, dw, dh);
  ctx.restore();
}

/**
 * Draw one lyric line with the sweep applied.
 *
 * Each syllable is painted by clipping to its own horizontal band and redrawing
 * the whole line string, so glyph positions never drift from the un-clipped
 * layout. The base pass covers the full syllable; the sung pass covers only the
 * part the sweep has reached.
 */
export function drawLine(
  ctx: CanvasRenderingContext2D,
  line: KaraokeLine,
  style: KaraokeStyle,
  layout: LineLayout,
  time: number,
  scale: number
) {
  const size = lineFontSize(line, style);
  applyTextStyle(ctx, style, size);

  const baseDefault = line.baseColor ?? style.baseColor;
  const sungDefault = line.sungColor ?? style.sungColor;
  const baseAlphaDefault = line.baseAlpha ?? style.baseAlpha ?? 100;
  const sungAlphaDefault = line.sungAlpha ?? style.sungAlpha ?? 100;
  const strikeThickness = Math.max(1.5, size * 0.055);

  for (const row of layout.rows) {
    // Each row is drawn as its own string so glyph positions stay exact.
    const rowText = row.syllables.map((b) => line.syllables[b.index].text).join('');
    // Generous vertical band so outline, shadow and descenders are never clipped.
    const bandTop = row.originY - size;
    const bandHeight = size * 3;
    const strikeY = row.originY + size * scaleYOf(style) * 0.5;
    // Whole-row extent: each pass draws the full row string, clipped.
    const band = {
      x: row.originX - size,
      y: bandTop,
      width: row.width + size * 2,
      height: bandHeight,
    };

    for (const box of row.syllables) {
      const syl = line.syllables[box.index];
      const base = syl.baseColor ?? baseDefault;
      const sung = syl.sungColor ?? sungDefault;
      const baseAlpha = syl.baseAlpha ?? baseAlphaDefault;
      const sungAlpha = syl.sungAlpha ?? sungAlphaDefault;
      const left = row.originX + box.x;
      const p = sweepProgress(line, box.index, time, style.sweepMode);
      const { sung: sungBand, unsung } = sweepBands(left, box.width, p);

      if (unsung.width > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(unsung.x, bandTop, unsung.width, bandHeight);
        ctx.clip();
        paintText(ctx, rowText, row.originX, row.originY, base, style, scale, baseAlpha, band);
        if (syl.strike) {
          drawStrike(ctx, left, box.width, strikeY, strikeThickness, base, style, baseAlpha);
        }
        ctx.restore();
      }

      if (sungBand.width > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(sungBand.x, bandTop, sungBand.width, bandHeight);
        ctx.clip();
        paintText(ctx, rowText, row.originX, row.originY, sung, style, scale, sungAlpha, band);
        if (syl.strike) {
          drawStrike(ctx, left, box.width, strikeY, strikeThickness, sung, style, sungAlpha);
        }
        ctx.restore();
      }
    }
  }
}

/** A struck-through word, outlined to stay legible over busy footage. */
function drawStrike(
  ctx: CanvasRenderingContext2D,
  x: number,
  width: number,
  y: number,
  thickness: number,
  color: string,
  style: KaraokeStyle,
  opacity = 100
) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(100, opacity)) / 100;
  // Trim the trailing space a syllable carries, so the rule stops at the word.
  const inset = width * 0.04;
  const x0 = x + inset;
  const w = Math.max(1, width - inset * 2);

  if (style.outlineWidth > 0) {
    ctx.fillStyle = style.outlineColor;
    const pad = style.outlineWidth;
    ctx.fillRect(x0 - pad, y - thickness / 2 - pad, w + pad * 2, thickness + pad * 2);
  }
  ctx.fillStyle = color;
  ctx.fillRect(x0, y - thickness / 2, w, thickness);
  ctx.restore();
}

/** Bounding box of an annotation, for hit testing and the transform handles. */
export function annotationBounds(
  ctx: CanvasRenderingContext2D,
  note: Annotation,
  fontFamily: string
): { x: number; y: number; width: number; height: number } {
  ctx.save();
  ctx.font = `${note.bold ? 'bold ' : ''}${note.fontSize}px "${fontFamily}", sans-serif`;
  const width = ctx.measureText(note.text).width;
  ctx.restore();

  const height = note.fontSize * 1.25;
  let x = note.x;
  if (note.align === 'center') x = note.x - width / 2;
  else if (note.align === 'right') x = note.x - width;
  return { x, y: note.y, width, height };
}

/** Draw one non-sung text box: a shout cue, a section label, a note. */
export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  note: Annotation,
  fontFamily: string,
  scale: number
) {
  ctx.save();
  ctx.font = `${note.bold ? 'bold ' : ''}${note.fontSize}px "${fontFamily}", sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = note.align === 'center' ? 'center' : note.align === 'right' ? 'right' : 'left';

  if (note.outlineWidth > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = note.outlineWidth * 2 * scale;
    ctx.strokeStyle = note.outlineColor;
    ctx.strokeText(note.text, note.x, note.y);
  }
  ctx.fillStyle = note.color;
  ctx.fillText(note.text, note.x, note.y);
  ctx.restore();
}

/** Destination rect for background media under the chosen fit mode. */
export function fitRect(
  bg: KaraokeBackground,
  naturalWidth: number,
  naturalHeight: number
): { x: number; y: number; width: number; height: number } {
  if (bg.fit === 'stretch' || naturalWidth <= 0 || naturalHeight <= 0) {
    return { x: bg.x, y: bg.y, width: bg.width, height: bg.height };
  }
  const scale =
    bg.fit === 'cover'
      ? Math.max(bg.width / naturalWidth, bg.height / naturalHeight)
      : Math.min(bg.width / naturalWidth, bg.height / naturalHeight);
  const w = naturalWidth * scale;
  const h = naturalHeight * scale;
  return { x: bg.x + (bg.width - w) / 2, y: bg.y + (bg.height - h) / 2, width: w, height: h };
}

export type BackgroundSource = CanvasImageSource & {
  width?: number;
  height?: number;
  videoWidth?: number;
  videoHeight?: number;
};

/** Paint the colour field plus any background media, clipped to its placement rect. */
export function drawBackground(
  ctx: CanvasRenderingContext2D,
  project: LyricProject,
  media: BackgroundSource | null
) {
  const { canvas, background } = project;
  ctx.fillStyle = background.color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!media) return;
  const nw = (media.videoWidth || media.width || 0) as number;
  const nh = (media.videoHeight || media.height || 0) as number;
  if (nw <= 0 || nh <= 0) return;

  const rect = fitRect(background, nw, nh);
  ctx.save();
  ctx.beginPath();
  ctx.rect(background.x, background.y, background.width, background.height);
  ctx.clip();
  ctx.drawImage(media, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

/** One visual row of a lyric line after wrapping. */
export interface RowPlacement {
  y: number;
  /** Inclusive first and exclusive last syllable index on this row. */
  first: number;
  end: number;
}

/** Where one lyric line sits, and where it wraps. */
export interface LinePlacement {
  /** Top edge of the line's first row. */
  y: number;
  /** True when the line falls outside its panel and is not drawn. */
  clipped: boolean;
  rows: RowPlacement[];
}

/**
 * The style a track's text is drawn with.
 *
 * The romaji track inherits everything from the main style and overrides only
 * what it declares, so changing the project font or colour carries to both
 * without having to keep two full styles in sync.
 */
export function trackStyle(project: LyricProject, track: number): KaraokeStyle {
  if (track === 0) return project.style;
  return { ...project.style, ...(project.romaji?.style ?? {}) };
}

/**
 * Whether a line fits inside its panel.
 *
 * The transform box is a real boundary, not a hint: a line that would spill past
 * the bottom is dropped rather than drawn over whatever is below. The preview
 * and the exporter both consult this, so what you see is what renders.
 */
export function fitsInPanel(
  panel: { y: number; height: number },
  lineTop: number,
  lineHeight: number
): boolean {
  // A panel with no usable height never hides anything, which keeps older
  // projects and freshly-made ones from silently losing lines.
  if (panel.height <= 0) return true;
  return lineTop + lineHeight <= panel.y + panel.height + 0.5;
}

/** The panel a track is laid out inside. */
export function trackPanel(project: LyricProject, track: number) {
  return track === 0 ? project.panel : project.romaji?.panel ?? project.panel;
}

/** The lines of each track, main first. Romaji is empty when disabled. */
export function trackLines(project: LyricProject): KaraokeLine[][] {
  return [project.lines, project.romaji?.enabled ? project.romaji.lines : []];
}

/**
 * Measure every line once, stacking them so wrapped lines push later lines down.
 *
 * Both the canvas and the ASS exporter consume this, which is what stops the
 * preview and the render from disagreeing about where text breaks: the
 * measurement happens exactly once, on a canvas, and the exporter just replays
 * the break points as `\N`.
 */
export function planLayout(
  ctx: CanvasRenderingContext2D,
  project: LyricProject,
  track = 0
): LinePlacement[] {
  const panel = trackPanel(project, track);
  const style = trackStyle(project, track);
  const lines = trackLines(project)[track] ?? [];

  const placements: LinePlacement[] = new Array(lines.length);

  // Each block starts again at the top of the panel: only one block is on
  // screen at a time, so they must not stack down the whole song.
  for (const block of groupIntoBlocks(lines)) {
    let y = panel.y;
    for (const lineIndex of block.lines) {
      const line = lines[lineIndex];
      const layout = layoutLine(ctx, line, style, panel.x, panel.width, y);
      placements[lineIndex] = {
        y,
        clipped: !fitsInPanel(panel, y, layout.height),
        rows: layout.rows.map((row, i) => ({
          y: row.originY,
          first: row.firstSyllable,
          end: layout.rows[i + 1]?.firstSyllable ?? line.syllables.length,
        })),
      };
      y += layout.height;
    }
  }
  return placements;
}

/** Top edge of the nth lyric line, ignoring wrapping. */
export function lineY(project: LyricProject, index: number): number {
  return project.panel.y + index * project.style.lineHeight;
}

/**
 * Render a complete frame at `time` into a context already transformed so that
 * canvas-space coordinates map onto the target surface.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: LyricProject,
  time: number,
  media: BackgroundSource | null,
  scale = 1
) {
  drawBackground(ctx, project, media);

  const { duration } = project;
  trackLines(project).forEach((lines, track) => {
    const panel = trackPanel(project, track);
    const style = trackStyle(project, track);

    for (const block of groupIntoBlocks(lines)) {
      let y = panel.y;
      for (const lineIndex of block.lines) {
        const line = lines[lineIndex];
        const layout = layoutLine(ctx, line, style, panel.x, panel.width, y);
        const fits = fitsInPanel(panel, y, layout.height);
        // Advance whether or not this line is drawn, so lines inside a block
        // keep their places as others come and go.
        y += layout.height;
        if (!fits) continue;
        if (!isLineVisible(line, time, duration)) continue;
        drawLine(ctx, line, style, layout, time, scale);
      }
    }
  });

  // Annotations sit above the lyrics so a shout cue reads over them.
  for (const note of project.annotations ?? []) {
    const from = note.appearAt ?? 0;
    const to = note.disappearAt ?? duration;
    if (time < from || time > to) continue;
    drawAnnotation(ctx, note, project.style.fontFamily, scale);
  }
}
