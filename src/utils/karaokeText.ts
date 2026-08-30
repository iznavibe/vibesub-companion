import { KaraokeLine, KaraokeSyllable } from '../types/karaoke';

const HANGUL_SYLLABLE = /[\uAC00-\uD7A3]/;
const HANGUL_JAMO = /[\u1100-\u11FF\u3130-\u318F]/;
/** Trailing marks that should ride along with the unit before them. */
const TRAILING_PUNCT = /[.,!?;:)\]}'"\u2019\u201D\u2026~]/;
/** Opening marks that belong to the unit that follows them. */
const LEADING_PUNCT = /[(\[{\u2018\u201C]/;

function isHangul(ch: string): boolean {
  return HANGUL_SYLLABLE.test(ch) || HANGUL_JAMO.test(ch);
}

/**
 * How Latin text is broken up.
 *
 * 'word' suits English lyrics, where a word is roughly a beat. 'romaji' splits
 * transliterated Japanese or Korean into mora-sized pieces, which is how those
 * are actually sung — "kimi" is two beats, not one.
 */
export type LatinMode = 'word' | 'romaji';

/** Consonant onsets in Hepburn-style romaji, longest first so digraphs win. */
const ROMAJI_ONSETS = [
  'sh', 'ch', 'ts', 'ky', 'gy', 'ny', 'hy', 'by', 'py', 'my', 'ry', 'dy', 'jy',
  'kw', 'gw', 'tt', 'kk', 'pp', 'ss', 'cc', 'mm', 'nn', 'rr', 'dd', 'gg', 'bb', 'zz',
  'k', 'g', 's', 'z', 'j', 't', 'd', 'n', 'h', 'f', 'b', 'p', 'm', 'y', 'r', 'w', 'v', 'l', 'c',
];
const VOWELS = 'aeiou';
/** Guarded so an empty string is not treated as a vowel — `''` is a substring of everything. */
const isVowel = (ch: string | undefined): boolean => !!ch && VOWELS.includes(ch);

/**
 * Split one romaji word into mora.
 *
 * Each piece is an optional consonant onset plus a vowel run, with two special
 * cases that matter when singing: a moraic "n" with no following vowel stands
 * alone, and a doubled consonant (the sokuon in "motto") closes the previous
 * mora rather than starting a new one.
 */
export function splitRomajiWord(word: string): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < word.length) {
    const rest = word.slice(i);
    const lower = rest.toLowerCase();

    // A doubled consonant belongs to the mora before it.
    const doubled = /^([kgstdpbcmnrzj])\1/.exec(lower);
    if (doubled && out.length > 0) {
      out[out.length - 1] += rest[0];
      i += 1;
      continue;
    }

    let onset = '';
    for (const candidate of ROMAJI_ONSETS) {
      if (lower.startsWith(candidate)) {
        onset = candidate;
        break;
      }
    }

    const afterOnset = lower.slice(onset.length);

    // "n" not followed by a vowel is its own mora.
    if (onset === 'n' && !isVowel(afterOnset[0])) {
      out.push(rest.slice(0, 1));
      i += 1;
      continue;
    }

    // Glide, as in "kyo".
    let glide = '';
    if (onset && onset.length === 1 && afterOnset.startsWith('y') && isVowel(afterOnset[1])) {
      glide = 'y';
    }

    let v = onset.length + glide.length;
    let vowels = '';
    while (v < lower.length && isVowel(lower[v])) {
      vowels += lower[v];
      v += 1;
    }

    if (vowels.length === 0) {
      // No vowel to anchor a mora: attach the stray letter and move on.
      const chunk = rest.slice(0, Math.max(1, onset.length));
      if (out.length > 0) out[out.length - 1] += chunk;
      else out.push(chunk);
      i += Math.max(1, onset.length);
      continue;
    }

    // A long vowel stays in one mora; two different vowels split ("ai" -> a, i).
    let take = 1;
    if (vowels.length > 1 && vowels[0] === vowels[1]) take = 2;

    const end = onset.length + glide.length + take;
    out.push(rest.slice(0, end));
    i += end;
  }

  return out.length > 0 ? out : [word];
}

/**
 * Split a lyric line into the units the sweep steps through.
 *
 * Korean is split per Hangul syllable block, since that is the unit actually
 * sung. Latin runs are kept whole as words by default — sweeping per Latin
 * letter gives far more taps than there are beats — or split into mora when
 * `latinMode` is 'romaji'. Spaces attach to the preceding unit so the sweep
 * travels across the gap rather than jumping it.
 */
export function segmentLyricLine(text: string, latinMode: LatinMode = 'word'): string[] {
  const chars = Array.from(text);
  const units: string[] = [];
  let latin = '';
  // Opening brackets and quotes wait here so they join the unit after them
  // rather than becoming an orphan block on the timing lane.
  let pending = '';

  const push = (unit: string) => {
    units.push(pending + unit);
    pending = '';
  };

  const flushLatin = () => {
    if (latin.length === 0) return;
    if (latinMode === 'romaji') {
      // Keep any trailing punctuation on the last mora rather than splitting it.
      const match = /^(.*?)([^A-Za-z]*)$/s.exec(latin)!;
      const [, word, tail] = match;
      const parts = word.length > 0 ? splitRomajiWord(word) : [];
      if (parts.length === 0) {
        push(latin);
      } else {
        parts.forEach((part, i) => push(i === parts.length - 1 ? part + tail : part));
      }
    } else {
      push(latin);
    }
    latin = '';
  };

  for (const ch of chars) {
    if (ch === ' ') {
      // Space belongs to the unit it follows.
      flushLatin();
      if (units.length > 0 && pending.length === 0) units[units.length - 1] += ' ';
      continue;
    }

    if (LEADING_PUNCT.test(ch)) {
      flushLatin();
      pending += ch;
      continue;
    }

    if (isHangul(ch)) {
      flushLatin();
      push(ch);
      continue;
    }

    if (TRAILING_PUNCT.test(ch)) {
      if (latin.length > 0) {
        latin += ch;
      } else if (units.length > 0 && pending.length === 0) {
        // Append before any trailing space this unit already collected.
        const last = units[units.length - 1];
        const hadSpace = last.endsWith(' ');
        units[units.length - 1] = hadSpace ? last.slice(0, -1) + ch + ' ' : last + ch;
      } else {
        latin += ch;
      }
      continue;
    }

    latin += ch;
  }

  flushLatin();
  // A dangling opener with nothing after it still has to appear somewhere.
  if (pending.length > 0) {
    if (units.length > 0) units[units.length - 1] += pending;
    else units.push(pending);
  }
  return units;
}

let lineCounter = 0;
function nextLineId(): string {
  lineCounter += 1;
  return `line-${Date.now().toString(36)}-${lineCounter}`;
}

function blankLine(raw: string, latinMode: LatinMode = 'word'): KaraokeLine {
  return {
    id: nextLineId(),
    syllables: segmentLyricLine(raw, latinMode).map<KaraokeSyllable>((t) => ({
      text: t,
      start: 0,
      end: 0,
    })),
    appearAt: null,
    disappearAt: null,
    offsetX: 0,
    offsetY: 0,
  };
}

/** Loose key for matching lines whose wording shifted slightly. */
function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The span a timed line occupies, or null if it was never timed. */
function timedSpan(line: KaraokeLine): { start: number; end: number } | null {
  const timed = line.syllables.filter((s) => s.end > s.start);
  if (timed.length === 0) return null;
  return {
    start: Math.min(...timed.map((s) => s.start)),
    end: Math.max(...timed.map((s) => s.end)),
  };
}

export interface ParseLyricResult {
  lines: KaraokeLine[];
  /** Timed lines whose text no longer appears anywhere in the block. */
  droppedTimedLines: string[];
}

/**
 * Rebuild lines from a block of lyrics while protecting timings already
 * entered.
 *
 * Matching runs in three passes, weakest last, because losing timing work is
 * far worse than reusing the wrong line:
 *   1. exact text, 2. case/whitespace-insensitive text, 3. same position in the
 * block. The positional pass is what keeps a line's timing when its wording is
 * corrected — the syllables are re-segmented from the new text and spread back
 * across the span the old line occupied.
 */
export function parseLyricBlockDetailed(
  block: string,
  existing: KaraokeLine[] = [],
  latinMode: LatinMode = 'word'
): ParseLyricResult {
  const rawLines = block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const available = existing.map((line, index) => ({ line, index, used: false }));
  const exact = new Map<string, number[]>();
  const loose = new Map<string, number[]>();

  available.forEach((entry, i) => {
    const text = lineText(entry.line);
    const push = (map: Map<string, number[]>, key: string) => {
      const bucket = map.get(key);
      if (bucket) bucket.push(i);
      else map.set(key, [i]);
    };
    push(exact, text);
    push(loose, normalizeKey(text));
  });

  const take = (map: Map<string, number[]>, key: string): number | null => {
    const bucket = map.get(key);
    if (!bucket) return null;
    while (bucket.length > 0) {
      const i = bucket.shift()!;
      if (!available[i].used) return i;
    }
    return null;
  };

  const claimed = new Array<number | null>(rawLines.length).fill(null);

  // Pass 1 and 2: text matches, which reuse the line wholesale.
  rawLines.forEach((raw, i) => {
    const hit = take(exact, raw);
    if (hit !== null) {
      available[hit].used = true;
      claimed[i] = hit;
    }
  });
  rawLines.forEach((raw, i) => {
    if (claimed[i] !== null) return;
    const hit = take(loose, normalizeKey(raw));
    if (hit !== null) {
      available[hit].used = true;
      claimed[i] = hit;
    }
  });

  const lines = rawLines.map((raw, i) => {
    const hit = claimed[i];
    if (hit !== null) {
      const existingLine = available[hit].line;
      // Same words: keep the line exactly as it was, timings included.
      if (lineText(existingLine) === raw) return existingLine;
      // Loose match: re-segment but hold on to the span and the id.
      const span = timedSpan(existingLine);
      const rebuilt = { ...blankLine(raw, latinMode), id: existingLine.id };
      return span ? distributeEvenly(rebuilt, span.start, span.end) : rebuilt;
    }

    // Pass 3: fall back to whatever sat at this position, if it is still free.
    const positional = available[i];
    if (positional && !positional.used) {
      const span = timedSpan(positional.line);
      if (span) {
        positional.used = true;
        const rebuilt = { ...blankLine(raw, latinMode), id: positional.line.id };
        return distributeEvenly(rebuilt, span.start, span.end);
      }
    }

    return blankLine(raw, latinMode);
  });

  const droppedTimedLines = available
    .filter((entry) => !entry.used && timedSpan(entry.line) !== null)
    .map((entry) => lineText(entry.line));

  return { lines, droppedTimedLines };
}

let blockCounter = 0;
export function nextBlockId(): string {
  blockCounter += 1;
  return `block-${Date.now().toString(36)}-${blockCounter}`;
}

/** Lines grouped by block, in the order the blocks first appear. */
export function groupIntoBlocks(lines: KaraokeLine[]): { id: string; lines: number[] }[] {
  const order: string[] = [];
  const map = new Map<string, number[]>();
  lines.forEach((line, i) => {
    // Lines from before blocks existed all belong to one implicit block.
    const id = line.blockId ?? '__default__';
    const bucket = map.get(id);
    if (bucket) bucket.push(i);
    else {
      map.set(id, [i]);
      order.push(id);
    }
  });
  return order.map((id) => ({ id, lines: map.get(id)! }));
}

/** When the first word of a block is sung — its cue, ignoring any lead-in. */
function blockCue(lines: KaraokeLine[], indices: number[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const i of indices) {
    for (const syl of lines[i].syllables) {
      if (syl.end > syl.start) best = Math.min(best, syl.start);
    }
  }
  if (Number.isFinite(best)) return best;
  // Never timed: fall back to whatever window it was given when created.
  for (const i of indices) {
    const a = lines[i].appearAt;
    if (a !== null && a !== undefined) best = Math.min(best, a);
  }
  return Number.isFinite(best) ? best : 0;
}

/** When the last word of a block finishes. */
function blockEnd(lines: KaraokeLine[], indices: number[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const i of indices) {
    for (const syl of lines[i].syllables) {
      if (syl.end > syl.start) best = Math.max(best, syl.end);
    }
  }
  return Number.isFinite(best) ? best : 0;
}

export interface BlockWindowOptions {
  /**
   * Seconds a block appears before its first word, so singers can read ahead.
   * Clamped so it can never overlap the block before it.
   */
  leadIn?: number;
  /**
   * Put the next block up the moment the previous one finishes singing, so the
   * screen is never empty. Useful across an intro or a dance break.
   */
  fillGaps?: boolean;
  /**
   * Seconds a block stays up after its last word before clearing.
   *
   * `null` keeps a block on screen until the next one arrives — which leaves the
   * final block up for the rest of the video. A number clears it that long after
   * it stops singing, so the screen empties over instrumental sections and at
   * the end.
   */
  holdOut?: number | null;
}

/**
 * Give every line the visibility window of the block it belongs to.
 *
 * A block stays on screen from its own start until the next block begins, so
 * the lyrics on the video change as the song moves through its verses rather
 * than accumulating. Blocks are ordered by start time, not by their position in
 * the list, so adding a block for an earlier part of the song still behaves.
 */
export function applyBlockWindows(
  lines: KaraokeLine[],
  options: BlockWindowOptions = {}
): KaraokeLine[] {
  const blocks = groupIntoBlocks(lines);
  if (blocks.length === 0) return lines;
  const leadIn = Math.max(0, options.leadIn ?? 0);
  const fillGaps = options.fillGaps === true;

  const ordered = blocks
    .map((b) => ({ ...b, cue: blockCue(lines, b.lines), end: blockEnd(lines, b.lines) }))
    .sort((a, b) => a.cue - b.cue);

  // A block may come up early, but never before the one before it has finished
  // singing — two blocks on screen at once would be unreadable.
  const appears = ordered.map((block, i) => {
    const floor = i === 0 ? 0 : Math.max(0, ordered[i - 1].end);
    if (fillGaps) return floor;
    return Math.max(floor, block.cue - leadIn);
  });

  const holdOut = options.holdOut ?? null;

  const windows = new Map<number, { from: number; to: number | null }>();
  ordered.forEach((block, i) => {
    const nextAppear = i + 1 < appears.length ? appears[i + 1] : null;
    let to: number | null = nextAppear;

    // An untimed block has no meaningful end, so it can only wait for the next.
    const hasTiming = block.end > 0;
    if (holdOut !== null && hasTiming) {
      const cleared = Math.max(block.end + holdOut, appears[i] + 0.05);
      to = nextAppear === null ? cleared : Math.min(nextAppear, cleared);
    }

    for (const lineIndex of block.lines) {
      windows.set(lineIndex, { from: appears[i], to });
    }
  });

  return lines.map((line, i) => {
    const w = windows.get(i);
    if (!w) return line;
    if (line.appearAt === w.from && line.disappearAt === w.to) return line;
    return { ...line, appearAt: w.from, disappearAt: w.to };
  });
}

/**
 * Copy one track's block windows onto another, pairing lines by index.
 *
 * The romaji row transliterates the line above it, so the two must appear and
 * disappear together. Deriving romaji windows from its own timings would let
 * the rows blink independently.
 */
export function syncTrackWindows(
  source: KaraokeLine[],
  target: KaraokeLine[]
): KaraokeLine[] {
  return target.map((line, i) => {
    const from = source[i];
    if (!from) {
      // No partner to inherit from. Deriving a window from the line's own
      // timings still beats leaving appearAt null, which reads as "visible from
      // the very first frame".
      if (line.appearAt !== null && line.appearAt !== undefined) return line;
      const span = timedSpan(line);
      return span ? { ...line, appearAt: span.start, disappearAt: span.end } : line;
    }
    if (
      line.appearAt === from.appearAt &&
      line.disappearAt === from.disappearAt &&
      line.blockId === from.blockId
    ) {
      return line;
    }
    return {
      ...line,
      blockId: from.blockId,
      appearAt: from.appearAt,
      disappearAt: from.disappearAt,
    };
  });
}

/**
 * A block lifted out with its timings made relative to its own start.
 *
 * Verses usually share a rhythm, so the useful thing to reuse is the shape of
 * the timing rather than the absolute times. Storing offsets means the block
 * can be dropped anywhere on the track and still sound right.
 */
export interface CopiedBlock {
  /** Lines of syllables, each timed relative to the block's first word. */
  lines: { text: string; syllables: { text: string; start: number; end: number }[] }[];
  /** Total length, so a caller can report or scale it. */
  span: number;
}

/** Lift the block containing `lineIndex` out, with timings made relative. */
export function copyBlock(lines: KaraokeLine[], lineIndex: number): CopiedBlock | null {
  const line = lines[lineIndex];
  if (!line) return null;
  const block = groupIntoBlocks(lines).find((b) => b.lines.includes(lineIndex));
  if (!block) return null;

  const members = block.lines.map((i) => lines[i]);
  const timed = members.flatMap((l) => l.syllables.filter((sy) => sy.end > sy.start));
  if (timed.length === 0) return null;

  const origin = Math.min(...timed.map((sy) => sy.start));
  const end = Math.max(...timed.map((sy) => sy.end));

  return {
    span: end - origin,
    lines: members.map((l) => ({
      text: lineText(l),
      syllables: l.syllables.map((sy) => ({
        text: sy.text,
        start: sy.start - origin,
        end: sy.end - origin,
      })),
    })),
  };
}

/**
 * Drop a copied block onto the track starting at `at`, as a new block.
 *
 * The words and the rhythm come across intact; only the position changes. This
 * is the "verse two is the same as verse one" case.
 */
export function pasteBlockAt(
  lines: KaraokeLine[],
  copied: CopiedBlock,
  at: number,
  options: BlockWindowOptions = {}
): KaraokeLine[] {
  const id = nextBlockId();
  const added: KaraokeLine[] = copied.lines.map((l) => ({
    id: nextLineId(),
    blockId: id,
    appearAt: at,
    disappearAt: null,
    offsetX: 0,
    offsetY: 0,
    syllables: l.syllables.map((sy) => ({
      text: sy.text,
      start: at + sy.start,
      end: at + sy.end,
    })),
  }));
  return applyBlockWindows([...lines, ...added], options);
}

/**
 * Retime an existing block using a copied block's rhythm, keeping its own words.
 *
 * Verses often share a cadence but not the wording. Where the syllable counts
 * match the offsets are copied across exactly; where they differ each syllable
 * takes the offset at the same relative position, which keeps the shape without
 * requiring the two to line up.
 */
export function applyTimingShape(
  lines: KaraokeLine[],
  lineIndex: number,
  copied: CopiedBlock,
  at: number,
  options: BlockWindowOptions = {}
): KaraokeLine[] {
  const block = groupIntoBlocks(lines).find((b) => b.lines.includes(lineIndex));
  if (!block || copied.lines.length === 0) return lines;

  const next = lines.map((l) => ({ ...l, syllables: l.syllables.map((sy) => ({ ...sy })) }));

  block.lines.forEach((target, row) => {
    // Fall back to the last copied row when the target block has more lines.
    const source = copied.lines[Math.min(row, copied.lines.length - 1)];
    if (!source || source.syllables.length === 0) return;

    const line = next[target];
    const count = line.syllables.length;
    line.syllables = line.syllables.map((sy, i) => {
      const pick =
        count === source.syllables.length
          ? source.syllables[i]
          : source.syllables[
              Math.min(
                source.syllables.length - 1,
                Math.round((i / Math.max(1, count - 1)) * (source.syllables.length - 1))
              )
            ];
      return { ...sy, start: at + pick.start, end: at + pick.end };
    });
  });

  return applyBlockWindows(next, options);
}

/**
 * Bring a project's visibility windows up to date.
 *
 * Called whenever a project is adopted, because a file saved before blocks (or
 * before romaji shared their windows) carries `appearAt: null` on some lines,
 * which reads as "visible from the first frame". Recomputing on load repairs
 * those rather than leaving them stuck on screen until something else happens
 * to touch them.
 */
export function normalizeTrackWindows(
  lines: KaraokeLine[],
  romajiLines: KaraokeLine[],
  options: BlockWindowOptions = {}
): { lines: KaraokeLine[]; romajiLines: KaraokeLine[] } {
  const windowed = applyBlockWindows(lines, options);
  return { lines: windowed, romajiLines: syncTrackWindows(windowed, romajiLines) };
}

/**
 * Append a block of lines after the ones already present, timed from `at`.
 *
 * This is the "paste the next verse" path: existing blocks are untouched, and
 * the new lines are laid out sequentially from the playhead so there is
 * something to drag straight away.
 */
export function appendBlock(
  existing: KaraokeLine[],
  block: string,
  at: number,
  latinMode: LatinMode = 'word',
  secondsPerSyllable = 0.33,
  options: BlockWindowOptions = {}
): KaraokeLine[] {
  const id = nextBlockId();
  let cursor = at;

  const added = parseLyricBlockDetailed(block, [], latinMode).lines.map((line) => {
    const span = Math.max(0.6, line.syllables.length * secondsPerSyllable);
    const placed = distributeEvenly({ ...line, blockId: id, appearAt: at }, cursor, cursor + span);
    cursor += span + 0.4;
    return placed;
  });

  return applyBlockWindows([...existing, ...added], options);
}

/** Convenience wrapper for callers that do not need the drop report. */
export function parseLyricBlock(
  block: string,
  existing: KaraokeLine[] = [],
  latinMode: LatinMode = 'word'
): KaraokeLine[] {
  return parseLyricBlockDetailed(block, existing, latinMode).lines;
}

/** Reassemble the display text of a line. */
export function lineText(line: KaraokeLine): string {
  return line.syllables.map((s) => s.text).join('').trim();
}

/** True once every syllable in the line has a real timing. */
export function isLineTimed(line: KaraokeLine): boolean {
  return line.syllables.length > 0 && line.syllables.every((s) => s.end > s.start);
}

/**
 * Longest common subsequence over syllable text, as index pairs.
 *
 * Used to work out which words survived an edit. Comparing on trimmed text
 * means a word keeps its timing even when the spacing around it changes.
 */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Rewrite a line's words while holding on to the timings you already set.
 *
 * Words that survive the edit keep their exact start, end and styling; words
 * you added are given time interpolated from the surviving words either side.
 * That is what makes it safe to fix a typo or add a word to a line you have
 * already timed, instead of having to time it again from scratch.
 */
/** Smallest span an inserted word is given, so it stays visible and grabbable. */
const MIN_INSERT = 0.12;

export function editLineText(
  line: KaraokeLine,
  newText: string,
  latinMode: LatinMode = 'word'
): KaraokeLine {
  const units = segmentLyricLine(newText, latinMode);
  if (units.length === 0) return { ...line, syllables: [] };

  const oldKeys = line.syllables.map((s) => s.text.trim());
  const newKeys = units.map((u) => u.trim());
  const pairs = lcsPairs(oldKeys, newKeys);

  const span = timedSpan(line);
  const syllables: KaraokeSyllable[] = units.map((text) => ({ text, start: 0, end: 0 }));

  // Carry across everything about a surviving word, not just its timing.
  const anchored = new Set<number>();
  for (const [oldIndex, newIndex] of pairs) {
    const src = line.syllables[oldIndex];
    syllables[newIndex] = { ...src, text: units[newIndex] };
    anchored.add(newIndex);
  }

  if (anchored.size === 0) {
    // Nothing recognisable survived; spread the new words over the old span.
    const from = span?.start ?? 0;
    const to = span?.end ?? from + Math.max(0.6, units.length * 0.33);
    return distributeEvenly({ ...line, syllables }, from, to);
  }

  // Fill each unanchored run by sharing the time between its neighbours.
  const anchorList = [...anchored].sort((x, y) => x - y);
  const firstAnchor = anchorList[0];
  const lastAnchor = anchorList[anchorList.length - 1];

  const fillRun = (from: number, to: number, startTime: number, endTime: number) => {
    const count = to - from;
    if (count <= 0) return;
    const step = (endTime - startTime) / count;
    for (let k = 0; k < count; k++) {
      const at = startTime + step * k;
      syllables[from + k] = { ...syllables[from + k], start: at, end: at + step };
    }
  };

  // Words added before the first survivor borrow time ahead of it.
  if (firstAnchor > 0) {
    const anchor = syllables[firstAnchor];
    const needed = MIN_INSERT * firstAnchor;
    let from = anchor.start - needed;
    if (from < 0) {
      // No room before the line starts: take it out of the first word instead,
      // which is better than leaving the new words with no duration at all.
      from = 0;
      const shrunk = Math.max(needed, Math.min(anchor.start + needed, anchor.end - MIN_DURATION));
      syllables[firstAnchor] = { ...anchor, start: shrunk };
    }
    fillRun(0, firstAnchor, from, syllables[firstAnchor].start);
  }

  for (let k = 0; k < anchorList.length - 1; k++) {
    const a = anchorList[k];
    const b = anchorList[k + 1];
    const count = b - a - 1;
    if (count <= 0) continue;

    const needed = MIN_INSERT * count;
    let gapStart = syllables[a].end;
    const gapEnd = syllables[b].start;

    // Words timed back to back leave no gap to insert into. Borrow from the
    // word before so the new words are actually draggable rather than
    // collapsing to zero width — but never shrink that word below a usable
    // size itself, and never run past the word after.
    if (gapEnd - gapStart < needed) {
      const floor = Math.min(syllables[a].start + MIN_INSERT, gapEnd);
      gapStart = Math.max(floor, Math.min(gapStart, gapEnd - needed));
      syllables[a] = { ...syllables[a], end: gapStart };
    }

    // Bounded by the next word, so blocks can never overlap. An over-packed
    // line ends up with narrow blocks rather than broken ones.
    fillRun(a + 1, b, gapStart, Math.max(gapStart, gapEnd));
  }

  // Words added after the last survivor extend past it.
  if (lastAnchor < syllables.length - 1) {
    const anchor = syllables[lastAnchor];
    const width = Math.max(0.12, (anchor.end - anchor.start) || 0.25);
    const trailing = syllables.length - 1 - lastAnchor;
    fillRun(lastAnchor + 1, syllables.length, anchor.end, anchor.end + width * trailing);
  }

  return { ...line, syllables };
}

/**
 * Split a line in two at `syllableIndex`, the second half becoming a new line
 * directly below it in the same block.
 */
export function splitLineAt(
  lines: KaraokeLine[],
  lineIndex: number,
  syllableIndex: number
): KaraokeLine[] {
  const line = lines[lineIndex];
  if (!line || syllableIndex <= 0 || syllableIndex >= line.syllables.length) return lines;

  const head: KaraokeLine = { ...line, syllables: line.syllables.slice(0, syllableIndex) };
  const tail: KaraokeLine = {
    ...line,
    id: nextLineId(),
    syllables: line.syllables.slice(syllableIndex),
  };
  return [...lines.slice(0, lineIndex), head, tail, ...lines.slice(lineIndex + 1)];
}

/** Join a line with the one after it, keeping both sets of timings. */
export function mergeLineWithNext(lines: KaraokeLine[], lineIndex: number): KaraokeLine[] {
  const line = lines[lineIndex];
  const next = lines[lineIndex + 1];
  if (!line || !next) return lines;

  // A line break swallows the space around it, so put one back.
  const head = [...line.syllables];
  const last = head[head.length - 1];
  if (last && !/\s$/.test(last.text)) head[head.length - 1] = { ...last, text: last.text + ' ' };

  const merged: KaraokeLine = { ...line, syllables: [...head, ...next.syllables] };
  return [...lines.slice(0, lineIndex), merged, ...lines.slice(lineIndex + 2)];
}

/** Merge syllable at `index` with the one after it, so they sweep as one unit. */
export function mergeSyllable(line: KaraokeLine, index: number): KaraokeLine {
  if (index < 0 || index >= line.syllables.length - 1) return line;
  const syllables = [...line.syllables];
  const a = syllables[index];
  const b = syllables[index + 1];
  syllables.splice(index, 2, {
    ...a,
    text: a.text + b.text,
    end: Math.max(a.end, b.end),
  });
  return { ...line, syllables };
}

/** Split syllable at `index` into two, breaking its text at `charOffset`. */
export function splitSyllable(line: KaraokeLine, index: number, charOffset: number): KaraokeLine {
  const target = line.syllables[index];
  if (!target) return line;
  const chars = Array.from(target.text);
  if (charOffset <= 0 || charOffset >= chars.length) return line;

  const leftText = chars.slice(0, charOffset).join('');
  const rightText = chars.slice(charOffset).join('');
  const mid = target.start + (target.end - target.start) / 2;

  const syllables = [...line.syllables];
  syllables.splice(
    index,
    1,
    { ...target, text: leftText, end: mid },
    { ...target, text: rightText, start: mid }
  );
  return { ...line, syllables };
}

/**
 * Distribute timings evenly across a line's syllables. Used to seed a line
 * before tapping, and as the "good enough" fallback for lines never tapped.
 */
export function distributeEvenly(line: KaraokeLine, start: number, end: number): KaraokeLine {
  const n = line.syllables.length;
  if (n === 0) return line;
  const step = (end - start) / n;
  return {
    ...line,
    syllables: line.syllables.map((s, i) => ({
      ...s,
      start: start + i * step,
      end: start + (i + 1) * step,
    })),
  };
}

/**
 * Shift every timing in a line by `delta` seconds. Negative values pull the
 * line earlier. Clamped so nothing lands before zero.
 */
export function shiftLine(line: KaraokeLine, delta: number): KaraokeLine {
  const earliest = Math.min(...line.syllables.map((s) => s.start));
  const clamped = Math.max(delta, -earliest);
  return {
    ...line,
    syllables: line.syllables.map((s) => ({
      ...s,
      start: s.start + clamped,
      end: s.end + clamped,
    })),
  };
}

const MIN_DURATION = 0.02;

/** Default magnet distance, in seconds, for snapping a dragged edge. */
export const SNAP_SECONDS = 0.06;

/**
 * Move one edge of one syllable.
 *
 * Only the dragged edge moves. Gaps between syllables are meaningful — a pause
 * in the vocal should stay a pause — so neighbours are never dragged along;
 * the edge is simply clamped so it cannot cross them or invert its own
 * syllable.
 *
 * When `snap` is on and the edge lands within `snapWindow` of the neighbouring
 * edge, it latches exactly onto it, which is how you close a gap deliberately
 * rather than by pixel-hunting.
 */
export function setSyllableBoundary(
  line: KaraokeLine,
  index: number,
  edge: 'start' | 'end',
  time: number,
  options: { snap?: boolean; snapWindow?: number; snapTargets?: number[] } = {}
): KaraokeLine {
  const syllables = line.syllables.map((s) => ({ ...s }));
  const target = syllables[index];
  if (!target) return line;

  const { snap = true, snapWindow = SNAP_SECONDS, snapTargets = [] } = options;
  const prev = syllables[index - 1];
  const next = syllables[index + 1];

  // Candidate magnets: the adjacent edge, plus anything the caller supplied
  // (waveform onsets, the playhead).
  const magnets = [...snapTargets];
  if (edge === 'start' && prev) magnets.push(prev.end);
  if (edge === 'end' && next) magnets.push(next.start);

  let t = time;
  if (snap && magnets.length > 0) {
    let bestDelta = snapWindow;
    let bestValue: number | null = null;
    for (const m of magnets) {
      const d = Math.abs(m - t);
      if (d <= bestDelta) {
        bestDelta = d;
        bestValue = m;
      }
    }
    if (bestValue !== null) t = bestValue;
  }

  if (edge === 'start') {
    const floor = prev ? prev.end : 0;
    target.start = Math.max(floor, Math.min(t, target.end - MIN_DURATION));
  } else {
    const ceiling = next ? next.start : Number.POSITIVE_INFINITY;
    target.end = Math.min(ceiling, Math.max(t, target.start + MIN_DURATION));
  }

  return { ...line, syllables };
}

/** Move a whole syllable, keeping its length, without disturbing neighbours. */
export function moveSyllable(
  line: KaraokeLine,
  index: number,
  newStart: number
): KaraokeLine {
  return moveSyllables(line, [{ index, start: newStart }]);
}

/**
 * Move several syllables at once, keeping each one's length.
 *
 * The group is clamped as a unit rather than per syllable: the whole selection
 * shifts by the largest amount that keeps every member inside the gap left by
 * the syllables that are not moving. Clamping individually would let a
 * multi-block drag silently change the spacing inside the selection.
 */
export function moveSyllables(
  line: KaraokeLine,
  targets: { index: number; start: number }[]
): KaraokeLine {
  if (targets.length === 0) return line;
  const syllables = line.syllables.map((s) => ({ ...s }));
  const moving = new Set(targets.map((t) => t.index));

  let minDelta = Number.NEGATIVE_INFINITY;
  let maxDelta = Number.POSITIVE_INFINITY;

  for (const { index, start } of targets) {
    const syl = syllables[index];
    if (!syl) continue;
    const length = syl.end - syl.start;
    const wanted = start - syl.start;

    // Nearest fixed neighbour on each side bounds how far this one can travel.
    let floor = 0;
    for (let i = index - 1; i >= 0; i--) {
      if (!moving.has(i)) {
        floor = syllables[i].end;
        break;
      }
    }
    let ceiling = Number.POSITIVE_INFINITY;
    for (let i = index + 1; i < syllables.length; i++) {
      if (!moving.has(i)) {
        ceiling = syllables[i].start;
        break;
      }
    }

    minDelta = Math.max(minDelta, floor - syl.start);
    maxDelta = Math.min(maxDelta, ceiling - length - syl.start);
    // Every target carries the same intended delta; keep the first as reference.
    if (!Number.isFinite(minDelta)) minDelta = wanted;
  }

  const intended = targets[0].start - (syllables[targets[0].index]?.start ?? 0);
  const delta = Math.max(minDelta, Math.min(intended, maxDelta));
  if (!Number.isFinite(delta)) return line;

  for (const { index } of targets) {
    const syl = syllables[index];
    if (!syl) continue;
    const length = syl.end - syl.start;
    syl.start += delta;
    syl.end = syl.start + length;
  }

  return { ...line, syllables };
}

/**
 * A syllable addressed across the whole project.
 *
 * `track` is 0 for the main lyrics and 1 for the romaji beneath them, so one
 * selection can hold blocks from both and move them together.
 */
export interface SyllableRef {
  track: number;
  line: number;
  syllable: number;
}

/** The lyric lines of each track, main first. */
export type TrackLines = KaraokeLine[][];

/** Group refs by track and line, so each line is visited once. */
function groupRefs(refs: SyllableRef[]): Map<string, { track: number; line: number; set: Set<number> }> {
  const map = new Map<string, { track: number; line: number; set: Set<number> }>();
  for (const ref of refs) {
    const key = `${ref.track}:${ref.line}`;
    const entry = map.get(key);
    if (entry) entry.set.add(ref.syllable);
    else map.set(key, { track: ref.track, line: ref.line, set: new Set([ref.syllable]) });
  }
  return map;
}

/**
 * Shift a selection that may span several lines by one common delta.
 *
 * The delta is clamped once, against the tightest constraint found anywhere in
 * the selection, then applied to every member. Clamping per line would let the
 * lines drift apart from each other, which defeats the point of dragging them
 * as a group.
 */
export function moveSelection(
  tracks: TrackLines,
  refs: SyllableRef[],
  delta: number
): TrackLines {
  if (refs.length === 0 || delta === 0) return tracks;
  const grouped = groupRefs(refs);

  let minDelta = Number.NEGATIVE_INFINITY;
  let maxDelta = Number.POSITIVE_INFINITY;

  for (const { track, line: lineIndex, set: moving } of grouped.values()) {
    const line = tracks[track]?.[lineIndex];
    if (!line) continue;
    for (const index of moving) {
      const syl = line.syllables[index];
      if (!syl) continue;
      const length = syl.end - syl.start;

      let floor = 0;
      for (let i = index - 1; i >= 0; i--) {
        if (!moving.has(i)) {
          floor = line.syllables[i].end;
          break;
        }
      }
      let ceiling = Number.POSITIVE_INFINITY;
      for (let i = index + 1; i < line.syllables.length; i++) {
        if (!moving.has(i)) {
          ceiling = line.syllables[i].start;
          break;
        }
      }

      minDelta = Math.max(minDelta, floor - syl.start);
      maxDelta = Math.min(maxDelta, ceiling - length - syl.start);
    }
  }

  const applied = Math.max(minDelta, Math.min(delta, maxDelta));
  if (!Number.isFinite(applied) || applied === 0) return tracks;

  return tracks.map((lines, track) =>
    lines.map((line, lineIndex) => {
      const entry = grouped.get(`${track}:${lineIndex}`);
      if (!entry) return line;
      return {
        ...line,
        syllables: line.syllables.map((syl, i) => {
          if (!entry.set.has(i)) return syl;
          const length = syl.end - syl.start;
          return { ...syl, start: syl.start + applied, end: syl.start + applied + length };
        }),
      };
    })
  );
}

/**
 * Remove the selected syllables entirely.
 *
 * A line left with no syllables is dropped, since an empty lyric line has
 * nothing to show or time. The caller is responsible for re-syncing any text
 * box that mirrors these lines.
 */
export function deleteSelection(tracks: TrackLines, refs: SyllableRef[]): TrackLines {
  if (refs.length === 0) return tracks;
  const grouped = groupRefs(refs);

  return tracks.map((lines, track) =>
    lines
      .map((line, lineIndex) => {
        const entry = grouped.get(`${track}:${lineIndex}`);
        if (!entry) return line;
        return {
          ...line,
          syllables: line.syllables.filter((_, i) => !entry.set.has(i)),
        };
      })
      .filter((line) => line.syllables.length > 0)
  );
}

/** Pull every syllable flush against the previous one, removing all gaps. */
export function closeGaps(line: KaraokeLine): KaraokeLine {
  const syllables = line.syllables.map((s) => ({ ...s }));
  for (let i = 1; i < syllables.length; i++) {
    syllables[i].start = syllables[i - 1].end;
    if (syllables[i].end < syllables[i].start + MIN_DURATION) {
      syllables[i].end = syllables[i].start + MIN_DURATION;
    }
  }
  return { ...line, syllables };
}
