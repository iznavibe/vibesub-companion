import { KaraokeLine, KaraokeStyle, LyricProject } from '../types/karaoke';
import { lineText } from '../utils/karaokeText';
import { isTauri } from './tauriService';

const FORMAT = 'vibesub-lyrics';
const VERSION = 1;

/**
 * A portable set of timed lyrics.
 *
 * Deliberately carries timings and per-word styling but not the video, canvas
 * or panel geometry: the point is to reuse the words and their timing over
 * different footage, and importing must not drag another project's layout in
 * with it. Style is optional so a set can carry a look when you want one.
 */
export interface LyricSet {
  format: typeof FORMAT;
  version: number;
  name: string;
  exportedAt: string;
  /** Informational: the duration the timings were made against. */
  sourceDuration: number;
  latinMode: 'word' | 'romaji';
  lines: KaraokeLine[];
  style?: KaraokeStyle;
}

export function buildLyricSet(project: LyricProject, includeStyle: boolean): LyricSet {
  return {
    format: FORMAT,
    version: VERSION,
    name: project.name,
    exportedAt: new Date().toISOString(),
    sourceDuration: project.duration,
    latinMode: project.latinMode ?? 'word',
    lines: project.lines,
    style: includeStyle ? project.style : undefined,
  };
}

export function serializeLyricSet(set: LyricSet): string {
  return JSON.stringify(set, null, 2);
}

/** Parse and validate a lyric set, with messages aimed at the person pasting it. */
export function parseLyricSet(text: string): LyricSet {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That is not valid JSON — paste the whole file contents.');
  }

  const set = raw as Partial<LyricSet>;
  if (set?.format !== FORMAT) {
    throw new Error('That file is not a VibeSub lyric set.');
  }
  if (typeof set.version !== 'number' || set.version > VERSION) {
    throw new Error(
      `That set was written by a newer version of VibeSub (v${set.version}). Update and try again.`
    );
  }
  if (!Array.isArray(set.lines)) {
    throw new Error('That lyric set has no lines in it.');
  }

  // Rebuild ids so importing the same set twice cannot collide.
  const stamp = Date.now().toString(36);
  const lines: KaraokeLine[] = set.lines.map((line, i) => ({
    ...line,
    id: `imported-${stamp}-${i}`,
    syllables: (line.syllables ?? []).map((s) => ({ ...s })),
    appearAt: line.appearAt ?? null,
    disappearAt: line.disappearAt ?? null,
    offsetX: line.offsetX ?? 0,
    offsetY: line.offsetY ?? 0,
  }));

  return {
    format: FORMAT,
    version: set.version,
    name: set.name ?? 'Imported lyrics',
    exportedAt: set.exportedAt ?? new Date().toISOString(),
    sourceDuration: set.sourceDuration ?? 0,
    latinMode: set.latinMode === 'romaji' ? 'romaji' : 'word',
    lines,
    style: set.style,
  };
}

/**
 * Rescale a set's timings from the duration it was made against onto a new one.
 * Only sensible when the two are different cuts of the same performance, so the
 * caller decides whether to offer it.
 */
export function rescaleLyricSet(lines: KaraokeLine[], factor: number): KaraokeLine[] {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return lines;
  return lines.map((line) => ({
    ...line,
    appearAt: line.appearAt === null ? null : line.appearAt * factor,
    disappearAt: line.disappearAt === null ? null : line.disappearAt * factor,
    syllables: line.syllables.map((s) => ({
      ...s,
      start: s.start * factor,
      end: s.end * factor,
    })),
  }));
}

/** Plain text of the lyrics, for pasting somewhere that is not VibeSub. */
export function lyricsAsPlainText(project: LyricProject): string {
  return project.lines.map(lineText).join('\n');
}

export async function copyLyricSetToClipboard(
  project: LyricProject,
  includeStyle: boolean
): Promise<void> {
  const text = serializeLyricSet(buildLyricSet(project, includeStyle));
  await navigator.clipboard.writeText(text);
}

export async function readLyricSetFromClipboard(): Promise<LyricSet> {
  const text = await navigator.clipboard.readText();
  if (!text.trim()) throw new Error('The clipboard is empty.');
  return parseLyricSet(text);
}

export async function saveLyricSetToFile(
  project: LyricProject,
  includeStyle: boolean
): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');

  const path = await save({
    title: 'Export lyrics',
    defaultPath: `${project.name}.vibelyrics.json`,
    filters: [{ name: 'VibeSub lyrics', extensions: ['json'] }],
  });
  if (!path) return null;

  await writeTextFile(path, serializeLyricSet(buildLyricSet(project, includeStyle)));
  return path;
}

export async function loadLyricSetFromFile(): Promise<LyricSet | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const { readTextFile } = await import('@tauri-apps/plugin-fs');

  const selected = await open({
    title: 'Import lyrics',
    multiple: false,
    filters: [{ name: 'VibeSub lyrics', extensions: ['json'] }],
  });
  if (typeof selected !== 'string') return null;

  return parseLyricSet(await readTextFile(selected));
}
