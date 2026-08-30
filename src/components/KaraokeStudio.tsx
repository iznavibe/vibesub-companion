import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Annotation,
  KaraokeLine,
  KaraokeStyle,
  LyricProject,
  applyBackgroundVideo,
  createAnnotation,
  createEmptyLyricProject,
  migrateLyricProject,
  splitPanelsForTracks,
} from '../types/karaoke';
import { loadFontFromPath, loadProjectFonts } from '../services/fontService';
import { PanelTransform } from './KaraokeCanvas';
import {
  appendBlock,
  applyBlockWindows,
  closeGaps,
  deleteSelection,
  editLineText,
  mergeLineWithNext,
  splitLineAt,
  distributeEvenly,
  lineText,
  mergeSyllable,
  moveSelection,
  parseLyricBlockDetailed,
  normalizeTrackWindows,
  shiftLine,
  syncTrackWindows,
  type SyllableRef,
  splitSyllable,
} from '../utils/karaokeText';
import { BackgroundSource, layoutLine, fitsInPanel, trackPanel, trackStyle } from '../utils/karaokeRenderer';
import { groupIntoBlocks } from '../utils/karaokeText';
import { detectFlatPanel } from '../utils/flatRegion';
import { KaraokeCanvas } from './KaraokeCanvas';
import { KaraokeLane } from './KaraokeLane';
import { KaraokeStylePanel } from './KaraokeStylePanel';
import { useTapTiming } from '../hooks/useTapTiming';
import { useUndoable } from '../hooks/useUndoable';
import { useAudioWaveform } from '../hooks/useAudioWaveform';
import {
  FfmpegInfo,
  RenderProgress,
  checkFfmpeg,
  exportAssFile,
  renderLyricVideo,
} from '../services/karaokeRenderService';
import {
  LyricSet,
  copyLyricSetToClipboard,
  loadLyricSetFromFile,
  readLyricSetFromClipboard,
  rescaleLyricSet,
  saveLyricSetToFile,
} from '../services/lyricSetService';
import { isTauri } from '../services/tauriService';
import styles from './KaraokeStudio.module.css';

interface KaraokeStudioProps {
  project: LyricProject | null;
  onProjectChange: (project: LyricProject) => void;
  onBack: () => void;
}

type Tab = 'lyrics' | 'style';

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];

/**
 * One editable lyric line.
 *
 * The text is held locally while focused and only committed on blur or Enter,
 * so re-segmenting mid-keystroke cannot move the caret out from under you.
 * Escape abandons the edit.
 */
