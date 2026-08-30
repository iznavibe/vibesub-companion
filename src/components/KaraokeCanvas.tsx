import { useCallback, useEffect, useRef, useState } from 'react';
import { Annotation, LyricProject } from '../types/karaoke';
import {
  BackgroundSource,
  annotationBounds,
  drawFrame,
  layoutLine,
  isLineVisible,
  trackLines,
  trackPanel,
  trackStyle,
} from '../utils/karaokeRenderer';
import { groupIntoBlocks } from '../utils/karaokeText';
import styles from './KaraokeCanvas.module.css';

/** Project-space guide positions, or null when nothing is aligned. */
interface Guides {
  vertical: number | null;
  horizontal: number | null;
}

/** Which part of the transform box is being dragged. */
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type DragTarget =
  | { kind: 'panel-move' }
  | { kind: 'panel-resize'; handle: Handle }
  | { kind: 'note-move'; id: string }
  | { kind: 'note-resize'; id: string };

interface DragState {
  target: DragTarget;
  /**
   * The track this gesture edits, captured at pointer-down.
   *
   * Clicking a row also selects it, but that state lands a render later. Taking
   * the origin from the freshly hit track — rather than from whichever was
   * selected before — is what stops the box jumping to the other row's position
   * on the first move.
   */
  track: number;
  grabX: number;
  grabY: number;
  origin: {
    x: number;
    y: number;
    width: number;
    height: number;
    scaleX: number;
    scaleY: number;
    fontSize: number;
    lineHeight: number;
  };
}

export interface PanelTransform {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scaleX?: number;
  scaleY?: number;
  fontSize?: number;
  lineHeight?: number;
}

interface KaraokeCanvasProps {
  project: LyricProject;
  time: number;
  media: BackgroundSource | null;
  mediaVersion?: number;
  selectedLineIndex: number | null;
  /** Which lyric row the transform box and style edits act on. */
  selectedTrack: number;
  selectedNoteId: string | null;
  /** Proportional alignment grid. 0 divisions hides it. */
  gridDivisions: number;
  showGrid: boolean;
  onPanelTransform: (patch: PanelTransform, track: number) => void;
  onSelectLine: (track: number, index: number) => void;
  onSelectSyllable: (track: number, lineIndex: number, syllableIndex: number) => void;
  onSelectNote: (id: string | null) => void;
  onNoteChange: (id: string, patch: Partial<Annotation>) => void;
  onDragStart: () => void;
}

const HANDLES: { id: Handle; fx: number; fy: number; cursor: string }[] = [
  { id: 'nw', fx: 0, fy: 0, cursor: 'nwse-resize' },
  { id: 'n', fx: 0.5, fy: 0, cursor: 'ns-resize' },
  { id: 'ne', fx: 1, fy: 0, cursor: 'nesw-resize' },
  { id: 'e', fx: 1, fy: 0.5, cursor: 'ew-resize' },
  { id: 'se', fx: 1, fy: 1, cursor: 'nwse-resize' },
  { id: 's', fx: 0.5, fy: 1, cursor: 'ns-resize' },
  { id: 'sw', fx: 0, fy: 1, cursor: 'nesw-resize' },
  { id: 'w', fx: 0, fy: 0.5, cursor: 'ew-resize' },
];

/**
 * WYSIWYG preview with a transform box.
 *
 * Drawing happens in project coordinates through a scale transform, so what is
 * on screen matches the export apart from resolution. The dashed box around the
 * lyrics behaves like a design-tool bounding box: drag inside to move, drag a
 * side to reflow the text into that width, drag a corner to resize the type.
 * The background is deliberately fixed — it is footage, not a movable element.
 */
