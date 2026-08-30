import { FontAsset } from '../types/karaoke';
import { isTauri } from './tauriService';

/** Families already handed to the document, so repeat loads are cheap. */
const registered = new Map<string, Promise<void>>();

/**
 * Read the family name out of a font file's `name` table.
 *
 * The filename is a poor guide — "Maplestory OTF Bold.otf" declares the family
 * "Maplestory OTF" with subfamily "Bold" — and the family is what both the
 * canvas and libass look the font up by, so it has to come from the file.
 */
export function readFontFamily(buffer: ArrayBuffer): string | null {
  try {
    const view = new DataView(buffer);
    const numTables = view.getUint16(4);
    let nameOffset = -1;

    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(
        view.getUint8(rec),
        view.getUint8(rec + 1),
        view.getUint8(rec + 2),
        view.getUint8(rec + 3)
      );
      if (tag === 'name') {
        nameOffset = view.getUint32(rec + 8);
        break;
      }
    }
    if (nameOffset < 0) return null;

    const count = view.getUint16(nameOffset + 2);
    const stringOffset = view.getUint16(nameOffset + 4);

    // Prefer the typographic family (16) over the legacy one (1): for a family
    // with several weights, 1 can be split per weight while 16 stays whole.
    const found = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      const rec = nameOffset + 6 + i * 12;
      const platformId = view.getUint16(rec);
      const nameId = view.getUint16(rec + 6);
      const length = view.getUint16(rec + 8);
      const offset = view.getUint16(rec + 10);
      if (nameId !== 1 && nameId !== 16) continue;

      const start = nameOffset + stringOffset + offset;
      let value = '';
      if (platformId === 3) {
        for (let j = 0; j < length; j += 2) value += String.fromCharCode(view.getUint16(start + j));
      } else {
        for (let j = 0; j < length; j++) value += String.fromCharCode(view.getUint8(start + j));
      }
      if (value && !found.has(nameId)) found.set(nameId, value);
    }

    return found.get(16) ?? found.get(1) ?? null;
  } catch {
    return null;
  }
}

/** Load a font file from disk and make it available to the canvas preview. */
export async function loadFontFromPath(
  path: string,
  fileName: string
): Promise<FontAsset | null> {
  if (!isTauri()) return null;
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(path);
  // Copy into a plain ArrayBuffer: the view may sit inside a larger buffer.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;

  const family = readFontFamily(buffer) ?? fileName.replace(/\.[^.]+$/, '');
  await registerFontFace(family, buffer);
  return { family, path, fileName };
}

async function registerFontFace(family: string, buffer: ArrayBuffer): Promise<void> {
  const existing = registered.get(family);
  if (existing) return existing;

  const task = (async () => {
    const face = new FontFace(family, buffer);
    await face.load();
    document.fonts.add(face);
  })();

  registered.set(family, task);
  try {
    await task;
  } catch (err) {
    registered.delete(family);
    throw err;
  }
}

/** Re-register every font a project depends on, e.g. after it is reopened. */
export async function loadProjectFonts(fonts: FontAsset[]): Promise<FontAsset[]> {
  if (!isTauri() || fonts.length === 0) return [];
  const loaded: FontAsset[] = [];
  for (const font of fonts) {
    if (registered.has(font.family)) {
      loaded.push(font);
      continue;
    }
    try {
      const asset = await loadFontFromPath(font.path, font.fileName);
      if (asset) loaded.push(asset);
    } catch (err) {
      // A moved or deleted font should not stop the project from opening.
      console.warn(`Could not load font ${font.fileName}:`, err);
    }
  }
  return loaded;
}