function LineTextField({
  value,
  onCommit,
  onFocus,
}: {
  value: string;
  onCommit: (text: string) => void;
  onFocus: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  return (
    <input
      className={styles.lineInput}
      value={editing ? draft : value}
      spellCheck={false}
      onFocus={() => {
        setDraft(value);
        setEditing(true);
        onFocus();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft.trim() !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * Migrate a project and repair its visibility windows in one step.
 *
 * Anything saved before blocks existed, or before romaji shared the lyrics'
 * windows, would otherwise keep `appearAt: null` and sit on screen from the
 * first frame.
 */
function adoptProject(project: LyricProject): LyricProject {
  const migrated = migrateLyricProject(project);
  const { lines, romajiLines } = normalizeTrackWindows(
    migrated.lines,
    migrated.romaji?.lines ?? [],
    {
      leadIn: migrated.blockLeadIn ?? 0,
      fillGaps: migrated.blockFillGaps ?? false,
      holdOut: migrated.blockHoldOut === undefined ? 1.5 : migrated.blockHoldOut,
    }
  );
  return { ...migrated, lines, romaji: { ...migrated.romaji, lines: romajiLines } };
}

export function KaraokeStudio({ project, onProjectChange, onBack }: KaraokeStudioProps) {
  const mediaRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);

  const doc = useUndoable<LyricProject>(
    adoptProject(project ?? createEmptyLyricProject('draft', 'Untitled lyric video'))
  );
  const current = doc.value;

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tab, setTab] = useState<Tab>('lyrics');
  const [lyricText, setLyricText] = useState('');
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [selectedTrack, setSelectedTrack] = useState(0);
  const [romajiText, setRomajiText] = useState('');
  // Selection can span lines, since the lane shows them all on one row.
  const [selection, setSelection] = useState<SyllableRef[]>([]);
  // Most editing acts on a single word; the group is only for dragging.
  const selectedSyllable =
    selection.length === 1 &&
    selection[0].track === selectedTrack &&
    selection[0].line === selectedLine
      ? selection[0].syllable
      : null;
  const setSelectedSyllable = useCallback(
    (i: number | null) =>
      setSelection(
        i === null || selectedLine === null
          ? []
          : [{ track: selectedTrack, line: selectedLine, syllable: i }]
      ),
    [selectedLine, selectedTrack]
  );
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [gridDivisions, setGridDivisions] = useState(3);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [mediaVersion, setMediaVersion] = useState(0);
  const [imageMedia, setImageMedia] = useState<BackgroundSource | null>(null);
  const [mediaSrc, setMediaSrc] = useState('');
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null);
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: waveform } = useAudioWaveform(current.audio?.path ?? null);

  // Adopt a different project only when the identity actually changes, so the
  // undo history survives ordinary edits.
  useEffect(() => {
    if (project && project.id !== doc.value.id) {
      doc.reset(adoptProject(project));
      setLyricText(project.lines.map(lineText).join('\n'));
      setSelectedLine(null);
      setSelectedSyllable(null);
      setSelectedNoteId(null);
    }
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Custom fonts must be re-registered with the document whenever a project is
  // reopened, or the preview silently falls back to a system face.
  useEffect(() => {
    const fonts = current.fonts ?? [];
    if (fonts.length === 0) return;
    loadProjectFonts(fonts)
      .then(() => setMediaVersion((v) => v + 1))
      .catch(() => undefined);
  }, [current.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = mediaRef.current;
    if (el) el.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    onProjectChange(current);
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    checkFfmpeg().then(setFfmpeg).catch(() => setFfmpeg(null));
  }, []);

  // Lead-in and gap filling change every block's window, so reapply them when
  // either setting moves.
  const leadInKey = `${current.blockLeadIn ?? 0}:${current.blockFillGaps ?? false}:${
    current.blockHoldOut === undefined ? 1.5 : current.blockHoldOut
  }`;
  useEffect(() => {
    if (doc.value.lines.length === 0) return;
    const windowed = applyBlockWindows(doc.value.lines, {
      leadIn: doc.value.blockLeadIn ?? 0,
      fillGaps: doc.value.blockFillGaps ?? false,
      holdOut: doc.value.blockHoldOut === undefined ? 1.5 : doc.value.blockHoldOut,
    });
    if (windowed === doc.value.lines) return;
    doc.setTransient({
      ...doc.value,
      lines: windowed,
      romaji: {
        ...doc.value.romaji,
        lines: syncTrackWindows(windowed, doc.value.romaji?.lines ?? []),
      },
    });
  }, [leadInKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = useCallback(
    (p: Partial<LyricProject>, opts?: { coalesce?: boolean }) => {
      doc.set({ ...doc.value, ...p, lastModifiedAt: new Date().toISOString() }, opts);
    },
    [doc]
  );

  const patchTransient = useCallback(
    (p: Partial<LyricProject>) => {
      doc.setTransient({ ...doc.value, ...p });
    },
    [doc]
  );

  const setLines = useCallback(
    (lines: KaraokeLine[]) => patch({ lines }),
    [patch]
  );

  const tapping = useTapTiming({
    lines: current.lines,
    getTime: () => mediaRef.current?.currentTime ?? 0,
    onCommit: setLines,
    onFinished: () => mediaRef.current?.pause(),
  });

  const displayProject = useMemo<LyricProject>(
    () => (tapping.isTapping ? { ...current, lines: tapping.preview } : current),
    [current, tapping.isTapping, tapping.preview]
  );

  const isVideoBackground = current.background.isVideo && !!current.background.mediaPath;
  const media: BackgroundSource | null = isVideoBackground
    ? (mediaRef.current as BackgroundSource | null)
    : imageMedia;

  // rAF drives the playhead; `timeupdate` only fires ~4x a second, which makes
  // the sweep look stepped.
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const tick = () => {
      const el = mediaRef.current;
      if (el) setCurrentTime(el.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying]);

  // Resolve the media path to something the webview can load.
  useEffect(() => {
    const path = current.background.mediaPath ?? current.audio?.path ?? null;
    if (!path) {
      setMediaSrc('');
      return;
    }
    let cancelled = false;
    (async () => {
      let url = path;
      if (isTauri()) {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        url = convertFileSrc(path);
      }
      if (!cancelled) setMediaSrc(url);
    })();
    return () => {
      cancelled = true;
    };
  }, [current.background.mediaPath, current.audio?.path]);

  // A still background is loaded separately, since it is not the media element.
  useEffect(() => {
    const path = current.background.mediaPath;
    if (!path || current.background.isVideo) {
      setImageMedia(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let url = path;
      if (isTauri()) {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        url = convertFileSrc(path);
      }
      const img = new Image();
      img.onload = () => {
        if (!cancelled) {
          setImageMedia(img);
          setMediaVersion((v) => v + 1);
        }
      };
      img.src = url;
    })();
    return () => {
      cancelled = true;
    };
  }, [current.background.mediaPath, current.background.isVideo]);

  // Mirrored into a ref so the global key handler always sees the live selection.
  const selectionRef = useRef<SyllableRef[]>([]);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const seek = useCallback((t: number) => {
    const el = mediaRef.current;
    if (el) el.currentTime = t;
    setCurrentTime(t);
  }, []);

  const togglePlay = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => undefined);
    else el.pause();
  }, []);

  // Transport and history shortcuts. Suspended while a tap session owns Space.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doc.redo();
        else doc.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        doc.redo();
        return;
      }
      if (tapping.isTapping) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
        return;
      }

      // Arrow keys nudge the whole selection, which is the precise way to fix a
      // timing without touching the mouse. Shift makes the step coarser.
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const refs = selectionRef.current;
        if (refs.length === 0) return;
        e.preventDefault();
        const step = (e.shiftKey ? 0.1 : 0.02) * (e.code === 'ArrowLeft' ? -1 : 1);
        const before = [doc.value.lines, doc.value.romaji?.lines ?? []];
        const after = moveSelection(before, refs, step);
        if (after !== before) {
          doc.set(
            {
              ...doc.value,
              lines: after[0],
              romaji: { ...doc.value.romaji, lines: after[1] },
            },
            { coalesce: true }
          );
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePlay, tapping.isTapping, doc]);

  const pickFile = async (
    title: string,
    extensions: string[]
  ): Promise<{ path: string; name: string } | null> => {
    if (!isTauri()) return null;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      title,
      multiple: false,
      filters: [{ name: title, extensions }],
    });
    if (typeof selected !== 'string') return null;
    return { path: selected, name: selected.split(/[\\/]/).pop() ?? selected };
  };

  /**
   * Import footage: the canvas takes the video's resolution, the video becomes
   * both the backdrop and the sound source, and the lyric block is dropped into
   * whatever flat empty area the template leaves — a lower third otherwise.
   */
  const handleImportVideo = async () => {
    const file = await pickFile('Video', VIDEO_EXTENSIONS);
    if (!file) return;
    setError(null);

    try {
      let url = file.path;
      if (isTauri()) {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        url = convertFileSrc(file.path);
      }

      const probe = document.createElement('video');
      probe.preload = 'auto';
      probe.muted = true;
      probe.src = url;

      const meta = await new Promise<{ width: number; height: number; duration: number }>(
        (resolve, reject) => {
          probe.onloadedmetadata = () =>
            resolve({
              width: probe.videoWidth,
              height: probe.videoHeight,
              duration: probe.duration,
            });
          probe.onerror = () => reject(new Error('Could not read that video.'));
        }
      );

      // Seek a little way in: frame zero is often black or a fade.
      const panel = await new Promise<ReturnType<typeof detectFlatPanel>>((resolve) => {
        const give = () => resolve(null);
        const timer = setTimeout(give, 4000);
        probe.onseeked = () => {
          clearTimeout(timer);
          try {
            resolve(detectFlatPanel(probe, meta.width, meta.height));
          } catch {
            resolve(null);
          }
        };
        probe.currentTime = Math.min(1.5, Math.max(0, meta.duration * 0.15));
      });

      doc.set(
        applyBackgroundVideo(
          doc.value,
          {
            path: file.path,
            fileName: file.name,
            width: meta.width,
            height: meta.height,
            duration: meta.duration,
          },
          panel ?? undefined
        )
      );
      setMediaVersion((v) => v + 1);
      setStatus(
        panel
          ? `Loaded ${file.name} — dropped the lyrics into the template's empty panel`
          : `Loaded ${file.name} (${meta.width}x${meta.height})`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * Swap the footage without touching the words.
   *
   * Lines, timings, blocks, romaji, annotations and style all stay exactly as
   * they are; only the backdrop changes. If the new clip is a different
   * resolution the layout is scaled to match, so the composition survives rather
   * than sitting in a corner. Duration is only adopted when the video is also
   * the sound source — swapping visuals against a separate audio track must not
   * move the timings.
   */
  const handleReplaceVideo = async () => {
    const file = await pickFile('Video', VIDEO_EXTENSIONS);
    if (!file) return;
    setError(null);

    try {
      let url = file.path;
      if (isTauri()) {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        url = convertFileSrc(file.path);
      }
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.muted = true;
      probe.src = url;
      const meta = await new Promise<{ width: number; height: number; duration: number }>(
        (resolve, reject) => {
          probe.onloadedmetadata = () =>
            resolve({
              width: probe.videoWidth,
              height: probe.videoHeight,
              duration: probe.duration,
            });
          probe.onerror = () => reject(new Error('Could not read that video.'));
        }
      );

      const width = meta.width > 0 ? meta.width : current.canvas.width;
      const height = meta.height > 0 ? meta.height : current.canvas.height;
      const factor = width / Math.max(1, current.canvas.width);
      const scaleRect = (r: typeof current.panel) =>
        factor === 1
          ? r
          : {
              ...r,
              x: Math.round(r.x * factor),
              y: Math.round(r.y * factor),
              width: Math.round(r.width * factor),
              height: Math.round(r.height * factor),
            };
      const scaleStyle = <T extends Partial<KaraokeStyle>>(st: T): T =>
        factor === 1
          ? st
          : {
              ...st,
              ...(st.fontSize !== undefined
                ? { fontSize: Math.max(6, Math.round(st.fontSize * factor)) }
                : {}),
              ...(st.lineHeight !== undefined
                ? { lineHeight: Math.max(6, Math.round(st.lineHeight * factor)) }
                : {}),
            };

      // The old video doubled as the sound source only if audio points at it.
      const audioWasVideo = current.audio?.path === current.background.mediaPath;

      patch({
        canvas: { ...current.canvas, width, height },
        background: {
          ...current.background,
          mediaPath: file.path,
          mediaFileName: file.name,
          isVideo: true,
          x: 0,
          y: 0,
          width,
          height,
        },
        panel: scaleRect(current.panel),
        style: scaleStyle(current.style),
        romaji: {
          ...current.romaji,
          panel: scaleRect(current.romaji.panel),
          style: scaleStyle(current.romaji.style),
        },
        ...(audioWasVideo
          ? {
              audio: { path: file.path, fileName: file.name },
              duration: meta.duration > 0 ? meta.duration : current.duration,
            }
          : {}),
      });
      setMediaVersion((v) => v + 1);
      setStatus(
        audioWasVideo
          ? `Swapped to ${file.name} — timings kept`
          : `Swapped visuals to ${file.name} — audio and timings untouched`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePickArtwork = async () => {
    const file = await pickFile('Image', ['png', 'jpg', 'jpeg', 'webp', 'bmp']);
    if (!file) return;
    patch({
      background: {
        ...current.background,
        mediaPath: file.path,
        mediaFileName: file.name,
        isVideo: false,
      },
    });
  };

  const handlePickAudio = async () => {
    const file = await pickFile('Audio', ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus']);
    if (!file) return;
    patch({ audio: { path: file.path, fileName: file.name } });
  };

  /**
   * Turn the lyric text into lines, and give any line that has never been timed
   * a provisional block on the lane.
   *
   * Pre-placing means there is always something to grab and drag, so timing
   * does not depend on keeping up with playback. Roughly a third of a second
   * per syllable is close enough to sung pace to be a useful starting point.
   */
  const handleApplyLyrics = () => {
    const { lines: parsed, droppedTimedLines } = parseLyricBlockDetailed(
      lyricText,
      current.lines,
      current.latinMode ?? 'word'
    );

    if (droppedTimedLines.length > 0) {
      const preview = droppedTimedLines.slice(0, 3).map((t) => `“${t}”`).join(', ');
      const more =
        droppedTimedLines.length > 3 ? ` and ${droppedTimedLines.length - 3} more` : '';
      const ok = window.confirm(
        `${droppedTimedLines.length} line${droppedTimedLines.length === 1 ? '' : 's'} you have ` +
          `already timed ${droppedTimedLines.length === 1 ? 'is' : 'are'} not in this text ` +
          `any more: ${preview}${more}.\n\nApplying will discard ${
            droppedTimedLines.length === 1 ? 'its timing' : 'their timings'
          }. Continue?`
      );
      if (!ok) return;
    }

    // Untimed lines start after whatever is already placed, so a fresh batch
    // does not land on top of work that is already done.
    let cursor = parsed.reduce((acc, line) => {
      const ends = line.syllables.filter((s) => s.end > s.start).map((s) => s.end);
      return ends.length > 0 ? Math.max(acc, ...ends) : acc;
    }, 0);

    const lines = parsed.map((line) => {
      if (line.syllables.some((s) => s.end > s.start)) return line;
      const span = Math.max(0.6, line.syllables.length * 0.33);
      const placed = distributeEvenly(line, cursor, cursor + span);
      cursor += span + 0.4;
      return placed;
    });

    {
      const synced = withWindows(lines, current.romaji?.lines ?? []);
      patch({ lines: synced.lines, romaji: { ...current.romaji, lines: synced.romajiLines } });
    }
    const first = lines.length > 0 ? 0 : null;
    setSelectedTrack(0);
    setSelectedLine(first);
    setSelectedSyllable(null);
    setStatus(
      `${lines.length} line${lines.length === 1 ? '' : 's'} ready — blocks are on the lane, drag them into place`
    );
  };

  /**
   * Apply the romaji text, pairing each line with the main lyric line at the
   * same index.
   *
   * A romaji line that has never been timed inherits the span of the Korean
   * line it transliterates, spread evenly across its mora. That is close enough
   * to adjust rather than time from scratch, which is the point of doing the
   * original first.
   */
  const handleApplyRomaji = () => {
    const existing = current.romaji?.lines ?? [];
    const { lines: parsed } = parseLyricBlockDetailed(romajiText, existing, 'romaji');

    const lines = parsed.map((line, i) => {
      if (line.syllables.some((sy) => sy.end > sy.start)) return line;
      const timed = current.lines[i]?.syllables.filter((sy) => sy.end > sy.start) ?? [];
      if (timed.length === 0) return line;
      return distributeEvenly(
        line,
        Math.min(...timed.map((sy) => sy.start)),
        Math.max(...timed.map((sy) => sy.end))
      );
    });

    const panels = splitPanelsForTracks(current.canvas.width, current.canvas.height);
    const wasEnabled = current.romaji?.enabled;
    patch({
      romaji: {
        ...current.romaji,
        enabled: true,
        lines: syncTrackWindows(current.lines, lines),
        // First time in, stack the two blocks so they do not overlap;
        // afterwards keep wherever they have been placed.
        panel: wasEnabled ? current.romaji.panel : panels.romaji,
        style: current.romaji?.style ?? {},
      },
      ...(wasEnabled ? {} : { panel: panels.main }),
    });
    setSelectedTrack(1);
    setSelectedLine(lines.length > 0 ? 0 : null);
    setSelection([]);
    setStatus(
      `${lines.length} romaji line${lines.length === 1 ? '' : 's'} added, timed from the lyrics above`
    );
  };

  const handleToggleRomaji = () => {
    const enabled = !current.romaji?.enabled;
    const panels = splitPanelsForTracks(current.canvas.width, current.canvas.height);
    patch({
      romaji: { ...current.romaji, enabled },
      ...(enabled && (current.romaji?.lines.length ?? 0) === 0 ? { panel: panels.main } : {}),
    });
    if (!enabled && selectedTrack === 1) {
      setSelectedTrack(0);
      setSelection([]);
    }
  };

  /**
   * Append the text box's contents as a new block starting at the playhead.
   *
   * This is the verse-by-verse path: existing blocks keep their words and their
   * timings, and the new block appears on screen when the playhead reaches it
   * and disappears when the block after it begins.
   */
  const handleAddBlock = () => {
    const text = lyricText.trim();
    if (!text) {
      setError('Paste the next block of lyrics first.');
      return;
    }
    setError(null);

    const added = appendBlock(
      current.lines,
      text,
      currentTime,
      current.latinMode ?? 'word',
      0.33,
      {
        leadIn: current.blockLeadIn ?? 0,
        fillGaps: current.blockFillGaps ?? false,
        holdOut: current.blockHoldOut === undefined ? 1.5 : current.blockHoldOut,
      }
    );
    const firstNew = current.lines.length;
    const { lines, romajiLines } = withWindows(added, current.romaji?.lines ?? []);

    patch({ lines, romaji: { ...current.romaji, lines: romajiLines } });
    setSelectedTrack(0);
    setSelectedLine(firstNew);
    setSelection([]);
    // The box is cleared so the next paste cannot be mistaken for a re-apply of
    // this one — the previous block lives in the project now, not in the box.
    setLyricText('');
    setStatus(
      `Added ${lines.length - firstNew} line${lines.length - firstNew === 1 ? '' : 's'} at ${currentTime.toFixed(
        2
      )}s — earlier blocks untouched`
    );
  };

  const handleLoadFont = async () => {
    const file = await pickFile('Font', ['ttf', 'otf', 'ttc']);
    if (!file) return;
    try {
      const asset = await loadFontFromPath(file.path, file.name);
      if (!asset) return;
      const fonts = [
        ...(current.fonts ?? []).filter((f) => f.family !== asset.family),
        asset,
      ];
      patch({ fonts, style: { ...current.style, fontFamily: asset.family } });
      setMediaVersion((v) => v + 1);
      setStatus(`Loaded "${asset.family}" from ${asset.fileName}`);
    } catch (e) {
      setError(`Could not load that font: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Bring in an external lyric set. When it was timed against a track of a
   * different length, offer to scale the timings proportionally — right for a
   * different cut of the same performance, wrong for an unrelated song, so it
   * asks rather than guessing.
   */
  const applyLyricSet = (set: LyricSet) => {
    let lines = set.lines;
    const from = set.sourceDuration;
    const to = current.duration;
    if (from > 0 && to > 0 && Math.abs(from - to) > 0.25) {
      const scale = window.confirm(
        `These lyrics were timed against a ${from.toFixed(1)}s track, but this project is ` +
          `${to.toFixed(1)}s.\n\n` +
          'OK to stretch the timings to fit, or Cancel to keep them as they are.'
      );
      if (scale) lines = rescaleLyricSet(lines, to / from);
    }

    patch({
      lines,
      latinMode: set.latinMode,
      ...(set.style ? { style: { ...current.style, ...set.style } } : {}),
    });
    setLyricText(lines.map(lineText).join('\n'));
    setSelectedLine(lines.length > 0 ? 0 : null);
    setSelection([]);
    setStatus(`Imported ${lines.length} line${lines.length === 1 ? '' : 's'} from "${set.name}"`);
  };

  const handleExportLyrics = async () => {
    try {
      const path = await saveLyricSetToFile(current, true);
      if (path) setStatus(`Lyrics written to ${path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleImportLyrics = async () => {
    setError(null);
    try {
      const set = await loadLyricSetFromFile();
      if (set) applyLyricSet(set);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleCopyLyrics = async () => {
    setError(null);
    try {
      await copyLyricSetToClipboard(current, true);
      setStatus('Lyrics and timings copied — paste them into another project');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePasteLyrics = async () => {
    setError(null);
    try {
      applyLyricSet(await readLyricSetFromClipboard());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleAddNote = () => {
    const note = createAnnotation(
      Math.round(current.panel.x + current.panel.width / 2),
      Math.round(Math.max(0, current.panel.y - current.style.lineHeight)),
      Math.round(current.style.fontSize * 0.8)
    );
    patch({ annotations: [...(current.annotations ?? []), note] });
    setSelectedNoteId(note.id);
    setTab('style');
  };

  const handleNoteChange = useCallback(
    (id: string, p: Partial<Annotation>, transient = false) => {
      const annotations = (doc.value.annotations ?? []).map((n) =>
        n.id === id ? { ...n, ...p } : n
      );
      if (transient) patchTransient({ annotations });
      else patch({ annotations }, { coalesce: true });
    },
    [doc, patch, patchTransient]
  );

  const handleDeleteNote = (id: string) => {
    patch({ annotations: (current.annotations ?? []).filter((n) => n.id !== id) });
    setSelectedNoteId(null);
  };

  /** Set per-word opacity overrides; undefined falls back to the line/project. */
  const handleSyllableAlpha = (base: number | undefined, sung: number | undefined) => {
    if (selectedLine === null || selectedSyllable === null) return;
    const line = current.lines[selectedLine];
    if (!line) return;
    const syllables = line.syllables.map((s, i) =>
      i === selectedSyllable ? { ...s, baseAlpha: base, sungAlpha: sung } : s
    );
    handleLineChange(selectedLine, { ...line, syllables });
  };

  const handleToggleStrike = () => {
    if (selectedLine === null || selectedSyllable === null) return;
    const line = current.lines[selectedLine];
    if (!line) return;
    const syllables = line.syllables.map((s, i) =>
      i === selectedSyllable ? { ...s, strike: !s.strike } : s
    );
    handleLineChange(selectedLine, { ...line, syllables });
  };

  const handleLineChange = useCallback(
    (index: number, next: KaraokeLine, transient = false) => {
      const lines = [...doc.value.lines];
      lines[index] = next;
      if (transient) patchTransient({ lines });
      else patch({ lines });
    },
    [doc, patch, patchTransient]
  );

  /** The lines of both tracks, in the shape the lane and movement utils expect. */
  const tracks = useMemo(
    () => [displayProject.lines, displayProject.romaji?.lines ?? []],
    [displayProject]
  );

  /** Write back a whole set of tracks, splitting them into their two homes. */
  const setTracks = useCallback(
    (next: KaraokeLine[][], transient = false) => {
      const patchValue: Partial<LyricProject> = {
        lines: next[0] ?? [],
        romaji: { ...doc.value.romaji, lines: next[1] ?? [] },
      };
      if (transient) patchTransient(patchValue);
      else patch(patchValue);
    },
    [doc, patch, patchTransient]
  );

  /**
   * Recompute block windows for the lyrics and mirror them onto the romaji.
   *
   * Romaji lines transliterate the line above them, so they must share a window
   * rather than deriving one from their own timings — otherwise the two rows
   * appear and vanish independently.
   */
  const withWindows = useCallback(
    (lines: KaraokeLine[], romajiLines: KaraokeLine[]) => {
      const windowed = applyBlockWindows(lines, {
        leadIn: current.blockLeadIn ?? 0,
        fillGaps: current.blockFillGaps ?? false,
        holdOut: current.blockHoldOut === undefined ? 1.5 : current.blockHoldOut,
      });
      return { lines: windowed, romajiLines: syncTrackWindows(windowed, romajiLines) };
    },
    [current.blockLeadIn, current.blockFillGaps, current.blockHoldOut]
  );

  const handleDeleteSelection = useCallback(() => {
    if (selection.length === 0) return;
    const next = deleteSelection([doc.value.lines, doc.value.romaji?.lines ?? []], selection);
    setTracks(next);
    setSelection([]);
    // Deleting can drop an empty line, so re-sync the text boxes that mirror them.
    setLyricText(next[0].map(lineText).join('\n'));
    setRomajiText(next[1].map(lineText).join('\n'));
    setSelectedLine(next[selectedTrack]?.length ? Math.min(selectedLine ?? 0, next[selectedTrack].length - 1) : null);
  }, [selection, doc, setTracks, selectedTrack, selectedLine]);

  /**
   * Rewrite one line's words, keeping the timings already set.
   *
   * Which track the line belongs to matters: romaji is segmented per mora
   * whatever the project's Latin setting says.
   */
  const handleEditLine = useCallback(
    (track: number, index: number, text: string) => {
      const lines = track === 1 ? doc.value.romaji?.lines ?? [] : doc.value.lines;
      const line = lines[index];
      if (!line || lineText(line) === text.trim()) return;

      const edited = editLineText(
        line,
        text,
        track === 1 ? 'romaji' : doc.value.latinMode ?? 'word'
      );
      const next = lines.map((l, i) => (i === index ? edited : l));
      const cleaned = next.filter((l) => l.syllables.length > 0);
      setTracks(
        track === 1
          ? [doc.value.lines, cleaned]
          : [cleaned, doc.value.romaji?.lines ?? []]
      );
    },
    [doc, setTracks]
  );

  /** Break the selected line in two at the selected word. */
  const handleSplitLine = useCallback(() => {
    if (selectedLine === null || selectedSyllable === null) return;
    const lines = selectedTrack === 1 ? doc.value.romaji?.lines ?? [] : doc.value.lines;
    const next = splitLineAt(lines, selectedLine, selectedSyllable);
    if (next === lines) return;
    setTracks(
      selectedTrack === 1
        ? [doc.value.lines, next]
        : [next, doc.value.romaji?.lines ?? []]
    );
    setSelection([]);
  }, [selectedLine, selectedSyllable, selectedTrack, doc, setTracks]);

  /** Pull the following line up onto this one. */
  const handleMergeLine = useCallback(() => {
    if (selectedLine === null) return;
    const lines = selectedTrack === 1 ? doc.value.romaji?.lines ?? [] : doc.value.lines;
    const next = mergeLineWithNext(lines, selectedLine);
    if (next === lines) return;
    setTracks(
      selectedTrack === 1
        ? [doc.value.lines, next]
        : [next, doc.value.romaji?.lines ?? []]
    );
    setSelection([]);
  }, [selectedLine, selectedTrack, doc, setTracks]);

  const handleSyllableColor = (base: string | undefined, sung: string | undefined) => {
    if (selectedLine === null || selectedSyllable === null) return;
    const line = current.lines[selectedLine];
    if (!line) return;
    const syllables = line.syllables.map((s, i) =>
      i === selectedSyllable ? { ...s, baseColor: base, sungColor: sung } : s
    );
    handleLineChange(selectedLine, { ...line, syllables });
  };

  const duration = current.duration;
  const selected = selectedLine !== null ? displayProject.lines[selectedLine] ?? null : null;

  const withSelectedLine = (fn: (line: KaraokeLine) => KaraokeLine) => {
    if (selectedLine === null) return;
    const line = current.lines[selectedLine];
    if (!line) return;
    handleLineChange(selectedLine, fn(line));
  };

  const handleSpread = () =>
    withSelectedLine((line) => {
      const from = line.syllables[0]?.start ?? currentTime;
      const lastEnd = line.syllables[line.syllables.length - 1]?.end ?? 0;
      return distributeEvenly(line, from, lastEnd > from ? lastEnd : from + 2);
    });

  const handleExportAss = async () => {
    if (!isTauri()) return;
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      title: 'Export ASS subtitle',
      defaultPath: `${current.name}.ass`,
      filters: [{ name: 'ASS subtitle', extensions: ['ass'] }],
    });
    if (!path) return;
    try {
      await exportAssFile(current, path);
      setStatus(`Wrote ${path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRender = async () => {
    if (!isTauri()) return;
    setError(null);

    if (!(current.duration > 0)) {
      setError('No duration yet — import a video or audio track first.');
      return;
    }
    if (current.lines.length === 0) {
      setError('No lyrics to render. Paste them in the Lyrics tab and press Apply.');
      return;
    }

    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      title: 'Render lyric video',
      defaultPath: `${current.name}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (!path) return;

    setIsRendering(true);
    setRenderProgress(null);
    setStatus('Rendering…');
    try {
      const out = await renderLyricVideo(current, imageMedia, {
        outputPath: path,
        encoder: ffmpeg?.hasNvenc ? 'h264_nvenc' : 'libx264',
        onProgress: setRenderProgress,
      });
      setStatus(`Rendered ${out}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setIsRendering(false);
      setRenderProgress(null);
    }
  };

  /**
   * How many lines fall outside their box and are therefore not drawn.
   *
   * Clipping is deliberate, but it must never be silent — a line vanishing with
   * no explanation is indistinguishable from a bug.
   */
  const clippedCount = useMemo(() => {
    const canvasEl = document.createElement('canvas');
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return 0;
    let count = 0;
    [displayProject.lines, displayProject.romaji?.enabled ? displayProject.romaji.lines : []]
      .forEach((lines, track) => {
        const panel = trackPanel(displayProject, track);
        const style = trackStyle(displayProject, track);
        for (const block of groupIntoBlocks(lines)) {
          let y = panel.y;
          for (const i of block.lines) {
            const layout = layoutLine(ctx, lines[i], style, panel.x, panel.width, y);
            if (!fitsInPanel(panel, y, layout.height)) count++;
            y += layout.height;
          }
        }
      });
    return count;
  }, [displayProject]);

  const pct =
    renderProgress && renderProgress.totalFrames > 0
      ? Math.min(100, (renderProgress.frame / renderProgress.totalFrames) * 100)
      : 0;

  const cursorSyllable =
    tapping.cursor &&
    tapping.preview[tapping.cursor.lineIndex]?.syllables[tapping.cursor.syllableIndex];

  return (
    <div className={styles.studio}>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={onBack}>
          ← Back
        </button>
        <h2 className={styles.title}>{current.name}</h2>
        <div className={styles.headerActions}>
          <button className={styles.ghostBtn} onClick={doc.undo} disabled={!doc.canUndo} title="Ctrl+Z">
            ↶
          </button>
          <button
            className={styles.ghostBtn}
            onClick={doc.redo}
            disabled={!doc.canRedo}
            title="Ctrl+Shift+Z"
          >
            ↷
          </button>
          <button
            className={styles.ghostBtn}
            onClick={isVideoBackground ? handleReplaceVideo : handleImportVideo}
            title={
              isVideoBackground
                ? 'Swap the footage, keeping every lyric timing'
                : 'Import footage to put lyrics over'
            }
          >
            {isVideoBackground ? `Swap: ${current.background.mediaFileName}` : 'Import video'}
          </button>
          <button className={styles.ghostBtn} onClick={handleExportAss} disabled={!isTauri()}>
            Export .ass
          </button>
          <button
            className={styles.primaryBtn}
            onClick={handleRender}
            disabled={isRendering || !isTauri()}
          >
            {isRendering ? `Rendering ${pct.toFixed(0)}%` : 'Render video'}
          </button>
        </div>
      </header>

      {isRendering && (
        <div className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          <span className={styles.progressText}>
            {renderProgress
              ? `frame ${renderProgress.frame} / ${renderProgress.totalFrames} · ${renderProgress.speed}`
              : 'starting ffmpeg…'}
          </span>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}
      {!error && status && <div className={styles.status}>{status}</div>}
      {clippedCount > 0 && (
        <div className={styles.warning}>
          {clippedCount} line{clippedCount === 1 ? '' : 's'} fall outside the text box and will
          not render. Make the box taller, or reduce the line spacing.
        </div>
      )}
      {ffmpeg && !ffmpeg.found && (
        <div className={styles.warning}>
          ffmpeg was not found, so rendering is unavailable. Everything else works — install
          ffmpeg (a build with libass) and reopen the studio.
        </div>
      )}

      <div className={styles.body}>
        <div className={styles.left}>
          <div className={styles.previewArea}>
          <KaraokeCanvas
            project={displayProject}
            time={currentTime}
            media={media}
            mediaVersion={mediaVersion}
            selectedLineIndex={selectedLine}
            selectedTrack={selectedTrack}
            selectedNoteId={selectedNoteId}
            showGrid={showGrid}
            gridDivisions={gridDivisions}
            onPanelTransform={(t: PanelTransform, track: number) => {
              const { scaleX, scaleY, fontSize, lineHeight, ...rect } = t;
              const styleBits = {
                ...(scaleX !== undefined ? { scaleX } : {}),
                ...(scaleY !== undefined ? { scaleY } : {}),
                ...(fontSize !== undefined ? { fontSize } : {}),
                ...(lineHeight !== undefined ? { lineHeight } : {}),
              };
              const touchesStyle = Object.keys(styleBits).length > 0;

              // The gesture reports the row it started on, which may not be the
              // one that was selected when the pointer went down.
              if (track === 1) {
                patchTransient({
                  romaji: {
                    ...current.romaji,
                    panel: { ...current.romaji.panel, ...rect },
                    style: touchesStyle
                      ? { ...current.romaji.style, ...styleBits }
                      : current.romaji.style,
                  },
                });
                return;
              }

              patchTransient({
                panel: { ...current.panel, ...rect },
                ...(touchesStyle ? { style: { ...current.style, ...styleBits } } : {}),
              });
            }}
            onSelectLine={(track, index) => {
              setSelectedTrack(track);
              setSelectedLine(index);
            }}
            onSelectSyllable={(track, l, sy) => {
              setSelectedTrack(track);
              setSelectedLine(l);
              setSelection([{ track, line: l, syllable: sy }]);
              setSelectedNoteId(null);
            }}
            onSelectNote={setSelectedNoteId}
            onNoteChange={(id, p) => handleNoteChange(id, p, true)}
            onDragStart={doc.commit}
          />
          </div>

          <div className={styles.transport}>
            <button className={styles.transportBtn} onClick={togglePlay} disabled={!mediaSrc}>
              {isPlaying ? '❚❚' : '▶'}
            </button>
            <span className={styles.time}>
              {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
            </span>
            <label className={styles.rateGroup} title="Show a proportional grid over the video to align against">
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(e) => setShowGrid(e.target.checked)}
              />
              Grid
              <select
                className={styles.rateSelect}
                value={gridDivisions}
                disabled={!showGrid}
                onChange={(e) => setGridDivisions(Number(e.target.value))}
              >
                <option value={2}>halves</option>
                <option value={3}>thirds</option>
                <option value={4}>quarters</option>
                <option value={6}>sixths</option>
                <option value={12}>twelfths</option>
              </select>
            </label>
            <label className={styles.rateGroup} title="Slow playback down to make live timing easy">
              Speed
              <select
                className={styles.rateSelect}
                value={playbackRate}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
              >
                <option value={0.25}>0.25×</option>
                <option value={0.5}>0.5×</option>
                <option value={0.75}>0.75×</option>
                <option value={1}>1×</option>
              </select>
            </label>
            <button
              className={tapping.isTapping ? styles.tapActive : styles.tapBtn}
              onClick={() => {
                if (tapping.isTapping) {
                  tapping.stop();
                  return;
                }
                doc.commit();
                tapping.start(
                  selectedLine !== null
                    ? { lineIndex: selectedLine, syllableIndex: 0 }
                    : undefined
                );
                mediaRef.current?.play().catch(() => undefined);
              }}
              disabled={current.lines.length === 0}
            >
              {tapping.isTapping ? 'Stop timing (Esc)' : 'Time lyrics'}
            </button>
            {tapping.isTapping && (
              <span className={styles.tapHint}>
                <strong
                  className={tapping.isHolding ? styles.tapHolding : styles.tapNext}
                >
                  {cursorSyllable?.text.trim() || '—'}
                </strong>
                {tapping.isHolding ? ' — holding…' : ' — hold Space while it is sung'}
                <span className={styles.tapKeys}>
                  Backspace undo · Delete merge · Tab skip
                </span>
              </span>
            )}
          </div>

          <KaraokeLane
            peaks={waveform?.peaks ?? null}
            duration={duration || waveform?.duration || 0}
            currentTime={currentTime}
            tracks={tracks}
            trackLabels={['Lyrics', 'Romaji']}
            selectedTrack={selectedTrack}
            selectedLine={selectedLine}
            selection={selection}
            isPlaying={isPlaying}
            snapEnabled={snapEnabled}
            onSnapToggle={setSnapEnabled}
            onSeek={seek}
            onDragStart={doc.commit}
            onTracksChange={(next, isDragging) => setTracks(next, isDragging)}
            onSelectLine={(track, index) => {
              setSelectedTrack(track);
              setSelectedLine(index);
            }}
            onDeleteSelection={handleDeleteSelection}
            onSelectionChange={setSelection}
          />

          <div className={styles.laneTools}>
            <button className={styles.toolBtn} onClick={handleSpread} disabled={!selected}>
              Spread evenly
            </button>
            <button
              className={styles.toolBtn}
              onClick={() => withSelectedLine(closeGaps)}
              disabled={!selected}
              title="Pull every word flush against the previous one"
            >
              Close gaps
            </button>
            <button
              className={styles.toolBtn}
              onClick={() => withSelectedLine((l) => shiftLine(l, -0.05))}
              disabled={!selected}
            >
              −50ms
            </button>
            <button
              className={styles.toolBtn}
              onClick={() => withSelectedLine((l) => shiftLine(l, 0.05))}
              disabled={!selected}
            >
              +50ms
            </button>
            <button
              className={styles.toolBtn}
              onClick={() =>
                selectedSyllable !== null &&
                withSelectedLine((l) => mergeSyllable(l, selectedSyllable))
              }
              disabled={selectedSyllable === null}
            >
              Merge with next
            </button>
            <button
              className={styles.toolBtn}
              onClick={() =>
                selectedSyllable !== null &&
                withSelectedLine((l) => {
                  const syl = l.syllables[selectedSyllable];
                  if (!syl) return l;
                  return splitSyllable(
                    l,
                    selectedSyllable,
                    Math.floor(Array.from(syl.text).length / 2)
                  );
                })
              }
              disabled={selectedSyllable === null}
            >
              Split word
            </button>
            <button
              className={styles.toolBtn}
              onClick={handleToggleStrike}
              disabled={selectedSyllable === null}
              title="Strike the word through — sing the other one instead"
            >
              <s>Strikethrough</s>
            </button>
            <button
              className={styles.toolBtn}
              onClick={() => {
                if (selectedLine === null) return;
                const line = current.lines[selectedLine];
                if (!line) return;
                setSelection(
                  line.syllables.map((_, i) => ({
                    track: selectedTrack,
                    line: selectedLine,
                    syllable: i,
                  }))
                );
              }}
              disabled={selectedLine === null}
              title="Select every word on this line so they drag together"
            >
              Select all
            </button>
          </div>
        </div>

        <aside className={styles.right}>
          <div className={styles.tabs}>
            <button
              className={tab === 'lyrics' ? styles.tabActive : styles.tab}
              onClick={() => setTab('lyrics')}
            >
              Lyrics
            </button>
            <button
              className={tab === 'style' ? styles.tabActive : styles.tab}
              onClick={() => setTab('style')}
            >
              Style
            </button>
          </div>

          {tab === 'lyrics' ? (
            <div className={styles.lyricsPane}>
              <textarea
                className={styles.lyricInput}
                value={lyricText}
                placeholder={'One line per lyric line…'}
                spellCheck={false}
                onChange={(e) => setLyricText(e.target.value)}
              />
              <div className={styles.buttonRow}>
                <button
                  className={styles.primaryBtn}
                  onClick={handleAddBlock}
                  title="Add these lines as a new block starting at the playhead, keeping everything already timed"
                >
                  + Add block at playhead
                </button>
              </div>
              <div className={styles.buttonRow}>
                <button
                  className={styles.toolBtn}
                  onClick={handleApplyLyrics}
                  title="Replace every line in the project with this text"
                >
                  Replace all
                </button>
                <button className={styles.toolBtn} onClick={handleAddNote}>
                  + Text box
                </button>
                <button className={styles.toolBtn} onClick={handleLoadFont}>
                  Load font
                </button>
              </div>
              <div className={styles.buttonRow}>
                <button className={styles.toolBtn} onClick={handlePickArtwork}>
                  Still image
                </button>
                <button className={styles.toolBtn} onClick={handlePickAudio}>
                  Separate audio
                </button>
              </div>
              <div className={styles.buttonRow}>
                <button className={styles.toolBtn} onClick={handleCopyLyrics} title="Copy lyrics and timings to the clipboard">
                  Copy
                </button>
                <button className={styles.toolBtn} onClick={handlePasteLyrics} title="Paste lyrics and timings from the clipboard">
                  Paste
                </button>
                <button className={styles.toolBtn} onClick={handleExportLyrics} disabled={!isTauri()}>
                  Export
                </button>
                <button className={styles.toolBtn} onClick={handleImportLyrics} disabled={!isTauri()}>
                  Import
                </button>
              </div>
              <div className={styles.romajiPane}>
                <label className={styles.modeRow}>
                  <span>Romaji row</span>
                  <button
                    className={current.romaji?.enabled ? styles.toolBtnActive : styles.toolBtn}
                    onClick={handleToggleRomaji}
                    title="Show a second lyric row beneath the main one"
                  >
                    {current.romaji?.enabled ? 'On' : 'Off'}
                  </button>
                </label>
                {current.romaji?.enabled && (
                  <>
                    <textarea
                      className={styles.romajiInput}
                      value={romajiText}
                      placeholder={'One romaji line per lyric line above…'}
                      spellCheck={false}
                      onChange={(e) => setRomajiText(e.target.value)}
                    />
                    <div className={styles.buttonRow}>
                      <button className={styles.toolBtn} onClick={handleApplyRomaji}>
                        Apply romaji
                      </button>
                      <button
                        className={styles.toolBtn}
                        onClick={() =>
                          setRomajiText(current.romaji.lines.map(lineText).join('\n'))
                        }
                        title="Reload the text from the timed romaji lines"
                      >
                        Reload
                      </button>
                    </div>
                    <p className={styles.hint}>
                      Line 1 here pairs with line 1 above and inherits its timing, so you only
                      need to adjust rather than re-time.
                    </p>
                  </>
                )}
              </div>

              <div className={styles.romajiPane}>
                <label className={styles.modeRow}>
                  <span>Show lyrics early</span>
                  <select
                    className={styles.modeSelect}
                    value={
                      current.blockFillGaps ? 'fill' : String(current.blockLeadIn ?? 0)
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      patch(
                        v === 'fill'
                          ? { blockFillGaps: true }
                          : { blockFillGaps: false, blockLeadIn: Number(v) }
                      );
                    }}
                  >
                    <option value="0">On cue — appear with the first word</option>
                    <option value="1">1s early</option>
                    <option value="2">2s early</option>
                    <option value="3">3s early</option>
                    <option value="5">5s early</option>
                    <option value="fill">Always on screen — no blank gaps</option>
                  </select>
                </label>
                <label className={styles.modeRow}>
                  <span>Hide lyrics after</span>
                  <select
                    className={styles.modeSelect}
                    value={
                      current.blockHoldOut === null || current.blockHoldOut === undefined
                        ? 'next'
                        : String(current.blockHoldOut)
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      patch({ blockHoldOut: v === 'next' ? null : Number(v) });
                    }}
                  >
                    <option value="0">As the last word ends</option>
                    <option value="0.5">0.5s after the last word</option>
                    <option value="1.5">1.5s after the last word</option>
                    <option value="3">3s after the last word</option>
                    <option value="next">Stay up until the next block</option>
                  </select>
                </label>
                <p className={styles.hint}>
                  Applies to every block. A block never comes up before the one before it has
                  finished, so they cannot overlap. “Stay up until the next block” leaves the
                  final block on screen for the rest of the video.
                </p>
              </div>

              <label className={styles.modeRow}>
                <span>Latin text</span>
                <select
                  className={styles.modeSelect}
                  value={current.latinMode ?? 'word'}
                  onChange={(e) =>
                    patch({ latinMode: e.target.value as LyricProject['latinMode'] })
                  }
                >
                  <option value="word">Per word — English</option>
                  <option value="romaji">Per syllable — romaji</option>
                </select>
              </label>
              <p className={styles.hint}>
                Korean splits per syllable, English per word. Merge or split any unit on the
                lane, and hold Space to time each one.
              </p>

              <div className={styles.lineListHead}>
                <span>{selectedTrack === 1 ? 'Romaji lines' : 'Lyric lines'}</span>
                <span className={styles.lineListHint}>edit the text to change the words</span>
              </div>
              <div className={styles.buttonRow}>
                <button
                  className={styles.toolBtn}
                  onClick={handleSplitLine}
                  disabled={selectedSyllable === null}
                  title="Break this line in two before the selected word"
                >
                  Split line here
                </button>
                <button
                  className={styles.toolBtn}
                  onClick={handleMergeLine}
                  disabled={selectedLine === null}
                  title="Pull the line below up onto this one"
                >
                  Join with next
                </button>
              </div>

              <ul className={styles.lineList}>
                {(selectedTrack === 1
                  ? displayProject.romaji?.lines ?? []
                  : displayProject.lines
                ).map((line, i) => {
                  const timed = line.syllables.some((s) => s.end > s.start);
                  return (
                    <li
                      key={line.id}
                      className={i === selectedLine ? styles.lineItemActive : styles.lineItem}
                      onClick={() => {
                        setSelectedLine(i);
                        setSelection([]);
                        const first = line.syllables[0];
                        if (first && first.end > first.start) seek(first.start);
                      }}
                    >
                      <span className={timed ? styles.dotTimed : styles.dot} />
                      <LineTextField
                        value={lineText(line)}
                        onCommit={(text) => handleEditLine(selectedTrack, i, text)}
                        onFocus={() => {
                          setSelectedLine(i);
                          setSelection([]);
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <KaraokeStylePanel
              project={current}
              selectedTrack={selectedTrack}
              onSelectTrack={setSelectedTrack}
              selectedLineIndex={selectedLine}
              selectedSyllable={selectedSyllable}
              onStyleChange={(p: Partial<KaraokeStyle>) => {
                // Romaji stores overrides only, so anything left alone keeps
                // following the main lyric style.
                if (selectedTrack === 1) {
                  patch(
                    { romaji: { ...current.romaji, style: { ...current.romaji.style, ...p } } },
                    { coalesce: true }
                  );
                  return;
                }
                patch({ style: { ...current.style, ...p } }, { coalesce: true });
              }}
              onResetTrackStyle={() =>
                patch({ romaji: { ...current.romaji, style: {} } })
              }
              onPanelChange={(p) => {
                if (selectedTrack === 1) {
                  patch(
                    { romaji: { ...current.romaji, panel: { ...current.romaji.panel, ...p } } },
                    { coalesce: true }
                  );
                  return;
                }
                patch({ panel: { ...current.panel, ...p } }, { coalesce: true });
              }}
              onProjectChange={(p) => patch(p, { coalesce: true })}
              onLineChange={(index, p) => {
                const line = current.lines[index];
                if (line) handleLineChange(index, { ...line, ...p });
              }}
              onSyllableColor={handleSyllableColor}
              selectedNoteId={selectedNoteId}
              onSyllableStrike={handleToggleStrike}
              onSyllableAlpha={handleSyllableAlpha}
              onNoteChange={(id, p) => handleNoteChange(id, p)}
              onNoteDelete={handleDeleteNote}
              onSelectNote={setSelectedNoteId}
            />
          )}
        </aside>
      </div>

      {mediaSrc && (
        <video
          ref={mediaRef}
          src={mediaSrc}
          // Hidden: every visible frame is painted onto the preview canvas.
          className={styles.hiddenMedia}
          playsInline
          preload="auto"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onSeeked={() => setMediaVersion((v) => v + 1)}
          onLoadedData={() => setMediaVersion((v) => v + 1)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0 && Math.abs(d - current.duration) > 0.01) {
              patchTransient({ duration: d });
            }
            setMediaVersion((v) => v + 1);
          }}
          onError={() => setError('Could not play that media file.')}
        />
      )}
    </div>
  );
}