export function KaraokeCanvas({
  project,
  time,
  media,
  mediaVersion = 0,
  selectedLineIndex,
  selectedTrack,
  selectedNoteId,
  gridDivisions,
  showGrid,
  onPanelTransform,
  onSelectLine,
  onSelectSyllable,
  onSelectNote,
  onNoteChange,
  onDragStart,
}: KaraokeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 960, height: 0 });
  // Project-space positions of the guides the dragged box is locked onto.
  const [guides, setGuides] = useState<Guides>({ vertical: null, horizontal: null });
  const dragRef = useRef<DragState | null>(null);

  const { canvas: spec } = project;
  // The transform box follows whichever row is selected, so clicking the romaji
  // lets you move and resize it just like the main lyrics.
  const panel = trackPanel(project, selectedTrack);
  const style = trackStyle(project, selectedTrack);
  const aspect = spec.height / spec.width;
  // Whichever dimension runs out first decides the size, so the whole frame is
  // always visible without the editing column needing to scroll.
  const HINT_ROOM = 26;
  const availableHeight = Math.max(0, viewport.height - HINT_ROOM);
  const displayWidth =
    availableHeight > 0
      ? Math.max(120, Math.min(viewport.width, availableHeight / aspect))
      : viewport.width;
  const scale = displayWidth / spec.width;

  // Track both dimensions: the preview must fit the space it is given rather
  // than growing past it, because the editing column does not scroll.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      if (r.width > 0) setViewport({ width: r.width, height: r.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);



  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pxWidth = Math.round(displayWidth * dpr);
    const pxHeight = Math.round(displayWidth * aspect * dpr);
    if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
      canvas.width = pxWidth;
      canvas.height = pxHeight;
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const s = (displayWidth * dpr) / spec.width;
    ctx.scale(s, s);
    drawFrame(ctx, project, time, media, 1);
    ctx.restore();
  }, [project, time, media, mediaVersion, displayWidth, aspect, spec.width]);

  const toProjectCoords = useCallback(
    (e: React.PointerEvent) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
    },
    [scale]
  );

  const measuringCtx = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx;
  }, []);

  /**
   * Which lyric line and syllable, if any, sits under a project-space point.
   * Walks the same wrapped rows the renderer draws, so clicking a word on a
   * reflowed second row selects that word and not its neighbour.
   */
  const hitLyrics = useCallback(
    (px: number, py: number): { track: number; line: number; syllable: number } | null => {
      const ctx = measuringCtx();
      if (!ctx) return null;
      try {
        const all = trackLines(project);
        for (let track = 0; track < all.length; track++) {
          const lines = all[track];
          const tPanel = trackPanel(project, track);
          const tStyle = trackStyle(project, track);

          for (const block of groupIntoBlocks(lines)) {
            let y = tPanel.y;
            for (const lineIndex of block.lines) {
              const line = lines[lineIndex];
              const layout = layoutLine(ctx, line, tStyle, tPanel.x, tPanel.width, y);
              y += layout.height;
              if (!isLineVisible(line, time, project.duration)) continue;

              const size = line.fontSize ?? tStyle.fontSize;
              for (const row of layout.rows) {
                if (py < row.originY || py > row.originY + size * 1.3) continue;
                if (px < row.originX || px > row.originX + row.width) continue;
                const local = px - row.originX;
                const box = row.syllables.find((b) => local >= b.x && local < b.x + b.width);
                return {
                  track,
                  line: lineIndex,
                  syllable: box ? box.index : row.firstSyllable,
                };
              }
            }
          }
        }
        return null;
      } finally {
        ctx.restore();
      }
    },
    [project, time, measuringCtx]
  );

  const hitNote = useCallback(
    (px: number, py: number): Annotation | null => {
      const ctx = measuringCtx();
      if (!ctx) return null;
      try {
        // Topmost first, matching paint order.
        const notes = [...(project.annotations ?? [])].reverse();
        for (const note of notes) {
          const from = note.appearAt ?? 0;
          const to = note.disappearAt ?? project.duration;
          if (time < from || time > to) continue;
          const b = annotationBounds(ctx, note, style.fontFamily);
          if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height) {
            return note;
          }
        }
        return null;
      } finally {
        ctx.restore();
      }
    },
    [project, time, style.fontFamily, measuringCtx]
  );

  const beginDrag = (e: React.PointerEvent, target: DragTarget, track = selectedTrack) => {
    const { x, y } = toProjectCoords(e);
    const p = trackPanel(project, track);
    const st = trackStyle(project, track);
    onDragStart();
    dragRef.current = {
      target,
      track,
      grabX: x,
      grabY: y,
      origin: {
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        scaleX: st.scaleX ?? 100,
        scaleY: st.scaleY ?? 100,
        fontSize: st.fontSize,
        lineHeight: st.lineHeight,
      },
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handleCanvasPointerDown = (e: React.PointerEvent) => {
    const { x, y } = toProjectCoords(e);

    const note = hitNote(x, y);
    if (note) {
      onSelectNote(note.id);
      beginDrag(e, { kind: 'note-move', id: note.id });
      return;
    }

    const hit = hitLyrics(x, y);
    if (hit) {
      onSelectNote(null);
      onSelectLine(hit.track, hit.line);
      onSelectSyllable(hit.track, hit.line, hit.syllable);
      beginDrag(e, { kind: 'panel-move' }, hit.track);
      return;
    }

    // The background is fixed: it is the footage, not an element to arrange.
    // Anywhere else on the stage drags the text box.
    onSelectNote(null);
    beginDrag(e, { kind: 'panel-move' });
  };

  /**
   * Pull a box onto the canvas centre lines when it gets close.
   *
   * The tolerance is defined in screen pixels and converted back to project
   * units, so the magnet feels the same regardless of the output resolution or
   * how far the preview is zoomed out. Hold Alt to place freely.
   */
  /**
   * Pull a box onto the canvas centre lines, and onto the other lyric row's
   * edges and centre.
   *
   * Aligning the romaji block with the Korean one above it is the common case,
   * so the other row is a snap target in its own right, and a guide is drawn on
   * whatever caught. Tolerance is in screen pixels converted back to project
   * units, so it feels the same at any resolution or zoom. Hold Alt to place
   * freely.
   */
  const snapToCentre = (
    px: number,
    py: number,
    boxWidth: number,
    boxHeight: number,
    disabled: boolean,
    track: number
  ) => {
    const next: Guides = { vertical: null, horizontal: null };
    if (disabled) {
      setGuides(next);
      return { x: px, y: py };
    }

    const tolerance = 8 / scale;
    let x = px;
    let y = py;

    // Candidate x positions: value the box's left edge would take, and the
    // guide line to draw if it catches.
    const xTargets: { at: number; guide: number }[] = [
      { at: spec.width / 2 - boxWidth / 2, guide: spec.width / 2 },
    ];
    const yTargets: { at: number; guide: number }[] = [
      { at: spec.height / 2 - boxHeight / 2, guide: spec.height / 2 },
    ];

    // With the grid up, its lines are snap targets too — both for the box's
    // leading edge and for its centre, which is what "align to the grid" means
    // in practice.
    if (showGrid && gridDivisions > 1) {
      for (let i = 1; i < gridDivisions; i++) {
        const gx = (spec.width / gridDivisions) * i;
        const gy = (spec.height / gridDivisions) * i;
        xTargets.push({ at: gx, guide: gx });
        xTargets.push({ at: gx - boxWidth / 2, guide: gx });
        xTargets.push({ at: gx - boxWidth, guide: gx });
        yTargets.push({ at: gy, guide: gy });
        yTargets.push({ at: gy - boxHeight / 2, guide: gy });
        yTargets.push({ at: gy - boxHeight, guide: gy });
      }
    }

    const other = trackPanel(project, track === 0 ? 1 : 0);
    const otherInUse =
      (trackLines(project)[track === 0 ? 1 : 0]?.length ?? 0) > 0 && other !== undefined;
    if (otherInUse) {
      xTargets.push({ at: other.x, guide: other.x });
      xTargets.push({ at: other.x + other.width - boxWidth, guide: other.x + other.width });
      xTargets.push({
        at: other.x + other.width / 2 - boxWidth / 2,
        guide: other.x + other.width / 2,
      });
      yTargets.push({ at: other.y, guide: other.y });
      yTargets.push({ at: other.y + other.height - boxHeight, guide: other.y + other.height });
    }

    let bestX = tolerance;
    for (const target of xTargets) {
      const d = Math.abs(px - target.at);
      if (d <= bestX) {
        bestX = d;
        x = target.at;
        next.vertical = target.guide;
      }
    }
    let bestY = tolerance;
    for (const target of yTargets) {
      const d = Math.abs(py - target.at);
      if (d <= bestY) {
        bestY = d;
        y = target.at;
        next.horizontal = target.guide;
      }
    }

    setGuides(next);
    return { x, y };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = toProjectCoords(e);
    const dx = x - drag.grabX;
    const dy = y - drag.grabY;
    const o = drag.origin;

    switch (drag.target.kind) {
      case 'panel-move': {
        const locked = trackPanel(project, drag.track);
        if (locked.lockX && locked.lockY) return;
        const snapped = snapToCentre(
          o.x + dx,
          o.y + dy,
          o.width,
          o.height,
          e.altKey,
          drag.track
        );
        onPanelTransform(
          {
            ...(locked.lockX ? {} : { x: Math.round(snapped.x) }),
            ...(locked.lockY ? {} : { y: Math.round(snapped.y) }),
          },
          drag.track
        );
        return;
      }
      case 'note-move': {
        // A note is positioned by its anchor point, so it snaps on that point.
        const snapped = snapToCentre(x, y, 0, 0, e.altKey, drag.track);
        onNoteChange(drag.target.id, { x: Math.round(snapped.x), y: Math.round(snapped.y) });
        return;
      }
      case 'note-resize': {
        // Bind the id first: the callback below defeats the switch narrowing.
        const noteId = drag.target.id;
        const note = (project.annotations ?? []).find((n) => n.id === noteId);
        if (!note) return;
        onNoteChange(noteId, { fontSize: Math.max(8, Math.round(note.fontSize + dy)) });
        return;
      }
      case 'panel-resize':
        applyResize(drag.target.handle, dx, dy, o, drag.track);
        return;
    }
  };

  /**
   * Resize the text box without distorting the type.
   *
   * Side handles change the box's width or height only, so narrowing it reflows
   * words onto the next row and the letters keep their shape. Corner handles
   * scale the type itself, moving font size and line spacing together.
   */
  const applyResize = (
    handle: Handle,
    dx: number,
    dy: number,
    o: DragState['origin'],
    track: number
  ) => {
    const patch: PanelTransform = {};

    const west = handle === 'nw' || handle === 'w' || handle === 'sw';
    const east = handle === 'ne' || handle === 'e' || handle === 'se';
    const north = handle === 'nw' || handle === 'n' || handle === 'ne';
    const south = handle === 'sw' || handle === 's' || handle === 'se';
    const isCorner = (west || east) && (north || south);

    if (isCorner) {
      const widthNow = Math.max(40, o.width + (east ? dx : -dx));
      const factor = widthNow / Math.max(1, o.width);
      patch.fontSize = Math.max(6, Math.round(o.fontSize * factor));
      patch.lineHeight = Math.max(6, Math.round(o.lineHeight * factor));
      patch.width = Math.round(widthNow);
      if (west) patch.x = Math.round(o.x + dx);
      if (north) patch.y = Math.round(o.y + dy);
      onPanelTransform(patch, track);
      return;
    }

    if (west || east) {
      const widthNow = Math.max(40, o.width + (east ? dx : -dx));
      patch.width = Math.round(widthNow);
      if (west) patch.x = Math.round(o.x + dx);
    }

    if (north || south) {
      const heightNow = Math.max(40, o.height + (south ? dy : -dy));
      patch.height = Math.round(heightNow);
      if (north) patch.y = Math.round(o.y + dy);
    }

    onPanelTransform(patch, track);
  };

  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null;
    setGuides({ vertical: null, horizontal: null });
    const target = e.currentTarget as Element;
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
  };

  const box = {
    left: panel.x * scale,
    top: panel.y * scale,
    width: panel.width * scale,
    height: panel.height * scale,
  };
  // Highlight the selected line where it actually sits, wrapping included.
  const selectedRect = (() => {
    if (selectedLineIndex === null) return null;
    const ctx = measuringCtx();
    if (!ctx) return null;
    try {
      const lines = trackLines(project)[selectedTrack] ?? [];
      for (const block of groupIntoBlocks(lines)) {
        let y = panel.y;
        for (const lineIndex of block.lines) {
          const layout = layoutLine(ctx, lines[lineIndex], style, panel.x, panel.width, y);
          if (lineIndex === selectedLineIndex) {
            return { top: y * scale, height: layout.height * scale };
          }
          y += layout.height;
        }
      }
      return null;
    } finally {
      ctx.restore();
    }
  })();

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <div className={styles.stage} style={{ height: displayWidth * aspect }}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ width: displayWidth, height: displayWidth * aspect }}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />

        {selectedRect && (
          <div
            className={styles.selectedLine}
            style={{
              left: box.left,
              top: selectedRect.top,
              width: box.width,
              height: selectedRect.height,
            }}
          />
        )}

        <div className={styles.transformBox} style={box}>
          {HANDLES.map((h) => (
            <span
              key={h.id}
              className={styles.handle}
              style={{
                left: `calc(${h.fx * 100}% - 5px)`,
                top: `calc(${h.fy * 100}% - 5px)`,
                cursor: h.cursor,
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                beginDrag(e, { kind: 'panel-resize', handle: h.id });
              }}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          ))}
        </div>

        {showGrid && gridDivisions > 1 && (
          <div className={styles.grid}>
            {Array.from({ length: gridDivisions - 1 }, (_, i) => {
              const major = gridDivisions % 2 === 0 && i + 1 === gridDivisions / 2;
              return (
                <div
                  key={`v${i}`}
                  className={`${styles.gridLineV} ${major ? styles.gridLineMajor : ''}`}
                  style={{ left: `${((i + 1) / gridDivisions) * 100}%` }}
                />
              );
            })}
            {Array.from({ length: gridDivisions - 1 }, (_, i) => {
              const major = gridDivisions % 2 === 0 && i + 1 === gridDivisions / 2;
              return (
                <div
                  key={`h${i}`}
                  className={`${styles.gridLineH} ${major ? styles.gridLineMajor : ''}`}
                  style={{ top: `${((i + 1) / gridDivisions) * 100}%` }}
                />
              );
            })}
          </div>
        )}

        {guides.vertical !== null && (
          <div className={styles.guideV} style={{ left: guides.vertical * scale }} />
        )}
        {guides.horizontal !== null && (
          <div className={styles.guideH} style={{ top: guides.horizontal * scale }} />
        )}

        {(project.annotations ?? []).map((note) => {
          if (note.id !== selectedNoteId) return null;
          return (
            <div
              key={note.id}
              className={styles.noteMarker}
              style={{
                left: note.x * scale - 6,
                top: note.y * scale - 6,
                width: 12,
                height: 12,
              }}
            />
          );
        })}
      </div>
      <p className={styles.hint}>
        Drag inside the box to move the lyrics · side handles squish or widen · corner handles
        resize · click a word to select it
      </p>
    </div>
  );
}
