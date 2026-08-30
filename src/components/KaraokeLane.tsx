import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Annotation } from '../types/karaoke';
import { SyllableRef, TrackLines, moveSelection, setSyllableBoundary } from '../utils/karaokeText';
import styles from './KaraokeLane.module.css';

interface KaraokeLaneProps {
  peaks: Float32Array | null;
  duration: number;
  currentTime: number;
  /** Lyric lines per track: main first, romaji second. */
  tracks: TrackLines;
  /** Labels shown at the left of each track row. */
  trackLabels: string[];
  selectedTrack: number;
  selectedLine: number | null;
  /** Selected blocks, which may span more than one lyric line. */
  selection: SyllableRef[];
  isPlaying: boolean;
  snapEnabled: boolean;
  onSnapToggle: (enabled: boolean) => void;
  onSeek: (time: number) => void;
  onDragStart: () => void;
  onTracksChange: (tracks: TrackLines, isDragging: boolean) => void;
  onSelectLine: (track: number, index: number) => void;
  onDeleteSelection: () => void;
  onSelectionChange: (refs: SyllableRef[]) => void;
  /** Rename a single word straight from its block on the lane. */
  onEditSyllable: (ref: SyllableRef, text: string) => void;
  /** Text boxes, shown on their own row so their timing can be dragged. */
  notes: Annotation[];
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onNoteTimingChange: (
    id: string,
    patch: { appearAt?: number | null; disappearAt?: number | null },
    isDragging: boolean
  ) => void;
}

const MIN_WINDOW = 0.4;
const WAVE_HEIGHT = 60;
const ROW_HEIGHT = 40;
/** Distinguishes which lyric line a block belongs to, now they share one row. */
const LINE_COLORS = [
  '#5aaaff', '#57c07a', '#ffb45a', '#c88cff', '#ff7a8a', '#4fd6d2', '#e0d15a', '#8fa6ff',
];

const refKey = (track: number, line: number, syllable: number) =>
  `${track}:${line}:${syllable}`;

/**
 * Timing lane.
 *
 * Every lyric line shares a single row: the song is one sequence of words, and
 * stacking lines made short blocks tiny and the eye travel. Colour identifies
 * which line a block came from, and selection can span lines so a whole section
 * drags together.
 */
