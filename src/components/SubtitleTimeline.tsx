import { useRef, useState, useEffect, useCallback, memo } from 'react';
import { Subtitle, SubtitleDisplayMode } from '../types/subtitle';
import { WaveformData } from '../hooks/useWaveformData';
import styles from './SubtitleTimeline.module.css';

interface SubtitleTimelineProps {
  subtitles: Subtitle[];
  duration: number;
  currentTime: number;
  onSeek: (time: number) => void;
  onSubtitleUpdate: (id: number, startSeconds: number, endSeconds: number) => void;
  onSubtitleDelete: (id: number) => void;
  onSubtitleAdd: (afterId: number | null, startSeconds: number, endSeconds: number) => void;
  selectedSubtitleId: number | null;
  onSubtitleSelect: (id: number | null) => void;
  onSubtitleSplit: (id: number, splitTime: number) => void;
  waveformData: WaveformData | null;
  isWaveformLoading?: boolean;
  timelineDisplayMode: SubtitleDisplayMode;
  onTimelineDisplayModeChange: (mode: SubtitleDisplayMode) => void;
}

type DragType = 'move' | 'start' | 'end';

interface DragState {
  subtitleId: number;
  type: DragType;
  startX: number;
  startScrollLeft: number;
  originalStart: number;
  originalEnd: number;
  didDrag: boolean;
}

interface PlayheadDragState {
  startX: number;
  originalTime: number;
}

interface TimelineDragState {
  startX: number;
  startScrollLeft: number;
  didDrag: boolean;
  startY: number;
}

const SNAP_THRESHOLD_PX = 5;
// Larger snap zone for the immediately-adjacent subtitle edge — makes it easy
// to drag end handles flush against the next/previous subtitle with zero gap.
const ADJACENT_SNAP_THRESHOLD_PX = 20;
const DRAG_THRESHOLD_PX = 3;

