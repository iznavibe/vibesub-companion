import { KaraokeStyle } from '../types/karaoke';
import { isTauri } from './tauriService';

const FILE = 'color-presets.json';
const VERSION = 1;

/**
 * A named colour scheme for lyric text.
 *
 * Stored outside any project, because the point is to reuse a look across
 * them — a fanchant pink you reach for every time, a different scheme for
 * another group.
 */
export interface ColorPreset {
  id: string;
  name: string;
  baseColor: string;
  sungColor: string;
  baseAlpha: number;
  sungAlpha: number;
}

export interface ColorPresetStore {
  version: number;
  presets: ColorPreset[];
  /** Applied to new projects. Null means "leave the built-in defaults alone". */
  defaultId: string | null;
}

const EMPTY: ColorPresetStore = { version: VERSION, presets: [], defaultId: null };

/** Ships with something usable so the feature is not an empty list on day one. */
const BUILT_IN: ColorPreset[] = [
  {
    id: 'builtin-fanchant',
    name: 'Fanchant pink',
    baseColor: '#F257B7',
    sungColor: '#F9C2E6',
    baseAlpha: 55,
    sungAlpha: 100,
  },
  {
    id: 'builtin-classic',
    name: 'White to gold',
    baseColor: '#FFFFFF',
    sungColor: '#F5D64B',
    baseAlpha: 100,
    sungAlpha: 100,
  },
];

function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `preset-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

async function filePath(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  return join(await appDataDir(), 'vibesub-companion', FILE);
}

export async function loadColorPresets(): Promise<ColorPresetStore> {
  if (!isTauri()) return { ...EMPTY, presets: BUILT_IN };
  try {
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    const path = await filePath();
    if (!(await exists(path))) return { ...EMPTY, presets: BUILT_IN };

    const parsed = JSON.parse(await readTextFile(path)) as Partial<ColorPresetStore>;
    const saved = Array.isArray(parsed.presets) ? parsed.presets : [];
    // Built-ins are always offered, but a saved copy of the same id wins so an
    // edited built-in keeps the user's version.
    const savedIds = new Set(saved.map((p) => p.id));
    return {
      version: VERSION,
      presets: [...saved, ...BUILT_IN.filter((p) => !savedIds.has(p.id))],
      defaultId: parsed.defaultId ?? null,
    };
  } catch (err) {
    console.warn('Could not read colour presets:', err);
    return { ...EMPTY, presets: BUILT_IN };
  }
}

export async function saveColorPresets(store: ColorPresetStore): Promise<void> {
  if (!isTauri()) return;
  const { writeTextFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
  const { appDataDir, join } = await import('@tauri-apps/api/path');

  const dir = await join(await appDataDir(), 'vibesub-companion');
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await writeTextFile(await filePath(), JSON.stringify({ ...store, version: VERSION }, null, 2));
}

/** Capture the colours currently in use as a new named preset. */
export function presetFromStyle(name: string, style: KaraokeStyle): ColorPreset {
  return {
    id: newId(),
    name: name.trim() || 'Untitled',
    baseColor: style.baseColor,
    sungColor: style.sungColor,
    baseAlpha: style.baseAlpha ?? 100,
    sungAlpha: style.sungAlpha ?? 100,
  };
}

/**
 * A new, empty preset: named, and black until its colours are set.
 *
 * Naming first and then dialling the colours in on the preset itself is the
 * natural order — you know what you are making before you know its exact shade.
 */
export function blankPreset(name: string): ColorPreset {
  return {
    id: newId(),
    name: name.trim() || 'Untitled',
    baseColor: '#000000',
    sungColor: '#000000',
    baseAlpha: 100,
    sungAlpha: 100,
  };
}

/** Just the colour fields, for applying onto a style or a single word. */
export function presetToStyle(preset: ColorPreset): Partial<KaraokeStyle> {
  return {
    baseColor: preset.baseColor,
    sungColor: preset.sungColor,
    baseAlpha: preset.baseAlpha,
    sungAlpha: preset.sungAlpha,
  };
}