export function KaraokeLane({
  peaks,
  duration,
  currentTime,
  tracks,
  trackLabels,
  selectedTrack,
  selectedLine,
  selection,
  isPlaying,
  snapEnabled,
  onSnapToggle,
  onSeek,
  onDragStart,
  onTracksChange,
  onSelectLine,
  onDeleteSelection,
  onSelectionChange,
  onEditSyllable,
  notes,
  selectedNoteId,
  onSelectNote,
  onNoteTimingChange,
}: KaraokeLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [marquee, setMarquee] = useState<{
    from: number;
    to: number;
    top: number;
    bottom: number;
  } | null>(null);
  // The block being renamed in place, and its draft text.
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);

  const dragRef = useRef<
    | { kind: 'edge'; track: number; line: number; index: number; edge: 'start' | 'end' }
    | { kind: 'move'; grabTime: number; moved: boolean }
    | {
        kind: 'marquee';
        anchor: number;
        anchorY: number;
        additive: boolean;
        moved: boolean;
      }
    | { kind: 'note'; id: string; edge: 'start' | 'end' | 'move'; grabOffset: number }
    | null
  >(null);
  // The lines as they were when the drag began, so each move re-derives from a
  // stable base instead of compounding rounding on every pointer event.
  const dragBaseRef = useRef<TrackLines | null>(null);

  const clampView = useCallback(
    (start: number, end: number) => {
      const total = Math.max(MIN_WINDOW, duration || MIN_WINDOW);
      const span = Math.max(MIN_WINDOW, Math.min(end - start, total));
      if (span >= total) return { start: 0, end: total };
      const s = Math.max(0, Math.min(start, total - span));
      return { start: s, end: s + span };
    },
    [duration]
  );

  const frameRange = useCallback(
    (from: number, to: number) => {
      const pad = Math.max(0.35, (to - from) * 0.25);
      setView(clampView(from - pad, to + pad));
    },
    [clampView]
  );

  useEffect(() => {
    if (duration > 0 && view.end === 0) setView({ start: 0, end: duration });
  }, [duration, view.end]);

  const line = selectedLine !== null ? tracks[selectedTrack]?.[selectedLine] ?? null : null;
  const lineId = line?.id;
  useEffect(() => {
    if (!line || line.syllables.length === 0 || duration <= 0) return;
    const from = Math.min(...line.syllables.map((s) => s.start));
    const to = Math.max(...line.syllables.map((s) => s.end));
    if (to > from) frameRange(from, to);
  }, [lineId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isPlaying) return;
    if (currentTime >= view.start && currentTime <= view.end) return;
    const span = view.end - view.start;
    setView(clampView(currentTime - span * 0.3, currentTime + span * 0.7));
  }, [currentTime, isPlaying, view.start, view.end, clampView]);

  const span = view.end - view.start || 1;
  const timeToX = useCallback(
    (t: number) => ((t - view.start) / span) * width,
    [view.start, span, width]
  );
  const xToTime = useCallback(
    (x: number) => view.start + (x / width) * span,
    [view.start, span, width]
  );

  const zoomAround = useCallback(
    (factor: number, anchorTime: number) => {
      const newSpan = Math.max(MIN_WINDOW, span * factor);
      // Keep the anchor under the cursor: preserve its fractional position.
      const ratio = span === 0 ? 0.5 : (anchorTime - view.start) / span;
      setView(clampView(anchorTime - ratio * newSpan, anchorTime + (1 - ratio) * newSpan));
    },
    [span, view.start, clampView]
  );

  const panBy = useCallback(
    (seconds: number) => setView(clampView(view.start + seconds, view.end + seconds)),
    [view, clampView]
  );

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Ctrl+wheel zooms about the cursor, Alt+wheel pans. Registered natively and
   * non-passive so the browser's own page zoom and scroll can be prevented.
   */
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        // Trackpads report horizontal intent in deltaX; wheels only have deltaY.
        const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        panBy((raw / rect.width) * span * 1.5);
        return;
      }

      const anchor = xToTime(e.clientX - rect.left);
      zoomAround(e.deltaY > 0 ? 1.18 : 1 / 1.18, anchor);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround, panBy, xToTime, span]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(WAVE_HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, WAVE_HEIGHT);
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, 0, width, WAVE_HEIGHT);

    if (!peaks || peaks.length === 0 || duration <= 0) return;

    const mid = WAVE_HEIGHT / 2;
    ctx.fillStyle = '#3d6b8f';
    for (let x = 0; x < width; x++) {
      const t0 = xToTime(x);
      const t1 = xToTime(x + 1);
      const i0 = Math.max(0, Math.floor((t0 / duration) * peaks.length));
      const i1 = Math.min(
        peaks.length,
        Math.max(i0 + 1, Math.ceil((t1 / duration) * peaks.length))
      );
      let peak = 0;
      for (let i = i0; i < i1; i++) if (peaks[i] > peak) peak = peaks[i];
      const half = Math.max(0.5, peak * mid * 0.92);
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }, [peaks, duration, width, xToTime]);

  const pointerTime = (e: React.PointerEvent) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration || Infinity, xToTime(e.clientX - rect.left)));
  };

  /** Pointer position measured down from the top of the track. */
  const pointerY = (e: React.PointerEvent) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return e.clientY - rect.top;
  };

  /** Vertical extent of a track's row within the lane, sub-lanes included. */
  const rowBounds = (track: number) => {
    if (!visibleTracks.includes(track)) return null;
    const top = trackTop(track);
    return { top, bottom: top + trackHeight(track) };
  };

  const selectedSet = useMemo(
    () => new Set(selection.map((r) => refKey(r.track, r.line, r.syllable))),
    [selection]
  );

  // A track with no lines gets no row, so the lane stays compact until the
  // romaji track is actually in use.
  const visibleTracks = useMemo(
    () => tracks.map((_, i) => i).filter((i) => i === 0 || (tracks[i]?.length ?? 0) > 0),
    [tracks]
  );

  /**
   * Which sub-lane each line sits in, per track.
   *
   * Lines normally follow one another and all sit in the first, which is what
   * keeps the lane compact. When two overlap in time — dragged past each other,
   * or timed that way on purpose — stacking them at the same height leaves one
   * hidden under the other and neither reliably clickable, so the later one
   * steps down into a lane of its own.
   */
  const laneLayout = useMemo(
    () =>
      tracks.map((lines) => {
        const spans = lines.map((line, index) => {
          const timed = line.syllables.filter((sy) => sy.end > sy.start);
          if (timed.length === 0) return null;
          return {
            index,
            start: Math.min(...timed.map((sy) => sy.start)),
            end: Math.max(...timed.map((sy) => sy.end)),
          };
        });

        const lane = new Map<number, number>();
        const lastEnd: number[] = [];
        // In sung order, so the packing follows the song rather than the order
        // the lines happen to be stored in.
        for (const span of spans
          .filter((sp): sp is NonNullable<typeof sp> => sp !== null)
          .sort((a, b) => a.start - b.start)) {
          let slot = lastEnd.findIndex((end) => end <= span.start + 1e-6);
          if (slot < 0) slot = lastEnd.length;
          lastEnd[slot] = span.end;
          lane.set(span.index, slot);
        }
        return { lane, count: Math.max(1, lastEnd.length) };
      }),
    [tracks]
  );

  /** How tall a track's row is, once its sub-lanes are counted. */
  const trackHeight = useCallback(
    (track: number) => (laneLayout[track]?.count ?? 1) * ROW_HEIGHT,
    [laneLayout]
  );

  const trackTop = useCallback(
    (track: number) => {
      let top = WAVE_HEIGHT;
      for (const other of visibleTracks) {
        if (other === track) break;
        top += trackHeight(other);
      }
      return top;
    },
    [visibleTracks, trackHeight]
  );

  const lyricRowsHeight = visibleTracks.reduce((total, t) => total + trackHeight(t), 0);

  // Text boxes get their own row under the lyric rows, but only once there is
  // one to show.
  const noteRowTop = WAVE_HEIGHT + lyricRowsHeight;
  const showNoteRow = notes.length > 0;

  // Delete removes the selected blocks. Ignored while typing so it does not
  // eat backspaces in the lyric box.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code !== 'Delete' && e.code !== 'Backspace') return;
      if (selection.length === 0) return;
      e.preventDefault();
      onDeleteSelection();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selection, onDeleteSelection]);

  const handleBlockPointerDown = (
    e: React.PointerEvent,
    track: number,
    lineIndex: number,
    index: number
  ) => {
    e.stopPropagation();
    const key = refKey(track, lineIndex, index);
    const additive = e.ctrlKey || e.metaKey;

    let next: SyllableRef[];
    if (additive) {
      next = selectedSet.has(key)
        ? selection.filter((r) => refKey(r.track, r.line, r.syllable) !== key)
        : [...selection, { track, line: lineIndex, syllable: index }];
    } else if (e.shiftKey && selection.length > 0) {
      // Extend across everything between the existing selection and this block,
      // staying within the clicked track.
      const all = [
        ...selection.filter((r) => r.track === track),
        { track, line: lineIndex, syllable: index },
      ];
      const loLine = Math.min(...all.map((r) => r.line));
      const hiLine = Math.max(...all.map((r) => r.line));
      next = selection.filter((r) => r.track !== track);
      for (let l = loLine; l <= hiLine; l++) {
        const inLine = all.filter((r) => r.line === l).map((r) => r.syllable);
        const from = l === loLine && inLine.length ? Math.min(...inLine) : 0;
        const to =
          l === hiLine && inLine.length
            ? Math.max(...inLine)
            : (tracks[track]?.[l]?.syllables.length ?? 1) - 1;
        for (let sy = from; sy <= to; sy++) next.push({ track, line: l, syllable: sy });
      }
    } else if (selectedSet.has(key)) {
      next = selection;
    } else {
      next = [{ track, line: lineIndex, syllable: index }];
    }

    onSelectionChange(next);
    if (track !== selectedTrack || lineIndex !== selectedLine) onSelectLine(track, lineIndex);
    if (next.length === 0) return;

    onDragStart();
    dragBaseRef.current = tracks;
    dragRef.current = { kind: 'move', grabTime: pointerTime(e), moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const startEdgeDrag = (
    e: React.PointerEvent,
    track: number,
    lineIndex: number,
    index: number,
    edge: 'start' | 'end'
  ) => {
    e.stopPropagation();
    onDragStart();
    dragBaseRef.current = tracks;
    dragRef.current = { kind: 'edge', track, line: lineIndex, index, edge };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  /** Plain drag on empty track rubber-bands; a plain click seeks. */
  const handleTrackPointerDown = (e: React.PointerEvent) => {
    if (dragRef.current) return;
    const t = pointerTime(e);
    const y = pointerY(e);
    dragRef.current = {
      kind: 'marquee',
      anchor: t,
      anchorY: y,
      additive: e.ctrlKey || e.metaKey || e.shiftKey,
      moved: false,
    };
    setMarquee({ from: t, to: t, top: y, bottom: y });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const startNoteDrag = (
    e: React.PointerEvent,
    id: string,
    edge: 'start' | 'end' | 'move',
    from: number
  ) => {
    e.stopPropagation();
    onSelectNote(id);
    onDragStart();
    dragRef.current = {
      kind: 'note',
      id,
      edge,
      grabOffset: edge === 'move' ? pointerTime(e) - from : 0,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const t = pointerTime(e);

    if (drag.kind === 'note') {
      const note = notes.find((n) => n.id === drag.id);
      if (!note) return;
      const from = note.appearAt ?? 0;
      const to = note.disappearAt ?? from + 2;
      if (drag.edge === 'move') {
        const start = Math.max(0, t - drag.grabOffset);
        onNoteTimingChange(drag.id, { appearAt: start, disappearAt: start + (to - from) }, true);
      } else if (drag.edge === 'start') {
        onNoteTimingChange(drag.id, { appearAt: Math.max(0, Math.min(t, to - 0.1)) }, true);
      } else {
        onNoteTimingChange(drag.id, { disappearAt: Math.max(t, from + 0.1) }, true);
      }
      return;
    }

    if (drag.kind === 'marquee') {
      drag.moved = true;
      const y = pointerY(e);
      setMarquee({
        from: Math.min(drag.anchor, t),
        to: Math.max(drag.anchor, t),
        top: Math.min(drag.anchorY, y),
        bottom: Math.max(drag.anchorY, y),
      });
      return;
    }

    const base = dragBaseRef.current;
    if (!base) return;

    if (drag.kind === 'move') {
      drag.moved = true;
      onTracksChange(moveSelection(base, selection, t - drag.grabTime), true);
      return;
    }

    const target = base[drag.track]?.[drag.line];
    if (!target) return;
    const snapWindow = (12 / width) * span;
    const updated = setSyllableBoundary(target, drag.index, drag.edge, t, {
      snap: snapEnabled,
      snapWindow,
    });
    const next = base.map((lines, i) =>
      i === drag.track ? lines.map((l, j) => (j === drag.line ? updated : l)) : lines
    );
    onTracksChange(next, true);
  };

  const endDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;

    if (drag?.kind === 'marquee') {
      if (!drag.moved || (marquee && Math.abs(marquee.to - marquee.from) < 0.01)) {
        // No movement: treat it as a click on the ruler.
        onSeek(drag.anchor);
        if (!drag.additive) onSelectionChange([]);
      } else if (marquee) {
        // Only rows the rubber band actually covers. Dragging inside the
        // lyrics row must not sweep up the romaji beneath it.
        const picked: SyllableRef[] = [];
        tracks.forEach((lines, track) => {
          const bounds = rowBounds(track);
          if (!bounds) return;
          if (marquee.bottom < bounds.top || marquee.top > bounds.bottom) return;

          lines.forEach((l, lineIndex) => {
            // Down to the sub-lane, not just the track: two lines stacked
            // because they overlap can be rubber-banded apart, which is the
            // whole reason for stacking them.
            const lane = laneLayout[track]?.lane.get(lineIndex) ?? 0;
            const laneTop = bounds.top + lane * ROW_HEIGHT;
            if (marquee.bottom < laneTop || marquee.top > laneTop + ROW_HEIGHT) return;

            l.syllables.forEach((syl, i) => {
              if (syl.end > marquee.from && syl.start < marquee.to) {
                picked.push({ track, line: lineIndex, syllable: i });
              }
            });
          });
        });
        const merged = drag.additive ? [...selection, ...picked] : picked;
        const seen = new Set<string>();
        const unique = merged.filter((r) => {
          const k = refKey(r.track, r.line, r.syllable);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        onSelectionChange(unique);
        const first = unique[0];
        if (first && (first.track !== selectedTrack || first.line !== selectedLine)) {
          onSelectLine(first.track, first.line);
        }
      }
    } else if (drag?.kind === 'note') {
      // Commit one undo entry for the whole gesture.
      const note = notes.find((n) => n.id === drag.id);
      if (note) {
        onNoteTimingChange(
          drag.id,
          { appearAt: note.appearAt, disappearAt: note.disappearAt },
          false
        );
      }
    } else if (drag && dragBaseRef.current) {
      onTracksChange(tracks, false);
    }

    dragRef.current = null;
    dragBaseRef.current = null;
    setMarquee(null);
    const target = e.currentTarget as Element;
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
  };

  const playheadX = timeToX(currentTime);

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <span className={styles.label}>
          {selection.length > 1
            ? `${selection.length} selected — Delete to remove`
            : 'Drag to select · Ctrl+wheel zoom · Alt+wheel pan'}
        </span>
        <div className={styles.zoomGroup}>
          <label className={styles.snapToggle} title="Snap a dragged edge onto its neighbour">
            <input
              type="checkbox"
              checked={snapEnabled}
              onChange={(e) => onSnapToggle(e.target.checked)}
            />
            Magnet
          </label>
          <button
            className={styles.zoomBtn}
            onClick={() => zoomAround(1.6, (view.start + view.end) / 2)}
            title="Zoom out"
          >
            −
          </button>
          <span className={styles.zoomLevel}>{span.toFixed(1)}s</span>
          <button
            className={styles.zoomBtn}
            onClick={() => zoomAround(1 / 1.6, (view.start + view.end) / 2)}
            title="Zoom in"
          >
            +
          </button>
          <button
            className={styles.zoomBtn}
            onClick={() => {
              if (!line || line.syllables.length === 0) return;
              frameRange(
                Math.min(...line.syllables.map((s) => s.start)),
                Math.max(...line.syllables.map((s) => s.end))
              );
            }}
            disabled={!line}
            title="Frame the selected line"
          >
            ⤢
          </button>
          <button
            className={styles.zoomBtn}
            onClick={() => setView({ start: 0, end: Math.max(MIN_WINDOW, duration) })}
            title="Show the whole track"
          >
            ⤡
          </button>
          <button
            className={styles.zoomBtn}
            onClick={onDeleteSelection}
            disabled={selection.length === 0}
            title="Delete the selected blocks"
          >
            🗑
          </button>
        </div>
      </div>

      <div
        className={styles.track}
        ref={trackRef}
        style={{
          height: WAVE_HEIGHT + lyricRowsHeight + (showNoteRow ? ROW_HEIGHT : 0),
        }}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <canvas ref={canvasRef} className={styles.canvas} style={{ width, height: WAVE_HEIGHT }} />

        {visibleTracks.map((track) => (
          <div
            key={track}
            className={styles.row}
            style={{ top: trackTop(track), height: trackHeight(track) }}
          >
            {visibleTracks.length > 1 && (
              <span className={styles.rowLabel}>{trackLabels[track] ?? `Track ${track + 1}`}</span>
            )}
            {(tracks[track] ?? []).map((l, lineIndex) =>
              l.syllables.map((syl, i) => {
                const left = timeToX(syl.start);
                const right = timeToX(syl.end);
                if (right < -40 || left > width + 40) return null;
                const active = currentTime >= syl.start && currentTime < syl.end;
                const key = refKey(track, lineIndex, i);
                const isEditing = editing?.key === key;
                const picked = selectedSet.has(key);
                const colour = LINE_COLORS[lineIndex % LINE_COLORS.length];
                const current = track === selectedTrack && lineIndex === selectedLine;
                const lane = laneLayout[track]?.lane.get(lineIndex) ?? 0;
                return (
                  <div
                    key={`${l.id}-${i}`}
                    className={[
                      styles.block,
                      isEditing ? styles.blockEditing : '',
                      current ? '' : styles.blockDim,
                      active ? styles.blockActive : '',
                      picked ? styles.blockSelected : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{
                      left,
                      width: Math.max(2, right - left),
                      top: lane * ROW_HEIGHT + 5,
                      height: ROW_HEIGHT - 10,
                      borderColor: colour,
                      background: picked ? undefined : `${colour}33`,
                    }}
                    onPointerDown={(e) => {
                      if (isEditing) {
                        e.stopPropagation();
                        return;
                      }
                      handleBlockPointerDown(e, track, lineIndex, i);
                    }}
                    onPointerMove={handlePointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditing({ key, text: syl.text.trim() });
                    }}
                    title={
                      isEditing
                        ? undefined
                        : `${syl.text.trim()} — ${syl.start.toFixed(2)}s -> ${syl.end.toFixed(
                            2
                          )}s · double-click to rename`
                    }
                  >
                    {isEditing && editing ? (
                      <input
                        className={styles.blockInput}
                        autoFocus
                        value={editing.text}
                        spellCheck={false}
                        onChange={(e) => setEditing({ key, text: e.target.value })}
                        onPointerDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onBlur={() => {
                          const text = editing.text;
                          setEditing(null);
                          if (text.trim() !== syl.text.trim()) {
                            onEditSyllable({ track, line: lineIndex, syllable: i }, text);
                          }
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditing(null);
                          }
                        }}
                      />
                    ) : (
                      <>
                        <span
                          className={styles.handleLeft}
                          onPointerDown={(e) => startEdgeDrag(e, track, lineIndex, i, 'start')}
                          onPointerMove={handlePointerMove}
                          onPointerUp={endDrag}
                        />
                        <span className={styles.blockText}>{syl.text.trim()}</span>
                        <span
                          className={styles.handleRight}
                          onPointerDown={(e) => startEdgeDrag(e, track, lineIndex, i, 'end')}
                          onPointerMove={handlePointerMove}
                          onPointerUp={endDrag}
                        />
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ))}

        {showNoteRow && (
          <div className={styles.row} style={{ top: noteRowTop, height: ROW_HEIGHT }}>
            <span className={styles.rowLabel}>Text boxes</span>
            {notes.map((note) => {
              const from = note.appearAt ?? 0;
              const to = note.disappearAt ?? duration;
              const left = timeToX(from);
              const right = timeToX(to);
              if (right < -40 || left > width + 40) return null;
              // The extra time the box is on screen either side of its span,
              // drawn behind it so the difference between "showing" and "being
              // sung" is visible while dragging.
              const haloLeft = timeToX(Math.max(0, from - (note.leadIn ?? 0)));
              const haloRight = timeToX(to + (note.holdOut ?? 0));
              return (
                <Fragment key={note.id}>
                {haloRight - haloLeft > right - left && (
                  <div
                    className={styles.noteHalo}
                    style={{ left: haloLeft, width: Math.max(6, haloRight - haloLeft) }}
                  />
                )}
                <div
                  className={[
                    styles.block,
                    styles.noteBlock,
                    note.id === selectedNoteId ? styles.blockSelected : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left, width: Math.max(6, right - left) }}
                  onPointerDown={(e) => startNoteDrag(e, note.id, 'move', from)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  title={
                    `${note.text} — sung ${from.toFixed(2)}s to ${to.toFixed(2)}s` +
                    (note.leadIn || note.holdOut
                      ? `, on screen ${(from - (note.leadIn ?? 0)).toFixed(2)}s to ` +
                        `${(to + (note.holdOut ?? 0)).toFixed(2)}s`
                      : '')
                  }
                >
                  <span
                    className={styles.handleLeft}
                    onPointerDown={(e) => startNoteDrag(e, note.id, 'start', from)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={endDrag}
                  />
                  <span className={styles.blockText}>{note.text}</span>
                  <span
                    className={styles.handleRight}
                    onPointerDown={(e) => startNoteDrag(e, note.id, 'end', from)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={endDrag}
                  />
                </div>
                </Fragment>
              );
            })}
          </div>
        )}

        {marquee && (
          <div
            className={styles.marquee}
            style={{
              left: timeToX(marquee.from),
              width: Math.max(1, timeToX(marquee.to) - timeToX(marquee.from)),
              top: Math.max(0, Math.min(marquee.top, marquee.bottom)),
              height: Math.max(2, Math.abs(marquee.bottom - marquee.top)),
            }}
          />
        )}

        <div
          className={`${styles.playhead} ${isPlaying ? styles.playheadLive : ''}`}
          style={{ left: playheadX }}
        />
      </div>
    </div>
  );
}
