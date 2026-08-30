import {
  annotationWindow,
  KaraokeLine,
  KaraokeStyle,
  LyricProject,
} from '../types/karaoke';
import { lineFontSize } from './karaokeRenderer';

/**
 * ASS colours are &HAABBGGRR — alpha first, then blue/green/red, i.e. the
 * reverse of CSS. Alpha is inverted too: 00 is opaque.
 */
export function toAssColor(css: string, alpha = 0): string {
  const hex = css.replace('#', '').trim();
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.padEnd(6, '0').slice(0, 6);
  const r = full.slice(0, 2);
  const g = full.slice(2, 4);
  const b = full.slice(4, 6);
  const a = alpha.toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/**
 * Colour in the form used by inline override tags. The trailing '&' terminates
 * the value so a following tag in the same block cannot be misread as part of
 * it. Style fields are comma-delimited already and take the bare form.
 */
export function toAssColorTag(css: string, alpha = 0): string {
  return `${toAssColor(css, alpha)}&`;
}

/**
 * Opacity percentage to an ASS alpha byte.
 *
 * ASS stores transparency, not opacity: 00 is fully opaque and FF fully
 * invisible, the reverse of how the UI presents it.
 */
export function opacityToAssAlpha(opacity: number): number {
  const clamped = Math.max(0, Math.min(100, opacity));
  return Math.round((1 - clamped / 100) * 255);
}

/** Alpha in the `&HAA&` form used by the `\1a` / `\2a` override tags. */
export function toAssAlphaTag(opacity: number): string {
  return `&H${opacityToAssAlpha(opacity).toString(16).padStart(2, '0').toUpperCase()}&`;
}

/** Seconds to ASS `h:mm:ss.cc`. ASS uses centiseconds and a single hour digit. */
export function toAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const cs = Math.round(clamped * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${c
    .toString()
    .padStart(2, '0')}`;
}

/** Text that would otherwise be read as ASS markup or line breaks. */
function escapeAssText(text: string): string {
  return text.replace(/\\/g, '∖').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/** Zero-width space, used to park a `\k` pause that must not render a glyph. */
const ZWSP = '​';

/** ASS numeric alignment for a top-anchored box. */
function assAlignment(style: KaraokeStyle): number {
  if (style.align === 'center') return 8;
  if (style.align === 'right') return 9;
  return 7;
}

/**
 * Build the karaoke run for one line.
 *
 * In 'continuous' mode each syllable's `\kf` runs until the next one starts, so
 * gaps become slower sweeps. In 'hold' mode the sweep finishes at the syllable's
 * own end time and a zero-width `\k` run absorbs the remaining gap, which reads
 * as the fill pausing before the next word.
 *
 * Durations are derived from absolute centisecond targets rather than from each
 * delta in turn. libass plays karaoke by summing the durations it is given, so
 * rounding each delta independently would let the error compound down the line
 * — a long line could drift tens of milliseconds off by its last word. Anchoring
 * to absolute targets keeps every sweep within half a centisecond of the time
 * shown in the editor, no matter how many syllables precede it.
 */
function buildKaraokeRun(
  line: KaraokeLine,
  style: KaraokeStyle,
  lineStart: number,
  range: { first: number; end: number } = { first: 0, end: line.syllables.length }
): string {
  const parts: string[] = [];
  const defaultBase = line.baseColor ?? style.baseColor;
  const defaultSung = line.sungColor ?? style.sungColor;
  const defaultBaseAlpha = line.baseAlpha ?? style.baseAlpha ?? 100;
  const defaultSungAlpha = line.sungAlpha ?? style.sungAlpha ?? 100;

  // Everything is measured from the event's own rounded start time, which is
  // what libass uses as time zero for the karaoke run.
  const originCs = Math.round(lineStart * 100);
  let emittedCs = 0;
  /** Emit filler/sweep so the run reaches `time`, and return the duration used. */
  const durationTo = (time: number): number => {
    const targetCs = Math.round(time * 100) - originCs;
    const d = Math.max(0, targetCs - emittedCs);
    emittedCs += d;
    return d;
  };

  // Seeded from the *Style* line, not from the line's own overrides: these track
  // what libass currently has in effect, and the Style declares the project
  // values. Seeding them from the line defaults would suppress the very tag that
  // carries a per-line override, silently dropping it from the render.
  let activeBase = style.baseColor;
  let activeSung = style.sungColor;
  let activeBaseAlpha = style.baseAlpha ?? 100;
  let activeSungAlpha = style.sungAlpha ?? 100;
  let activeStrike = false;

  // A leading gap before this row's first syllable, so the text can sit unsung
  // on screen before the sweep arrives. Each wrapped row is its own event, so
  // the lead-in covers everything sung on earlier rows too.
  const firstStart = line.syllables[range.first]?.start ?? lineStart;
  const lead = durationTo(firstStart);
  if (lead > 0) parts.push(`{\\k${lead}}${ZWSP}`);

  for (let i = range.first; i < range.end; i++) {
    const syl = line.syllables[i];
    const next = line.syllables[i + 1];
    const base = syl.baseColor ?? defaultBase;
    const sung = syl.sungColor ?? defaultSung;
    const baseAlpha = syl.baseAlpha ?? defaultBaseAlpha;
    const sungAlpha = syl.sungAlpha ?? defaultSungAlpha;

    // Emit colour overrides only when they actually change, to keep the file
    // readable and avoid redundant tags.
    const tags: string[] = [];
    if (sung !== activeSung) {
      tags.push(`\\1c${toAssColorTag(sung)}`);
      activeSung = sung;
    }
    if (base !== activeBase) {
      tags.push(`\\2c${toAssColorTag(base)}`);
      activeBase = base;
    }
    // \1a is the sung (primary) alpha, \2a the unsung (secondary) one.
    if (sungAlpha !== activeSungAlpha) {
      tags.push(`\\1a${toAssAlphaTag(sungAlpha)}`);
      activeSungAlpha = sungAlpha;
    }
    if (baseAlpha !== activeBaseAlpha) {
      tags.push(`\\2a${toAssAlphaTag(baseAlpha)}`);
      activeBaseAlpha = baseAlpha;
    }

    // Strikeout toggles per run, so only emit it when the state changes.
    const strike = syl.strike === true;
    if (strike !== activeStrike) {
      tags.push(strike ? '\\s1' : '\\s0');
      activeStrike = strike;
    }

    const sweepEnd =
      style.sweepMode === 'continuous' && next ? Math.max(next.start, syl.start) : syl.end;

    tags.push(`\\kf${durationTo(sweepEnd)}`);

    // A word carries the space that follows it, so that the sweep crosses the
    // gap at a steady pace. The rule through the word must stop at the glyphs,
    // so the space goes out as its own unstruck run inside the same syllable.
    const trailing = /\s+$/.exec(syl.text)?.[0] ?? '';
    if (strike && trailing) {
      const core = syl.text.slice(0, syl.text.length - trailing.length);
      parts.push(`{${tags.join('')}}${escapeAssText(core)}{\\s0}${escapeAssText(trailing)}`);
      activeStrike = false;
    } else {
      parts.push(`{${tags.join('')}}${escapeAssText(syl.text)}`);
    }

    // Hold the fill until the next syllable begins, but only within this row —
    // the gap across a row break belongs to the next row's lead-in.
    if (style.sweepMode === 'hold' && next && i + 1 < range.end) {
      const holdCs = durationTo(next.start);
      if (holdCs > 0) parts.push(`{\\k${holdCs}}${ZWSP}`);
    }
  }

  // Match the canvas, which aligns each row on its visible text.
  for (let i = parts.length - 1; i >= 0; i--) {
    const trimmed = parts[i].replace(/\s+$/, '');
    if (trimmed !== parts[i]) parts[i] = trimmed;
    if (trimmed.length > 0 && !trimmed.endsWith('}')) break;
  }

  return parts.join('');
}

export interface AssRowPlacement {
  y: number;
  first: number;
  end: number;
}

export interface AssLinePlacement {
  y: number;
  rows: AssRowPlacement[];
  /** Lines that fall outside their panel are omitted, matching the preview. */
  clipped?: boolean;
}

export interface AssBuildOptions {
  /** Overall length of the render, used when a line has no explicit end. */
  duration: number;
  /**
   * Per-line row positions, measured on a canvas by `planLayout`. Supplying it
   * is what keeps the render identical to the preview: each wrapped row becomes
   * its own positioned event, so libass never picks its own line spacing.
   */
  layout?: AssLinePlacement[];
  /** The same, measured for the romaji track. */
  romajiLayout?: AssLinePlacement[];
  /**
   * Multiplier turning a CSS font size into the ASS `Fontsize` that renders at
   * the same visual size. See `assFontScale`; 1 disables the correction.
   */
  fontScale?: number;
  romajiFontScale?: number;
}

/**
 * Generate a complete ASS script for the project.
 *
 * Every lyric line becomes its own Dialogue with an explicit `\pos`, and
 * wrapping is disabled. That keeps libass from re-flowing text and guarantees
 * the rendered layout matches the canvas preview, which positions lines the
 * same way.
 */
export function buildAssScript(project: LyricProject, options: AssBuildOptions): string {
  const { canvas, style } = project;
  const duration = options.duration;
  const romajiEnabled = !!project.romaji?.enabled && project.romaji.lines.length > 0;
  const romajiStyle: KaraokeStyle = { ...style, ...(project.romaji?.style ?? {}) };

  const fontScale = options.fontScale ?? 1;
  const romajiFontScale = options.romajiFontScale ?? fontScale;

  /** One `[V4+ Styles]` row. */
  const styleRow = (name: string, s: KaraokeStyle, scale: number) =>
    [
      `Style: ${name}`,
      s.fontFamily,
      Math.round(s.fontSize * scale),
      // PrimaryColour is the sung colour; SecondaryColour is what \kf sweeps
      // from. The alpha byte in each carries the corresponding opacity.
      toAssColor(s.sungColor, opacityToAssAlpha(s.sungAlpha ?? 100)),
      toAssColor(s.baseColor, opacityToAssAlpha(s.baseAlpha ?? 100)),
      toAssColor(s.outlineColor),
      toAssColor(s.shadowColor),
      s.bold ? -1 : 0,
      s.italic ? -1 : 0,
      0,
      0,
      Math.round(s.scaleX ?? 100),
      Math.round(s.scaleY ?? 100),
      s.letterSpacing,
      0,
      1,
      s.outlineWidth,
      s.shadowOffset,
      assAlignment(s),
      0,
      0,
      0,
      1,
    ].join(',');

  const header = [
    '[Script Info]',
    '; Generated by VibeSub karaoke studio',
    'ScriptType: v4.00+',
    `PlayResX: ${Math.round(canvas.width)}`,
    `PlayResY: ${Math.round(canvas.height)}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,' +
      ' BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,' +
      ' BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleRow('Lyric', style, fontScale),
    styleRow('Romaji', romajiStyle, romajiFontScale),
    // Annotations are plain text boxes: no karaoke, their own colours.
    [
      'Style: Note',
      style.fontFamily,
      Math.round(style.fontSize * fontScale),
      toAssColor('#FFFFFF'),
      toAssColor('#FFFFFF'),
      toAssColor('#000000'),
      toAssColor('#000000'),
      -1,
      0,
      0,
      0,
      100,
      100,
      0,
      0,
      1,
      3,
      0,
      7,
      0,
      0,
      0,
      1,
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  /**
   * Emit the events for one lyric track.
   *
   * Both tracks go through the same path — they differ only in their style,
   * panel and pre-measured layout — so the romaji row cannot drift away from the
   * main row in behaviour.
   */
  const trackEvents = (
    lines: KaraokeLine[],
    trackStyle: KaraokeStyle,
    panel: LyricProject['panel'],
    styleName: string,
    layout: AssBuildOptions['layout'],
    scale: number
  ) => {
    // Anchor X to the alignment edge so \pos matches how the canvas lays out.
    const alignedX = (line: KaraokeLine) => {
      let x = panel.x;
      if (trackStyle.align === 'center') x = panel.x + panel.width / 2;
      else if (trackStyle.align === 'right') x = panel.x + panel.width;
      return x + line.offsetX;
    };

    return lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.syllables.length > 0)
      .flatMap(({ line, index }) => {
        const appear = line.appearAt ?? 0;
        const disappear = line.disappearAt ?? duration;
        const placement = layout?.[index];
        // Drawn nowhere in the preview, so emitted nowhere here either.
        if (placement?.clipped) return [];
        const size = lineFontSize(line, trackStyle);
        const x = alignedX(line);

        const rows: AssRowPlacement[] = placement?.rows ?? [
          {
            y: panel.y + index * trackStyle.lineHeight,
            first: 0,
            end: line.syllables.length,
          },
        ];

        return rows
          .filter((row) => row.end > row.first)
          .map((row) => {
            const overrides: string[] = [
              `\\pos(${Math.round(x)},${Math.round(row.y + line.offsetY)})`,
            ];
            if (size !== trackStyle.fontSize) {
              overrides.push(`\\fs${Math.round(size * scale)}`);
            }

            const run = buildKaraokeRun(line, trackStyle, appear, row);
            const text = `{${overrides.join('')}}${run}`;
            return `Dialogue: 0,${toAssTime(appear)},${toAssTime(
              disappear
            )},${styleName},,0,0,0,,${text}`;
          });
      });
  };

  const events = trackEvents(
    project.lines,
    style,
    project.panel,
    'Lyric',
    options.layout,
    fontScale
  );
  const romajiEvents = romajiEnabled
    ? trackEvents(
        project.romaji.lines,
        romajiStyle,
        project.romaji.panel,
        'Romaji',
        options.romajiLayout,
        romajiFontScale
      )
    : [];

  // Layer 1 so annotations sit above the lyrics, matching the canvas order.
  const noteEvents = (project.annotations ?? [])
    .filter((note) => note.text.trim().length > 0)
    .map((note) => {
      // The event covers the whole time the box is up; the sweep covers only
      // the span it is sung over, with the lead-in held unsung in front of it.
      const sungFrom = note.appearAt ?? 0;
      const sungTo = note.disappearAt ?? duration;
      const { from: appear, to: disappear } = annotationWindow(note, duration);
      const an = note.align === 'center' ? 8 : note.align === 'right' ? 9 : 7;

      const baseAlpha = note.alpha ?? 100;
      const sungAlpha = note.sungAlpha ?? baseAlpha;

      const overrides = [
        `\\an${an}`,
        `\\pos(${Math.round(note.x)},${Math.round(note.y)})`,
        `\\fs${Math.round(note.fontSize * fontScale)}`,
        // Primary is the sung colour and secondary what the fill sweeps from,
        // the same convention the lyric rows use.
        `\\1c${toAssColorTag(note.sungColor ?? note.color)}`,
        `\\2c${toAssColorTag(note.color)}`,
        `\\1a${toAssAlphaTag(note.sungColor ? sungAlpha : baseAlpha)}`,
        `\\2a${toAssAlphaTag(baseAlpha)}`,
        `\\3c${toAssColorTag(note.outlineColor)}`,
        `\\bord${note.outlineWidth}`,
        `\\b${note.bold ? 1 : 0}`,
      ].join('');

      // With a sung colour the box fills across its span; without one it just
      // sits there in a single colour.
      const leadCs = Math.max(0, Math.round((sungFrom - appear) * 100));
      const sweepCs = Math.max(0, Math.round((sungTo - sungFrom) * 100));
      const body = note.sungColor
        ? `${leadCs > 0 ? `{\\k${leadCs}}${ZWSP}` : ''}{\\kf${sweepCs}}${escapeAssText(note.text)}`
        : escapeAssText(note.text);

      return `Dialogue: 1,${toAssTime(appear)},${toAssTime(
        disappear
      )},Note,,0,0,0,,{${overrides}}${body}`;
    });

  return [...header, ...events, ...romajiEvents, ...noteEvents, ''].join('\n');
}
