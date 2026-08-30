import { LyricProject } from '../types/karaoke';
import { buildAssScript } from '../utils/assExport';
import { drawBackground, planLayout, BackgroundSource } from '../utils/karaokeRenderer';
import { isTauri } from './tauriService';

/**
 * Measure the project's wrapping on an offscreen canvas at output resolution.
 *
 * The exporter has no way to measure text itself, so the same routine the
 * preview uses decides where lines break and where each row sits, and the ASS
 * script just replays that. It is the only reason preview and render agree.
 */
function measureLayout(project: LyricProject) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.min(project.canvas.width, 4096));
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { layout: undefined, romajiLayout: undefined };
  return {
    layout: planLayout(ctx, project, 0),
    romajiLayout: project.romaji?.enabled ? planLayout(ctx, project, 1) : undefined,
  };
}

export interface FfmpegInfo {
  found: boolean;
  path: string;
  version: string;
  hasLibass: boolean;
  hasNvenc: boolean;
}

export interface RenderProgress {
  frame: number;
  totalFrames: number;
  fps: number;
  secondsDone: number;
  speed: string;
}

export interface RenderOptions {
  outputPath: string;
  ffmpegPath?: string;
  encoder?: 'libx264' | 'h264_nvenc';
  crf?: number;
  onProgress?: (p: RenderProgress) => void;
}

export async function checkFfmpeg(overridePath?: string): Promise<FfmpegInfo> {
  if (!isTauri()) {
    return { found: false, path: '', version: '', hasLibass: false, hasNvenc: false };
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<FfmpegInfo>('check_ffmpeg', { overridePath: overridePath ?? null });
}

/**
 * Directory for the intermediate .ass and background PNG.
 *
 * This deliberately uses Tauri's own `appDataDir` rather than the Rust
 * `get_app_data_dir` command: the two resolve to different roots
 * (`…/com.vibesub.app` vs `…/vibesub-companion`), and only the former is inside
 * the `$APPDATA` filesystem scope the app is granted. Project files already
 * live under the same root.
 */
async function ensureWorkDir(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const { mkdir, exists } = await import('@tauri-apps/plugin-fs');
  const dir = await join(await appDataDir(), 'vibesub-companion', 'karaoke-render');
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Copy the project's font files into a folder beside the script, and hand that
 * back as the libass `fontsdir`. Returns null when the project uses only fonts
 * the system already has.
 */
async function stageFonts(project: LyricProject, workDir: string): Promise<string | null> {
  const fonts = project.fonts ?? [];
  if (fonts.length === 0) return null;

  const { mkdir, exists, copyFile } = await import('@tauri-apps/plugin-fs');
  const dir = `${workDir}/fonts`;
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });

  let staged = 0;
  for (const font of fonts) {
    try {
      await copyFile(font.path, `${dir}/${font.fileName}`);
      staged++;
    } catch (err) {
      // A missing font falls back to whatever fontconfig resolves.
      console.warn(`Could not stage font ${font.fileName}:`, err);
    }
  }
  return staged > 0 ? dir : null;
}

/**
 * Flatten the background — colour field plus artwork — to a PNG at full output
 * resolution. Doing this in the same renderer the preview uses is what keeps
 * the export honest: ffmpeg only ever composites text over this image.
 */
async function renderBackgroundPng(
  project: LyricProject,
  media: BackgroundSource | null
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = project.canvas.width;
  canvas.height = project.canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas for the background');

  drawBackground(ctx, project, media);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  );
  if (!blob) throw new Error('Could not encode the background image');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Render the finished lyric video.
 *
 * The frontend writes the ASS script and the flattened background, then hands
 * ffmpeg the compositing job. Text is drawn by libass rather than piped frame
 * by frame, so a 4K render costs roughly what a plain re-encode costs.
 */
export async function renderLyricVideo(
  project: LyricProject,
  media: BackgroundSource | null,
  options: RenderOptions
): Promise<string> {
  if (!isTauri()) {
    throw new Error('Rendering is only available in the desktop app.');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  const { writeTextFile, writeFile } = await import('@tauri-apps/plugin-fs');
  const { listen } = await import('@tauri-apps/api/event');

  const duration = project.duration;
  if (!(duration > 0)) {
    throw new Error('Set a duration — load an audio track, or type one in.');
  }

  const dir = await ensureWorkDir();
  const assPath = `${dir}/${project.id}.ass`;
  await writeTextFile(
    assPath,
    buildAssScript(project, { duration, ...measureLayout(project) })
  );

  // Stage the project's font files where libass can find them. Passing a
  // fontsdir is what lets a font that is not installed system-wide render
  // identically to the preview, which loaded the same bytes via FontFace.
  const fontsDir = await stageFonts(project, dir);

  let backgroundImage: string | null = null;
  const backgroundVideo = project.background.isVideo ? project.background.mediaPath : null;
  if (!backgroundVideo) {
    const png = await renderBackgroundPng(project, media);
    backgroundImage = `${dir}/${project.id}-bg.png`;
    await writeFile(backgroundImage, png);
  }

  let unlisten: (() => void) | undefined;
  if (options.onProgress) {
    unlisten = await listen<RenderProgress>('karaoke-render-progress', (event) => {
      options.onProgress?.(event.payload);
    });
  }

  try {
    const result = await invoke<{ outputPath: string }>('render_lyric_video', {
      request: {
        assPath,
        backgroundImage,
        backgroundVideo,
        audioPath: project.audio?.path ?? null,
        outputPath: options.outputPath,
        width: project.canvas.width,
        height: project.canvas.height,
        fps: project.canvas.fps,
        duration,
        fontsDir,
        encoder: options.encoder ?? 'libx264',
        crf: options.crf ?? null,
        ffmpegPath: options.ffmpegPath ?? null,
      },
    });
    return result.outputPath;
  } finally {
    unlisten?.();
  }
}

/** Write just the ASS script somewhere the user chose. */
export async function exportAssFile(project: LyricProject, path: string): Promise<void> {
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');
  await writeTextFile(
    path,
    buildAssScript(project, { duration: project.duration, ...measureLayout(project) })
  );
}
