import {
  Annotation,
  annotationWindow,
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
  /**
   * Width of the visible glyphs alone, with the trailing space a word carries
   * excluded. The sweep uses the full advance so it moves at a steady pace
   * across the gap between words; a rule drawn through the word must not.
   */
  inkWidth: number;
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
  /**
   * Height down to the bottom of the last row's glyphs, without the leading
   * that follows them. What the panel has to contain is the text, not the gap
   * the next line would have sat in.
   */
  inkHeight: number;
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

/**
 * How much larger an ASS `Fontsize` must be to match a CSS font size.
 *
 * libass sizes text so that the font's ascent plus descent equals Fontsize,
 * whereas canvas sizes it by the em square. For a font whose ascent+descent
 * exceeds its em — most of them — text rendered at the same number is visibly
 * smaller than the preview. Measured here rather than assumed, because the
 * ratio is a property of the individual font.
 */
export function assFontScale(ctx: CanvasRenderingContext2D, style: KaraokeStyle): number {
  applyTextStyle(ctx, style, style.fontSize);
  const m = ctx.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent) || style.fontSize <= 0) return 1;
  const scale = (ascent + descent) / style.fontSize;
  // Guard against a font reporting nonsense; 1 just means "no correction".
  return scale > 0.5 && scale < 3 ? scale : 1;
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
    const inkEnd = measure(rowText + text.replace(/\s+$/, ''));
    rowBoxes.push({
      index: i,
      x: before,
      width: after - before,
      inkWidth: Math.max(0, inkEnd - before),
    });
    rowText += text;
  }
  flushRow(rowFirst);

  const lineHeight = style.lineHeight;
  rows.forEach((row, i) => {
    row.originX = alignOrigin(style, panelX, panelWidth, row.width) + line.offsetX;
    row.originY = y + i * lineHeight + line.offsetY;
  });

  // The text is drawn from `originY` downwards, so a row reaches as far as the
  // font's own ascent plus descent — usually less than the line spacing.
  const metrics = ctx.measureText('Hg');
  const glyphs =
    (metrics.fontBoundingBoxAscent ?? 0) + (metrics.fontBoundingBoxDescent ?? 0) || size;
  const rowInk = Math.min(lineHeight, glyphs * scaleYOf(style));
  const rowCount = Math.max(1, rows.length);

  return {
    rows,
    height: rowCount * lineHeight,
    inkHeight: (rowCount - 1) * lineHeight + rowInk,
  };
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

/**
 * How much of a word's opacity survives at this moment, 0 to 1.
 *
 * A fade runs out at the instant the text would leave anyway, so it reads as
 * the line going out gently rather than being cut. Anything without a fade is
 * simply 1 and pays nothing.
 */
export function fadeFactor(
  fadeOut: number | undefined,
  leaves: number | null,
  time: number,
  duration: number
): number {
  if (!fadeOut || fadeOut <= 0) return 1;
  const end = leaves ?? duration;
  if (!Number.isFinite(end)) return 1;
  const from = end - fadeOut;
  if (time <= from) return 1;
  if (time >= end) return 0;
  return 1 - (time - from) / fadeOut;
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
  scale: number,
  duration = 0
) {
  const size = lineFontSize(line, style);
  applyTextStyle(ctx, style, size);

  const baseDefault = line.baseColor ?? style.baseColor;
  const sungDefault = line.sungColor ?? style.sungColor;
  const baseAlphaDefault = line.baseAlpha ?? style.baseAlpha ?? 100;
  const sungAlphaDefault = line.sungAlpha ?? style.sungAlpha ?? 100;
  const strikeThickness = strikeWidth(style, size);

  for (const row of layout.rows) {
    // Each row is drawn as its own string so glyph positions stay exact.
    const rowText = row.syllables.map((b) => line.syllables[b.index].text).join('');
    // Generous vertical band so outline, shadow and descenders are never clipped.
    const bandTop = row.originY - size;
    const bandHeight = size * 3;
    // Both are fractions of the type size, so the rule keeps its proportions
    // when the text is resized.
    const strikeY = row.originY + strikeOffset(style, size);
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
      const fade = fadeFactor(syl.fadeOut, line.disappearAt, time, duration);
      const baseAlpha = (syl.baseAlpha ?? baseAlphaDefault) * fade;
      const sungAlpha = (syl.sungAlpha ?? sungAlphaDefault) * fade;
      const left = row.originX + box.x;
      const p = sweepProgress(line, box.index, time, style.sweepMode);
      const { sung: sungBand, unsung } = sweepBands(left, box.width, p);

      if (unsung.width > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(unsung.x, bandTop, unsung.width, bandHeight);
        ctx.clip();
        paintText(ctx, rowText, row.originX, row.originY, base, style, scale, baseAlpha, band);
        ctx.restore();
      }

      if (sungBand.width > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(sungBand.x, bandTop, sungBand.width, bandHeight);
        ctx.clip();
        paintText(ctx, rowText, row.originX, row.originY, sung, style, scale, sungAlpha, band);
        ctx.restore();
      }

      // Drawn once, over both halves: the rule is a mark on the word rather
      // than part of the sung text, so it keeps one colour throughout. That is
      // also the only version the render can reproduce exactly.
      if (syl.strike) {
        drawStrike(
          ctx,
          left,
          box.inkWidth,
          strikeY,
          strikeThickness,
          strikeColorOf(style, line),
          style,
          baseAlpha
        );
      }
    }
  }
}

