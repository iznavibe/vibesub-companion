// Data model for the karaoke / lyric-video studio.
//
// Timing is stored as absolute seconds per syllable so that tap-along input and
// drag-to-refine both write the same shape. The ASS exporter converts these to
// the relative centisecond durations libass expects.

/** One swept unit of text — a Hangul syllable, a Latin word, or whatever the user merged. */
export interface KaraokeSyllable {
  text: string;
  /** Absolute seconds. The sweep begins here. */
  start: number;
  /** Absolute seconds. In 'hold' sweep mode the fill completes here and waits. */
  end: number;
  /** Per-syllable colour override, for emphasis words like the pink "Okay okay?". */
  baseColor?: string;
  sungColor?: string;
  /** Struck through, to mark a word as "not this one — sing the other". */
  strike?: boolean;
  /** Opacity percentages, 0-100. Override the line and project defaults. */
  baseAlpha?: number;
  sungAlpha?: number;
  /**
   * Seconds this word takes to fade away, ending when its block leaves the
   * screen. Usually put on the last line of a song so it goes out gently
   * rather than being cut, but any word can carry it.
   */
  fadeOut?: number;
}

export interface KaraokeLine {
  id: string;
  syllables: KaraokeSyllable[];
  /** Seconds. Defaults to visible for the whole project when null. */
  appearAt: number | null;
  disappearAt: number | null;
  /** Per-line overrides; anything unset falls back to the project style. */
  fontSize?: number;
  baseColor?: string;
  sungColor?: string;
  baseAlpha?: number;
  sungAlpha?: number;
  /** Nudge this line off the computed grid position, in canvas pixels. */
  offsetX: number;
  offsetY: number;
  /**
   * Lines sharing a blockId appear and disappear together, and stack from the
   * top of the panel as a group. A block is one screenful of lyrics — a verse,
   * a chorus — so the text on screen changes as the song moves on instead of
   * every line in the song being visible at once.
   */
  blockId?: string;
}

export type TextAlign = 'left' | 'center' | 'right';

/**
 * 'continuous' — each syllable sweeps until the next one starts, so gaps are
 *   absorbed as a slower sweep. This is what the reference video does.
 * 'hold' — each syllable sweeps over [start, end] then sits fully sung until
 *   the next begins. Snappier, good for staccato delivery.
 */
export type SweepMode = 'continuous' | 'hold';

export interface KaraokeStyle {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  /** Extra tracking in px. Maps to ASS `Spacing`. */
  letterSpacing: number;
  /** Distance between baselines, in px. */
  lineHeight: number;
  align: TextAlign;
  /**
   * Horizontal and vertical glyph scale, as a percentage. Dragging the side
   * handles on the transform box squishes or widens the text through these,
   * which map straight onto ASS ScaleX / ScaleY.
   */
  scaleX: number;
  scaleY: number;

  /** Colour before the sweep reaches the glyph. */
  baseColor: string;
  /** Colour after the sweep has passed. */
  sungColor: string;
  /**
   * Opacity percentages, 0-100, before and after the sweep. Setting base below
   * sung gives the classic "ghosted until sung" look; the reverse dims a line
   * once it has been sung.
   */
  baseAlpha: number;
  sungAlpha: number;

  outlineColor: string;
  /** Outline radius in px. 0 disables. */
  outlineWidth: number;
  shadowColor: string;
  /** Shadow offset in px, down-right. 0 disables. */
  shadowOffset: number;

  /**
   * Strikethrough rule, as fractions of the type size: how thick it is, and how
   * far down the glyph it sits (0 is the cap line, 1 the baseline).
   */
  strikeThickness: number;
  strikeHeight: number;
  /**
   * Colour of the rule. Unset means it takes the word's own colour, which is
   * what a strikethrough normally does.
   */
  strikeColor?: string;

  sweepMode: SweepMode;
}