export const SubtitleTimeline = memo(function SubtitleTimeline({
  subtitles,
  duration,
  currentTime,
  onSeek,
  onSubtitleUpdate,
  onSubtitleDelete,
  onSubtitleAdd,
  selectedSubtitleId,
  onSubtitleSelect,
  onSubtitleSplit,
  waveformData,
  isWaveformLoading = false,
  timelineDisplayMode,
  onTimelineDisplayModeChange,
}: SubtitleTimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const waveformWrapperRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const snapLineRef = useRef<HTMLDivElement>(null);
  const edgeScrollRef = useRef<number | null>(null);

  const dragStateRef = useRef<DragState | null>(null);
  const playheadDragRef = useRef<PlayheadDragState | null>(null);
  const timelineDragRef = useRef<TimelineDragState | null>(null);

  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [isPlayheadDragging, setIsPlayheadDragging] = useState(false);
  const [isGrabbing, setIsGrabbing] = useState(false);

  const [zoom, setZoom] = useState(3);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  const pixelsPerSecond = 30 * zoom;
  const timelineWidth = Math.max(duration * pixelsPerSecond, 800);

  const secondsToPixels = (seconds: number) => seconds * pixelsPerSecond;
  const pixelsToSeconds = (pixels: number) => pixels / pixelsPerSecond;

  // Refs that keep latest prop/state values accessible inside stable handlers
  const subtitlesRef = useRef(subtitles);
  subtitlesRef.current = subtitles;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onSubtitleUpdateRef = useRef(onSubtitleUpdate);
  onSubtitleUpdateRef.current = onSubtitleUpdate;
  const onSubtitleDeleteRef = useRef(onSubtitleDelete);
  onSubtitleDeleteRef.current = onSubtitleDelete;
  const onSubtitleSelectRef = useRef(onSubtitleSelect);
  onSubtitleSelectRef.current = onSubtitleSelect;
  const onSubtitleSplitRef = useRef(onSubtitleSplit);
  onSubtitleSplitRef.current = onSubtitleSplit;
  const onSubtitleAddRef = useRef(onSubtitleAdd);
  onSubtitleAddRef.current = onSubtitleAdd;
  const selectedSubtitleIdRef = useRef(selectedSubtitleId);
  selectedSubtitleIdRef.current = selectedSubtitleId;
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  pixelsPerSecondRef.current = pixelsPerSecond;

  // --- Snap logic helper ---
  const findSnapTarget = useCallback((
    timeValue: number,
    dragSubtitleId: number,
    pps: number
  ): number | null => {
    const subs = subtitlesRef.current;
    const ct = currentTimeRef.current;
    let closestSnap: number | null = null;
    let closestDist = Infinity;
    const thresholdSeconds = SNAP_THRESHOLD_PX / pps;

    // Check playhead
    const phDist = Math.abs(timeValue - ct);
    if (phDist < thresholdSeconds && phDist < closestDist) {
      closestDist = phDist;
      closestSnap = ct;
    }

    // Check other subtitle edges
    for (const sub of subs) {
      if (sub.id === dragSubtitleId) continue;
      const startDist = Math.abs(timeValue - sub.startSeconds);
      if (startDist < thresholdSeconds && startDist < closestDist) {
        closestDist = startDist;
        closestSnap = sub.startSeconds;
      }
      const endDist = Math.abs(timeValue - sub.endSeconds);
      if (endDist < thresholdSeconds && endDist < closestDist) {
        closestDist = endDist;
        closestSnap = sub.endSeconds;
      }
    }

    return closestSnap;
  }, []);

  const showSnapLine = useCallback((timeValue: number) => {
    const line = snapLineRef.current;
    if (!line) return;
    const pps = pixelsPerSecondRef.current;
    line.style.left = `${timeValue * pps}px`;
    line.style.display = 'block';
  }, []);

  const hideSnapLine = useCallback(() => {
    const line = snapLineRef.current;
    if (line) line.style.display = 'none';
  }, []);

  // --- Auto-scroll to follow playhead ---
  const lastScrollTime = useRef(0);
  useEffect(() => {
    if (!isAutoScroll || dragStateRef.current || timelineDragRef.current || playheadDragRef.current) return;

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const now = Date.now();
    if (now - lastScrollTime.current < 500) return;

    const playheadX = secondsToPixels(currentTime);
    const wrapperWidth = wrapper.clientWidth;
    const scrollLeft = wrapper.scrollLeft;
    const targetScroll = playheadX - wrapperWidth / 3;

    if (Math.abs(targetScroll - scrollLeft) > wrapperWidth / 4) {
      lastScrollTime.current = now;
      wrapper.scrollTo({ left: Math.max(0, targetScroll), behavior: 'auto' });
    }
  }, [currentTime, isAutoScroll, zoom, duration]);

  // --- Global mousemove/mouseup (attached once) ---
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const pps = pixelsPerSecondRef.current;
      const toSeconds = (px: number) => px / pps;

      // Timeline pan drag
      const tlDrag = timelineDragRef.current;
      if (tlDrag && wrapperRef.current) {
        const dx = e.clientX - tlDrag.startX;
        const dy = e.clientY - tlDrag.startY;
        if (!tlDrag.didDrag && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
          tlDrag.didDrag = true;
        }
        if (tlDrag.didDrag) {
          wrapperRef.current.scrollLeft = tlDrag.startScrollLeft - dx;
        }
        return;
      }

      // Playhead drag
      const phDrag = playheadDragRef.current;
      if (phDrag) {
        const deltaX = e.clientX - phDrag.startX;
        const deltaSeconds = toSeconds(deltaX);
        const dur = durationRef.current;
        const newTime = Math.max(0, Math.min(dur, phDrag.originalTime + deltaSeconds));
        onSeekRef.current(newTime);
        return;
      }

      // Subtitle drag
      const drag = dragStateRef.current;
      if (!drag) return;

      // Check drag threshold
      const wrapper = wrapperRef.current;
      const scrollDelta = wrapper ? wrapper.scrollLeft - drag.startScrollLeft : 0;
      const totalDeltaX = (e.clientX - drag.startX) + scrollDelta;
      if (!drag.didDrag && Math.abs(totalDeltaX) > DRAG_THRESHOLD_PX) {
        drag.didDrag = true;
      }
      if (!drag.didDrag) return;

      if (wrapper) {
        const rect = wrapper.getBoundingClientRect();
        const mouseX = e.clientX;

        // Edge scrolling
        if (mouseX < rect.left + 80) {
          if (!edgeScrollRef.current) {
            edgeScrollRef.current = window.setInterval(() => {
              if (wrapperRef.current) wrapperRef.current.scrollLeft -= 15;
            }, 16);
          }
        } else if (mouseX > rect.right - 80) {
          if (!edgeScrollRef.current) {
            edgeScrollRef.current = window.setInterval(() => {
              if (wrapperRef.current) wrapperRef.current.scrollLeft += 15;
            }, 16);
          }
        } else if (edgeScrollRef.current) {
          clearInterval(edgeScrollRef.current);
          edgeScrollRef.current = null;
        }
      }

      const deltaSeconds = toSeconds(totalDeltaX);

      const subs = subtitlesRef.current;
      const dur = durationRef.current;
      const currentIndex = subs.findIndex(s => s.id === drag.subtitleId);
      const prevSub = currentIndex > 0 ? subs[currentIndex - 1] : null;
      const nextSub = currentIndex < subs.length - 1 ? subs[currentIndex + 1] : null;

      let newStart = drag.originalStart;
      let newEnd = drag.originalEnd;
      const subDuration = drag.originalEnd - drag.originalStart;

      switch (drag.type) {
        case 'move':
          newStart = drag.originalStart + deltaSeconds;
          newEnd = drag.originalEnd + deltaSeconds;
          if (newStart < 0) { newStart = 0; newEnd = subDuration; }
          if (newEnd > dur) { newEnd = dur; newStart = dur - subDuration; }
          if (prevSub && newStart < prevSub.endSeconds) { newStart = prevSub.endSeconds; newEnd = newStart + subDuration; }
          if (nextSub && newEnd > nextSub.startSeconds) { newEnd = nextSub.startSeconds; newStart = newEnd - subDuration; }

          // Snap start edge
          {
            const snapStart = findSnapTarget(newStart, drag.subtitleId, pps);
            const snapEnd = findSnapTarget(newEnd, drag.subtitleId, pps);
            if (snapStart !== null) {
              const snapped = snapStart;
              if (snapped >= 0 && snapped + subDuration <= dur) {
                if (!prevSub || snapped >= prevSub.endSeconds) {
                  if (!nextSub || snapped + subDuration <= nextSub.startSeconds) {
                    newStart = snapped;
                    newEnd = snapped + subDuration;
                    showSnapLine(snapped);
                  }
                }
              }
            } else if (snapEnd !== null) {
              const snapped = snapEnd;
              if (snapped - subDuration >= 0 && snapped <= dur) {
                if (!prevSub || snapped - subDuration >= prevSub.endSeconds) {
                  if (!nextSub || snapped <= nextSub.startSeconds) {
                    newEnd = snapped;
                    newStart = snapped - subDuration;
                    showSnapLine(snapped);
                  }
                }
              }
            } else {
              hideSnapLine();
            }
          }
          break;
        case 'start':
          newStart = drag.originalStart + deltaSeconds;
          newStart = Math.min(newStart, drag.originalEnd - 0.1);
          newStart = Math.max(0, newStart);
          if (prevSub) newStart = Math.max(newStart, prevSub.endSeconds);
          // Snap: prefer closing the gap to the previous subtitle with a generous threshold
          {
            const adjacentThresh = ADJACENT_SNAP_THRESHOLD_PX / pps;
            if (prevSub && Math.abs(newStart - prevSub.endSeconds) <= adjacentThresh) {
              newStart = prevSub.endSeconds;
              showSnapLine(newStart);
            } else {
              const snap = findSnapTarget(newStart, drag.subtitleId, pps);
              if (snap !== null && snap < drag.originalEnd - 0.1 && snap >= 0) {
                if (!prevSub || snap >= prevSub.endSeconds) {
                  newStart = snap;
                  showSnapLine(snap);
                }
              } else {
                hideSnapLine();
              }
            }
          }
          break;
        case 'end':
          newEnd = drag.originalEnd + deltaSeconds;
          newEnd = Math.max(newEnd, drag.originalStart + 0.1);
          newEnd = Math.min(dur, newEnd);
          if (nextSub) newEnd = Math.min(newEnd, nextSub.startSeconds);
          // Snap: prefer closing the gap to the next subtitle with a generous threshold
          {
            const adjacentThresh = ADJACENT_SNAP_THRESHOLD_PX / pps;
            if (nextSub && Math.abs(newEnd - nextSub.startSeconds) <= adjacentThresh) {
              newEnd = nextSub.startSeconds;
              showSnapLine(newEnd);
            } else {
              const snap = findSnapTarget(newEnd, drag.subtitleId, pps);
              if (snap !== null && snap > drag.originalStart + 0.1 && snap <= dur) {
                if (!nextSub || snap <= nextSub.startSeconds) {
                  newEnd = snap;
                  showSnapLine(snap);
                }
              } else {
                hideSnapLine();
              }
            }
          }
          break;
      }

      onSubtitleUpdateRef.current(drag.subtitleId, newStart, newEnd);
    };

    const handleMouseUp = (e: MouseEvent) => {
      const subDrag = dragStateRef.current;
      const tlDrag = timelineDragRef.current;
      const wasDragging = subDrag || playheadDragRef.current || tlDrag;

      // Click-to-select on subtitle bar (no drag)
      if (subDrag && !subDrag.didDrag) {
        onSubtitleSelectRef.current(subDrag.subtitleId);
      }

      // Click-to-seek on empty space (no drag)
      if (tlDrag && !tlDrag.didDrag) {
        // Calculate the click time from mouse position
        const timeline = timelineRef.current;
        const wrapper = wrapperRef.current;
        if (timeline && wrapper) {
          const rect = timeline.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const clickTime = x / pixelsPerSecondRef.current;
          const dur = durationRef.current;
          const clampedTime = Math.max(0, Math.min(dur, clickTime));
          onSeekRef.current(clampedTime);
          onSubtitleSelectRef.current(null);
        }
      }

      dragStateRef.current = null;
      playheadDragRef.current = null;
      timelineDragRef.current = null;

      if (wasDragging) {
        setDraggingId(null);
        setIsPlayheadDragging(false);
        setIsGrabbing(false);
        hideSnapLine();
      }
      if (edgeScrollRef.current) {
        clearInterval(edgeScrollRef.current);
        edgeScrollRef.current = null;
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Keyboard handlers (C to split, Delete/Backspace to delete) ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if focus is in an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const selId = selectedSubtitleIdRef.current;

      if ((e.key === 'Delete' || e.key === 'Backspace') && selId !== null) {
        e.preventDefault();
        onSubtitleDeleteRef.current(selId);
        onSubtitleSelectRef.current(null);
        return;
      }

      if (e.key === 'c' || e.key === 'C') {
        // Only plain 'c', not Ctrl+C
        if (e.ctrlKey || e.metaKey) return;
        if (selId === null) return;

        const ct = currentTimeRef.current;
        const sub = subtitlesRef.current.find(s => s.id === selId);
        if (sub && ct > sub.startSeconds && ct < sub.endSeconds) {
          e.preventDefault();
          onSubtitleSplitRef.current(selId, ct);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // --- Scroll wheel → horizontal panning / Ctrl+wheel → zoom ---
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+wheel → zoom in/out, anchored at mouse position
        const rect = wrapper.getBoundingClientRect();
        const mouseX = e.clientX - rect.left + wrapper.scrollLeft;
        const oldZoom = zoomRef.current;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.max(0.5, Math.min(8, oldZoom * factor));

        setZoomRef.current(newZoom);

        // Keep the point under the cursor in the same screen position
        requestAnimationFrame(() => {
          const scale = newZoom / oldZoom;
          const newMouseX = mouseX * scale;
          wrapper.scrollLeft = newMouseX - (e.clientX - rect.left);
        });
      } else {
        // Regular scroll → horizontal pan
        wrapper.scrollLeft += e.deltaY;
      }
    };

    wrapper.addEventListener('wheel', handleWheel, { passive: false });
    return () => wrapper.removeEventListener('wheel', handleWheel);
  }, []);

  // --- Waveform canvas rendering ---
  const waveformHeight = 48;
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || !waveformData) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const canvasWidth = timelineWidth;

    // Set canvas size (accounting for device pixel ratio for sharpness)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasWidth * dpr;
    canvas.height = waveformHeight * dpr;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${waveformHeight}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, canvasWidth, waveformHeight);

    const { peaks, duration: wfDuration } = waveformData;
    const peaksPerSecond = peaks.length / wfDuration;
    const centerY = waveformHeight / 2;
    const maxHalf = waveformHeight * 0.45;

    // Draw filled waveform shape with gradient
    const grad = ctx.createLinearGradient(0, 0, 0, waveformHeight);
    grad.addColorStop(0, 'rgba(99, 102, 241, 0.15)');
    grad.addColorStop(0.5, 'rgba(139, 92, 246, 0.7)');
    grad.addColorStop(1, 'rgba(99, 102, 241, 0.15)');

    // Top half path
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    for (let px = 0; px < canvasWidth; px++) {
      const timeSec = px / pixelsPerSecond;
      const peakIndex = Math.floor(timeSec * peaksPerSecond);
      if (peakIndex >= peaks.length) {
        ctx.lineTo(px, centerY);
        break;
      }
      const amp = peaks[peakIndex];
      ctx.lineTo(px, centerY - amp * maxHalf);
    }
    // Bottom half path (mirror)
    for (let px = Math.min(canvasWidth, Math.ceil(wfDuration * pixelsPerSecond)) - 1; px >= 0; px--) {
      const timeSec = px / pixelsPerSecond;
      const peakIndex = Math.floor(timeSec * peaksPerSecond);
      if (peakIndex >= peaks.length) continue;
      const amp = peaks[peakIndex];
      ctx.lineTo(px, centerY + amp * maxHalf);
    }
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw a brighter center line for clarity
    ctx.beginPath();
    for (let px = 0; px < canvasWidth; px++) {
      const timeSec = px / pixelsPerSecond;
      const peakIndex = Math.floor(timeSec * peaksPerSecond);
      if (peakIndex >= peaks.length) break;
      const amp = peaks[peakIndex];
      // Draw top edge as a thin line
      const y = centerY - amp * maxHalf;
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.6)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }, [waveformData, zoom, timelineWidth, pixelsPerSecond]);

  // --- Sync waveform scroll with timeline scroll ---
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const wfWrapper = waveformWrapperRef.current;
    if (!wrapper || !wfWrapper) return;

    const syncScroll = () => {
      wfWrapper.scrollLeft = wrapper.scrollLeft;
    };

    wrapper.addEventListener('scroll', syncScroll);
    return () => wrapper.removeEventListener('scroll', syncScroll);
  }, []);

  const handlePlayheadMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsAutoScroll(false);
    playheadDragRef.current = {
      startX: e.clientX,
      originalTime: currentTime,
    };
    setIsPlayheadDragging(true);
  };

  const handleMouseDown = (e: React.MouseEvent, subtitle: Subtitle, type: DragType) => {
    e.stopPropagation();
    e.preventDefault();
    setIsAutoScroll(false);
    dragStateRef.current = {
      subtitleId: subtitle.id,
      type,
      startX: e.clientX,
      startScrollLeft: wrapperRef.current?.scrollLeft || 0,
      originalStart: subtitle.startSeconds,
      originalEnd: subtitle.endSeconds,
      didDrag: false,
    };
    setDraggingId(subtitle.id);
  };

  const handleTimelineDragStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(`.${styles.bar}`)) return;
    if ((e.target as HTMLElement).closest(`.${styles.playhead}`)) return;
    setIsAutoScroll(false);
    timelineDragRef.current = {
      startX: e.clientX,
      startScrollLeft: wrapperRef.current?.scrollLeft || 0,
      didDrag: false,
      startY: e.clientY,
    };
    setIsGrabbing(true);
  };

  // Add a subtitle starting exactly at the playhead position.
  // If the playhead is inside an existing subtitle, start right after that one ends.
  const handleAddAtPlayhead = useCallback(() => {
    const ct = currentTimeRef.current;
    const dur = durationRef.current;
    const subs = subtitlesRef.current;

    // Check if playhead is inside an existing subtitle
    const containing = subs.find(s => ct >= s.startSeconds && ct < s.endSeconds);
    const startTime = containing ? containing.endSeconds : ct;

    // Find the next subtitle after startTime to bound the end
    const nextSub = subs.find(s => s.startSeconds >= startTime && s.id !== containing?.id);
    const endTime = Math.min(startTime + 2, nextSub ? nextSub.startSeconds : dur, dur);

    if (endTime <= startTime) return; // no room

    // afterId = the subtitle immediately before startTime
    const afterSub = [...subs].reverse().find(s => s.endSeconds <= startTime);
    onSubtitleAddRef.current(afterSub?.id ?? null, startTime, endTime);
  }, []);

  const handleAddSubtitle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = timelineRef.current?.getBoundingClientRect();
    const wrapper = wrapperRef.current;
    if (!rect || !wrapper) return;

    const x = e.clientX - rect.left + wrapper.scrollLeft;
    const clickTime = pixelsToSeconds(x);

    const afterSub = [...subtitles]
      .reverse()
      .find(s => s.endSeconds <= clickTime);

    const nextSub = subtitles.find(s => s.startSeconds > clickTime);

    const startTime = clickTime;
    const endTime = Math.min(clickTime + 2, nextSub ? nextSub.startSeconds : duration, duration);

    onSubtitleAdd(afterSub?.id || null, startTime, endTime);
  };

  const handleDisplayToggle = () => {
    onTimelineDisplayModeChange(timelineDisplayMode === 'original' ? 'translation' : 'original');
  };

  const getBarText = (subtitle: Subtitle): string => {
    if (timelineDisplayMode === 'translation') {
      return subtitle.translatedText || subtitle.originalText;
    }
    return subtitle.originalText;
  };

  const getDisplayLabel = (): string => {
    return timelineDisplayMode === 'original' ? 'Orig' : 'Trans';
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Generate time markers
  const markerInterval = zoom >= 4 ? 2 : zoom >= 2 ? 5 : zoom >= 1 ? 10 : 30;
  const markers = [];
  for (let t = 0; t <= duration; t += markerInterval) {
    markers.push(t);
  }

  return (
    <div className={styles.container}>
      <div className={styles.controls}>
        <button
          className={styles.zoomBtn}
          onClick={() => setZoom(z => Math.max(0.5, z / 1.5))}
        >
          −
        </button>
        <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
        <button
          className={styles.zoomBtn}
          onClick={() => setZoom(z => Math.min(8, z * 1.5))}
        >
          +
        </button>
        <button
          className={`${styles.autoScrollBtn} ${isAutoScroll ? styles.active : ''}`}
          onClick={() => setIsAutoScroll(!isAutoScroll)}
        >
          Follow
        </button>
        <button
          className={styles.displayToggleBtn}
          onClick={handleDisplayToggle}
          title="Toggle bar text: Original / Translation / Both"
        >
          {getDisplayLabel()}
        </button>
        <button
          className={styles.addAtPlayheadBtn}
          onClick={handleAddAtPlayhead}
          title="Add subtitle at playhead position"
        >
          + Add here
        </button>
        <span className={styles.hint}>Click bar to select • C to split • Del to remove • Scroll to pan</span>
      </div>

      <div
        ref={wrapperRef}
        className={`${styles.timelineWrapper} ${isGrabbing ? styles.grabbing : ''}`}
        onMouseDown={handleTimelineDragStart}
      >
        <div
          ref={timelineRef}
          className={styles.timeline}
          style={{ width: timelineWidth }}
          onDoubleClick={handleAddSubtitle}
        >
          {/* Time markers */}
          <div className={styles.markers}>
            {markers.map(t => (
              <div
                key={t}
                className={styles.marker}
                style={{ left: secondsToPixels(t) }}
              >
                <span className={styles.markerLabel}>{formatTime(t)}</span>
              </div>
            ))}
          </div>

          {/* Subtitle bars */}
          <div className={styles.bars}>
            {subtitles.map((subtitle) => {
              const barText = getBarText(subtitle);
              const truncated = barText.substring(0, 40) + (barText.length > 40 ? '...' : '');
              return (
                <div
                  key={subtitle.id}
                  className={`${styles.bar} ${draggingId === subtitle.id ? styles.dragging : ''} ${selectedSubtitleId === subtitle.id ? styles.selected : ''}`}
                  style={{
                    left: secondsToPixels(subtitle.startSeconds),
                    width: Math.max(secondsToPixels(subtitle.endSeconds - subtitle.startSeconds), 20),
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onSubtitleDelete(subtitle.id);
                  }}
                >
                  <div
                    className={styles.dragHandleLeft}
                    onMouseDown={(e) => handleMouseDown(e, subtitle, 'start')}
                  />
                  <div
                    className={styles.barContent}
                    onMouseDown={(e) => handleMouseDown(e, subtitle, 'move')}
                  >
                    <span className={styles.barId}>#{subtitle.id}</span>
                    <span className={styles.barText}>{truncated}</span>
                  </div>
                  <div
                    className={styles.dragHandleRight}
                    onMouseDown={(e) => handleMouseDown(e, subtitle, 'end')}
                  />
                </div>
              );
            })}
          </div>

          {/* Snap indicator line */}
          <div ref={snapLineRef} className={styles.snapLine} />

          {/* Playhead */}
          <div
            className={`${styles.playhead} ${isPlayheadDragging ? styles.playheadDragging : ''}`}
            style={{ left: secondsToPixels(currentTime) }}
            onMouseDown={handlePlayheadMouseDown}
          />
        </div>
      </div>

      {/* Waveform row — below the timeline, scroll-synced */}
      {isWaveformLoading ? (
        <div className={styles.waveformLoading}>Extracting waveform…</div>
      ) : waveformData ? (
        <div
          ref={waveformWrapperRef}
          className={styles.waveformWrapper}
        >
          <canvas
            ref={waveformCanvasRef}
            className={styles.waveformCanvas}
          />
        </div>
      ) : null}
    </div>
  );
});