/** The colour of the strikethrough rule: its own if set, else the unsung text. */
export function strikeColorOf(style: KaraokeStyle, line?: KaraokeLine): string {
  return style.strikeColor ?? line?.baseColor ?? style.baseColor;
}

/** Where the rule sits, as an offset down from the top of the row. */
export function strikeOffset(style: KaraokeStyle, size: number): number {
  return size * scaleYOf(style) * (style.strikeHeight ?? 0.5);
}

/** How thick the rule is, in pixels. */
export function strikeWidth(style: KaraokeStyle, size: number): number {
  return Math.max(1, size * (style.strikeThickness ?? 0.055));
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
  const x0 = x;
  const w = Math.max(1, width);

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

/** How far a text box has filled at `time`, 0..1. */
/**
 * How far the fill has crossed the box.
 *
 * Measured over the span the box is sung across, not the whole time it is on
 * screen: a lead-in exists so the cue can be read before it is due, and it
 * should sit there unsung rather than already half filled.
 */
export function annotationProgress(note: Annotation, time: number, duration: number): number {
  const from = note.appearAt ?? 0;
  const to = note.disappearAt ?? duration;
  if (!(to > from)) return 1;
  return Math.max(0, Math.min(1, (time - from) / (to - from)));
}

/**
 * Draw one text box: a shout cue, a section label, a note.
 *
 * With a sung colour set it fills across its own window like a lyric line, so a
 * chant can show its length. The two passes cover disjoint halves for the same
 * reason the lyrics do — overlapping them would let the base colour show
 * through a semi-transparent fill.
 */
export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  note: Annotation,
  fontFamily: string,
  scale: number,
  time = 0,
  duration = 0
) {
  ctx.save();
  ctx.font = `${note.bold ? 'bold ' : ''}${note.fontSize}px "${fontFamily}", sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = note.align === 'center' ? 'center' : note.align === 'right' ? 'right' : 'left';

  const font = ctx.font;
  const align = ctx.textAlign;
  const fade = fadeFactor(note.fadeOut, annotationWindow(note, duration).to, time, duration);

  /**
   * Outline and fill are built at full strength on their own surface, then
   * faded together. Drawing each at partial opacity instead lets the outline
   * show through the glyphs, and with the black outline a box carries by
   * default that reads as the opacity doing nothing at all.
   */
  const paint = (fill: string, opacity: number) => {
    const alpha = Math.max(0, Math.min(100, opacity)) / 100;
    const stroke = () => {
      if (note.outlineWidth <= 0) return;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = note.outlineWidth * 2 * scale;
      ctx.strokeStyle = note.outlineColor;
      ctx.strokeText(note.text, note.x, note.y);
    };

    if (alpha >= 1 || note.outlineWidth <= 0) {
      ctx.save();
      ctx.globalAlpha = alpha;
      stroke();
      ctx.fillStyle = fill;
      ctx.fillText(note.text, note.x, note.y);
      ctx.restore();
      return;
    }

    const width = Math.max(1, Math.ceil(ctx.measureText(note.text).width + note.fontSize * 2));
    const height = Math.max(1, Math.ceil(note.fontSize * 3));
    const left = Math.floor(
      (note.align === 'center'
        ? note.x - width / 2
        : note.align === 'right'
          ? note.x - width + note.fontSize
          : note.x - note.fontSize)
    );
    const top = Math.floor(note.y - note.fontSize);

    const buffer = document.createElement('canvas');
    buffer.width = width;
    buffer.height = height;
    const bctx = buffer.getContext('2d');
    if (!bctx) return;
    bctx.translate(-left, -top);
    bctx.font = font;
    bctx.textBaseline = 'top';
    bctx.textAlign = align;
    if (note.outlineWidth > 0) {
      bctx.lineJoin = 'round';
      bctx.miterLimit = 2;
      bctx.lineWidth = note.outlineWidth * 2 * scale;
      bctx.strokeStyle = note.outlineColor;
      bctx.strokeText(note.text, note.x, note.y);
    }
    bctx.fillStyle = fill;
    bctx.fillText(note.text, note.x, note.y);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(buffer, left, top);
    ctx.restore();
  };

  if (!note.sungColor) {
    paint(note.color, (note.alpha ?? 100) * fade);
    ctx.restore();
    return;
  }

  const width = ctx.measureText(note.text).width;
  const left =
    note.align === 'center' ? note.x - width / 2 : note.align === 'right' ? note.x - width : note.x;
  const bands = sweepBands(left, width, annotationProgress(note, time, duration));
  const top = note.y - note.fontSize;
  const height = note.fontSize * 3;

  if (bands.unsung.width > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bands.unsung.x, top, bands.unsung.width, height);
    ctx.clip();
    paint(note.color, (note.alpha ?? 100) * fade);
    ctx.restore();
  }
  if (bands.sung.width > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bands.sung.x, top, bands.sung.width, height);
    ctx.clip();
    paint(note.sungColor, (note.sungAlpha ?? note.alpha ?? 100) * fade);
    ctx.restore();
  }

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
  /** Left edge of the row after alignment, and where each word sits in it. */
  x: number;
  boxes: PlacedSyllable[];
}

/** Where one lyric line sits, and where it wraps. */
export interface PlacedSyllable {
  index: number;
  /** Offset from the row's own left edge, and the width of its glyphs. */
  x: number;
  width: number;
}

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
  inkHeight: number
): boolean {
  // A panel with no usable height never hides anything, which keeps older
  // projects and freshly-made ones from silently losing lines.
  if (panel.height <= 0) return true;
  // Measured against the glyphs rather than the line box: a last line was being
  // dropped for the empty leading underneath it, which reads as the lyrics
  // vanishing while the playhead still sits on their blocks.
  return lineTop + inkHeight <= panel.y + panel.height + 0.5;
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
/**
 * The panel height every block of a track would need to be shown in full.
 *
 * Blocks each restart at the top of the panel, so the answer is the tallest of
 * them — measured to the bottom of the last line's glyphs, since the leading
 * below them does not have to be inside the box.
 */
export function requiredPanelHeight(
  ctx: CanvasRenderingContext2D,
  project: LyricProject,
  track = 0
): number {
  const panel = trackPanel(project, track);
  const style = trackStyle(project, track);
  const lines = trackLines(project)[track] ?? [];

  let needed = 0;
  for (const block of groupIntoBlocks(lines)) {
    let offset = 0;
    for (const lineIndex of block.lines) {
      const line = lines[lineIndex];
      const layout = layoutLine(ctx, line, style, panel.x, panel.width, panel.y + offset);
      needed = Math.max(needed, offset + line.offsetY + layout.inkHeight);
      offset += layout.height;
    }
  }
  return Math.ceil(needed);
}

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
        clipped: !fitsInPanel(panel, y + line.offsetY, layout.inkHeight),
        rows: layout.rows.map((row, i) => ({
          y: row.originY,
          first: row.firstSyllable,
          end: layout.rows[i + 1]?.firstSyllable ?? line.syllables.length,
          // Carried through so the exporter can put a strikethrough rule
          // exactly where the canvas draws one, rather than leaving it to
          // libass, which has its own idea of thickness and height.
          x: row.originX,
          boxes: row.syllables.map((box) => ({
            index: box.index,
            x: box.x,
            width: box.inkWidth,
          })),
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
        const fits = fitsInPanel(panel, y + line.offsetY, layout.inkHeight);
        // Advance whether or not this line is drawn, so lines inside a block
        // keep their places as others come and go.
        y += layout.height;
        if (!fits) continue;
        if (!isLineVisible(line, time, duration)) continue;
        drawLine(ctx, line, style, layout, time, scale, duration);
      }
    }
  });

  // Annotations sit above the lyrics so a shout cue reads over them.
  for (const note of project.annotations ?? []) {
    const { from, to } = annotationWindow(note, duration);
    if (time < from || time > to) continue;
    drawAnnotation(ctx, note, project.style.fontFamily, scale, time, duration);
  }
}