/** Where the lyric block sits on the canvas. */
export interface KaraokePanel {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Pin an axis so dragging cannot shift it. Locking one axis still lets the
   * block slide along the other, which is how you nudge a row vertically
   * without losing a horizontal alignment you already got right.
   */
  lockX?: boolean;
  lockY?: boolean;
}

export type BackgroundFit = 'cover' | 'contain' | 'stretch';

export interface KaraokeBackground {
  /** Flat colour painted under everything. */
  color: string;
  /** Optional still or video layered on top of the colour. */
  mediaPath: string | null;
  mediaFileName: string;
  /** True when mediaPath points at a video rather than a still. */
  isVideo: boolean;
  /** Placement rect for the media, in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  fit: BackgroundFit;
}

export interface KaraokeCanvasSpec {
  width: number;
  height: number;
  fps: number;
}

/**
 * A free-floating text box, for things that are not sung: a shout cue like
 * "(함성!)" over a line, a section label, a note. It has no karaoke sweep.
 */
/**
 * The one look a project is built around — pink for a fanchant, something else
 * for another song. Kept on the project so a word, a line or a text box can all
 * be set to it with a single button, and carried into new projects as a default.
 */
export interface FanchantLook {
  baseColor: string;
  sungColor: string;
  baseAlpha: number;
  sungAlpha: number;
}

export const DEFAULT_FANCHANT: FanchantLook = {
  baseColor: '#FF5FA2',
  sungColor: '#FFFFFF',
  baseAlpha: 100,
  sungAlpha: 100,
};

export interface Annotation {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  /** Colour before the sweep reaches it. */
  color: string;
  bold: boolean;
  outlineColor: string;
  outlineWidth: number;
  align: TextAlign;
  /**
   * The span the box is *sung* over — what its block on the lane covers, and
   * what the fill sweeps across. Null means the whole project.
   */
  appearAt: number | null;
  disappearAt: number | null;
  /**
   * Seconds on screen before the sweep starts and after it ends. A shout cue
   * has to be readable before it is due, and worth leaving up a moment after,
   * without either stretching the sweep it is timed to.
   */
  leadIn?: number;
  holdOut?: number;
  /**
   * Colour after the sweep has passed. When set, the box fills across its own
   * window the way a lyric line does — a shout cue can then show how long it
   * lasts rather than just appearing and vanishing. Leave it unset for a plain
   * single-colour box.
   */
  sungColor?: string;
  /** Opacity percentages, before and after the sweep. */
  alpha?: number;
  sungAlpha?: number;
  /** Seconds the box takes to fade away, ending when it leaves the screen. */
  fadeOut?: number;
}

/** A font file the user supplied, used by both the preview and the render. */
export interface FontAsset {
  /** Family name as it appears to the font system, e.g. "Maplestory OTF". */
  family: string;
  /** Absolute path to the .ttf/.otf on disk. */
  path: string;
  fileName: string;
}

/**
 * A second row of lyrics beneath the main one, typically romaji under Korean.
 *
 * `lines` is index-paired with the project's main lines: romaji line 3 is the
 * transliteration of lyric line 3. That pairing is what lets a pasted romaji
 * verse inherit the timing already worked out for the original.
 */
export interface RomajiTrack {
  enabled: boolean;
  lines: KaraokeLine[];
  panel: KaraokePanel;
  /** Applied on top of the main style; anything unset is inherited. */
  style: Partial<KaraokeStyle>;
}

export interface LyricProject {
  version: string;
  id: string;
  name: string;
  createdAt: string;
  lastModifiedAt: string;

  canvas: KaraokeCanvasSpec;
  background: KaraokeBackground;
  audio: { path: string; fileName: string } | null;
  /** Seconds. Falls back to the audio duration when 0. */
  duration: number;

