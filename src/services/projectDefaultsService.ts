import { KaraokeStyle, LyricProject, KaraokePanel, FontAsset } from '../types/karaoke';
import { isTauri } from './tauriService';

const FILE = 'project-defaults.json';
const VERSION = 1;

/**
 * The look and layout a new project starts from.
 *
 * Only presentation is captured — never words, timings or media. Panel geometry
 * is stored alongside the canvas it was measured on so it can be scaled onto a
 * project of a different resolution rather than landing in the wrong place.
 */
export interface ProjectDefaults {
  version: number;
  canvas: { width: number; height: number; fps: number };
  style: KaraokeStyle;
  panel: KaraokePanel;
  romaji: {
    enabled: boolean;
    panel: KaraokePanel;
    style: Partial<KaraokeStyle>;
  };
  blockLeadIn: number;
  blockFillGaps: boolean;
  blockHoldOut: number | null;
  latinMode: 'word' | 'romaji';
  backgroundColor: string;
  /** Remembered so a habitual font is reloaded without hunting for it again. */
  fonts: FontAsset[];
}

async function filePath(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  return join(await appDataDir(), 'vibesub-companion', FILE);
}

/** Capture everything about how a project looks, and nothing about its content. */
export function defaultsFromProject(project: LyricProject): ProjectDefaults {
  return {
    version: VERSION,
    canvas: { ...project.canvas },
    style: { ...project.style },
    panel: { ...project.panel },
    romaji: {
      enabled: !!project.romaji?.enabled,
      panel: { ...(project.romaji?.panel ?? project.panel) },
      style: { ...(project.romaji?.style ?? {}) },
    },
    blockLeadIn: project.blockLeadIn ?? 0,
    blockFillGaps: project.blockFillGaps ?? false,
    blockHoldOut: project.blockHoldOut === undefined ? 1.5 : project.blockHoldOut,
    latinMode: project.latinMode ?? 'word',
    backgroundColor: project.background.color,
    fonts: project.fonts ?? [],
  };
}

function scaleRect(r: KaraokePanel, factor: number): KaraokePanel {
  if (factor === 1) return { ...r };
  return {
    ...r,
    x: Math.round(r.x * factor),
    y: Math.round(r.y * factor),
    width: Math.round(r.width * factor),
    height: Math.round(r.height * factor),
  };
}

function scaleStyle<T extends Partial<KaraokeStyle>>(st: T, factor: number): T {
  if (factor === 1) return { ...st };
  return {
    ...st,
    ...(st.fontSize !== undefined
      ? { fontSize: Math.max(6, Math.round(st.fontSize * factor)) }
      : {}),
    ...(st.lineHeight !== undefined
      ? { lineHeight: Math.max(6, Math.round(st.lineHeight * factor)) }
      : {}),
    ...(st.outlineWidth !== undefined
      ? { outlineWidth: Math.round(st.outlineWidth * factor * 10) / 10 }
      : {}),
    ...(st.shadowOffset !== undefined
      ? { shadowOffset: Math.round(st.shadowOffset * factor * 10) / 10 }
      : {}),
  };
}

/**
 * Lay the saved defaults over a project.
 *
 * Sizes are scaled by the ratio between the canvas the defaults were captured
 * on and the project's own, so a 4K layout still lands correctly on a 1080p
 * project. Content is never touched.
 */
export function applyDefaults(project: LyricProject, d: ProjectDefaults): LyricProject {
  const factor = project.canvas.width / Math.max(1, d.canvas.width);

  return {
    ...project,
    canvas: { ...project.canvas, fps: d.canvas.fps || project.canvas.fps },
    style: { ...scaleStyle(d.style, factor) } as KaraokeStyle,
    panel: scaleRect(d.panel, factor),
    romaji: {
      ...project.romaji,
      enabled: d.romaji.enabled,
      panel: scaleRect(d.romaji.panel, factor),
      style: scaleStyle(d.romaji.style, factor),
    },
    blockLeadIn: d.blockLeadIn,
    blockFillGaps: d.blockFillGaps,
    blockHoldOut: d.blockHoldOut,
    latinMode: d.latinMode,
    background: { ...project.background, color: d.backgroundColor },
    fonts: d.fonts.length > 0 ? d.fonts : project.fonts,
  };
}

export async function loadProjectDefaults(): Promise<ProjectDefaults | null> {
  if (!isTauri()) return null;
  try {
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    const path = await filePath();
    if (!(await exists(path))) return null;
    const parsed = JSON.parse(await readTextFile(path)) as ProjectDefaults;
    return parsed?.style && parsed?.panel ? parsed : null;
  } catch (err) {
    console.warn('Could not read project defaults:', err);
    return null;
  }
}

export async function saveProjectDefaults(d: ProjectDefaults): Promise<void> {
  if (!isTauri()) return;
  const { writeTextFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const dir = await join(await appDataDir(), 'vibesub-companion');
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await writeTextFile(await filePath(), JSON.stringify(d, null, 2));
}

export async function clearProjectDefaults(): Promise<void> {
  if (!isTauri()) return;
  const { remove, exists } = await import('@tauri-apps/plugin-fs');
  const path = await filePath();
  if (await exists(path)) await remove(path);
}