  panel: KaraokePanel;
  style: KaraokeStyle;
  /** The look words and text boxes are set to with one button. */
  fanchant: FanchantLook;
  lines: KaraokeLine[];
  annotations: Annotation[];
  fonts: FontAsset[];
  /** How Latin text is segmented: whole words, or romaji mora. */
  latinMode: 'word' | 'romaji';
  romaji: RomajiTrack;
  /**
   * Seconds a block appears before its first word, so singers can read ahead.
   * 0 puts it up exactly on cue.
   */
  blockLeadIn: number;
  /** Put each block up as soon as the previous one stops singing. */
  blockFillGaps: boolean;
  /**
   * Seconds a block stays up after its last word. `null` leaves it up until the
   * next block arrives, which means the final block never clears.
   */
  blockHoldOut: number | null;
}

/**
 * Defaults for lyrics laid over footage: white fill with a dark outline, which
 * stays readable whatever the video underneath is doing. 'hold' is the default
 * sweep because a pause between words should read as a pause.
 */
export const DEFAULT_KARAOKE_STYLE: KaraokeStyle = {
  fontFamily: 'Malgun Gothic',
  fontSize: 54,
  bold: true,
  italic: false,
  letterSpacing: 0,
  lineHeight: 68,
  align: 'center',
  scaleX: 100,
  scaleY: 100,
  baseColor: '#FFFFFF',
  sungColor: '#F5D64B',
  baseAlpha: 100,
  sungAlpha: 100,
  outlineColor: '#000000',
  outlineWidth: 3,
  shadowColor: '#000000',
  shadowOffset: 0,
  strikeThickness: 0.055,
  strikeHeight: 0.5,
  sweepMode: 'hold',
};

export const DEFAULT_EMPHASIS_BASE = '#F257B7';
export const DEFAULT_EMPHASIS_SUNG = '#F9C2E6';

/**
 * A blank project, sized for 1080p until a video is imported and overrides it.
 * There is deliberately no background artwork: the normal flow is to bring in
 * your own footage, and `applyBackgroundVideo` reshapes the project around it.
 */
export function createEmptyLyricProject(id: string, name: string): LyricProject {
  const now = new Date().toISOString();
  const width = 1920;
  const height = 1080;
  return {
    version: '1.0',
    id,
    name,
    createdAt: now,
    lastModifiedAt: now,
    canvas: { width, height, fps: 30 },
    background: {
      color: '#000000',
      mediaPath: null,
      mediaFileName: '',
      isVideo: false,
      x: 0,
      y: 0,
      width,
      height,
      fit: 'cover',
    },
    audio: null,
    duration: 0,
    panel: defaultPanelFor(width, height),
    style: { ...DEFAULT_KARAOKE_STYLE },
    fanchant: { ...DEFAULT_FANCHANT },
    lines: [],
    annotations: [],
    fonts: [],
    latinMode: 'word',
    blockLeadIn: 0,
    blockFillGaps: false,
    blockHoldOut: 1.5,
    romaji: {
      enabled: false,
      lines: [],
      panel: defaultPanelFor(width, height),
      style: {},
    },
  };
}

/**
 * Stack the two lyric blocks in the upper and lower halves of the frame.
 *
 * Splitting the safe area rather than the whole canvas keeps both blocks clear
 * of the very top and bottom edges, where players and platform UI sit.
 */
export function splitPanelsForTracks(
  width: number,
  height: number
): { main: KaraokePanel; romaji: KaraokePanel } {
  const w = Math.round(width * 0.86);
  const x = Math.round((width - w) / 2);
  const top = Math.round(height * 0.12);
  const usable = Math.round(height * 0.76);
  const half = Math.round(usable / 2);
  const gap = Math.round(height * 0.02);

  return {
    main: { x, y: top, width: w, height: half - gap },
    romaji: { x, y: top + half + gap, width: w, height: half - gap },
  };
}

/** Projects saved before a field existed load with it missing; fill the gaps. */
export function migrateLyricProject(project: LyricProject): LyricProject {
  return {
    ...project,
    annotations: project.annotations ?? [],
    fonts: project.fonts ?? [],
    latinMode: project.latinMode ?? 'word',
    blockLeadIn: project.blockLeadIn ?? 0,
    blockFillGaps: project.blockFillGaps ?? false,
    blockHoldOut: project.blockHoldOut === undefined ? 1.5 : project.blockHoldOut,
    fanchant: { ...DEFAULT_FANCHANT, ...(project.fanchant ?? {}) },
    romaji: project.romaji ?? {
      enabled: false,
      lines: [],
      panel: defaultPanelFor(project.canvas?.width ?? 1920, project.canvas?.height ?? 1080),
      style: {},
    },
    style: {
      ...DEFAULT_KARAOKE_STYLE,
      ...project.style,
      scaleX: project.style?.scaleX ?? 100,
      scaleY: project.style?.scaleY ?? 100,
      baseAlpha: project.style?.baseAlpha ?? 100,
      sungAlpha: project.style?.sungAlpha ?? 100,
      strikeThickness: project.style?.strikeThickness ?? 0.055,
      strikeHeight: project.style?.strikeHeight ?? 0.5,
    },
  };
}

let annotationCounter = 0;
export function createAnnotation(
  x: number,
  y: number,
  fontSize: number,
  /**
   * Where the playhead is. A new box lands there with a short span, so it can
   * be dragged into place on the lane; one spanning the whole song has no
   * handles worth grabbing and has to be cut down before it can be timed.
   */
  at = 0,
  look?: FanchantLook
): Annotation {
  annotationCounter += 1;
  return {
    id: `note-${Date.now().toString(36)}-${annotationCounter}`,
    text: '(함성!)',
    x,
    y,
    fontSize,
    color: look?.baseColor ?? '#FFFFFF',
    bold: true,
    outlineColor: '#000000',
    outlineWidth: 3,
    align: 'center',
    appearAt: Math.max(0, at),
    disappearAt: Math.max(0, at) + 2,
    leadIn: 0,
    holdOut: 0,
    sungColor: look?.sungColor,
    alpha: look?.baseAlpha,
    sungAlpha: look?.sungAlpha,
  };
}

/** When a box is on screen, which is wider than the span it is sung over. */
export function annotationWindow(
  note: Annotation,
  duration: number
): { from: number; to: number } {
  const from = note.appearAt ?? 0;
  const to = note.disappearAt ?? duration;
  return {
    from: Math.max(0, from - (note.leadIn ?? 0)),
    to: to + (note.holdOut ?? 0),
  };
}

/** Lower-third block, the safe default when nothing better is known. */
export function defaultPanelFor(width: number, height: number): KaraokePanel {
  const w = Math.round(width * 0.86);
  const h = Math.round(height * 0.3);
  return {
    x: Math.round((width - w) / 2),
    y: Math.round(height * 0.6),
    width: w,
    height: h,
  };
}

/**
 * Reshape a project around an imported video: the canvas adopts the video's
 * resolution, the video fills the frame, and it becomes the sound source too.
 *
 * `panel` is only replaced when the caller supplies a better rect (from flat
 * region detection) or the project has no lines placed yet, so re-importing a
 * video does not throw away a layout that has been tuned by hand.
 */
export function applyBackgroundVideo(
  project: LyricProject,
  media: { path: string; fileName: string; width: number; height: number; duration: number; fps?: number },
  panel?: KaraokePanel
): LyricProject {
  const width = media.width > 0 ? media.width : project.canvas.width;
  const height = media.height > 0 ? media.height : project.canvas.height;
  const untouched = project.lines.length === 0;

  return {
    ...project,
    canvas: {
      width,
      height,
      fps: media.fps && media.fps > 0 ? Math.round(media.fps) : project.canvas.fps,
    },
    background: {
      ...project.background,
      mediaPath: media.path,
      mediaFileName: media.fileName,
      isVideo: true,
      x: 0,
      y: 0,
      width,
      height,
      fit: 'cover',
    },
    // The video carries its own audio, so it doubles as the sound source.
    audio: { path: media.path, fileName: media.fileName },
    duration: media.duration > 0 ? media.duration : project.duration,
    panel: panel ?? (untouched ? defaultPanelFor(width, height) : project.panel),
    lastModifiedAt: new Date().toISOString(),
  };
}
