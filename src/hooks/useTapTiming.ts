import { useCallback, useEffect, useRef, useState } from 'react';
import { KaraokeLine } from '../types/karaoke';

export interface TapCursor {
  lineIndex: number;
  syllableIndex: number;
}

export interface TapTimingOptions {
  lines: KaraokeLine[];
  /** Live playback position, in seconds. */
  getTime: () => number;
  /** Commit the whole edited set when a session ends. */
  onCommit: (lines: KaraokeLine[]) => void;
  onFinished?: () => void;
}

export interface TapTimingState {
  isTapping: boolean;
  /** True while the key is down, i.e. mid-word. */
  isHolding: boolean;
  cursor: TapCursor | null;
  /** Timings captured so far this session, applied on top of `lines`. */
  preview: KaraokeLine[];
  start: (from?: TapCursor) => void;
  stop: () => void;
  undoTap: () => void;
  /** Fold the syllable at the cursor into the following one. */
  mergeAtCursor: () => void;
  /** Skip the syllable at the cursor without timing it. */
  skipCursor: () => void;
}

const MIN_DURATION = 0.04;

function cloneLines(lines: KaraokeLine[]): KaraokeLine[] {
  return lines.map((l) => ({ ...l, syllables: l.syllables.map((s) => ({ ...s })) }));
}

/**
 * Hold-to-time capture.
 *
 * Hold the key for as long as the word is sung and release when it ends. That
 * records a real start AND end per syllable, so a pause between words stays a
 * pause instead of being smeared into the previous word's sweep — which is what
 * happens when you only capture one boundary per tap.
 *
 * A quick tap therefore reads as a short word followed by a gap, which is
 * usually exactly right.
 */
export function useTapTiming({
  lines,
  getTime,
  onCommit,
  onFinished,
}: TapTimingOptions): TapTimingState {
  const [isTapping, setIsTapping] = useState(false);
  const [isHolding, setIsHolding] = useState(false);
  const [cursor, setCursor] = useState<TapCursor | null>(null);
  const [preview, setPreview] = useState<KaraokeLine[]>(lines);

  // Refs so the key handlers never close over stale state.
  const workingRef = useRef<KaraokeLine[]>(lines);
  const cursorRef = useRef<TapCursor | null>(null);
  const holdingRef = useRef(false);
  const historyRef = useRef<{ cursor: TapCursor; lines: KaraokeLine[] }[]>([]);

  useEffect(() => {
    if (!isTapping) {
      workingRef.current = lines;
      setPreview(lines);
    }
  }, [lines, isTapping]);

  const advance = useCallback((c: TapCursor, source: KaraokeLine[]): TapCursor | null => {
    let lineIndex = c.lineIndex;
    let syllableIndex = c.syllableIndex + 1;
    while (lineIndex < source.length) {
      if (syllableIndex < source[lineIndex].syllables.length) {
        return { lineIndex, syllableIndex };
      }
      lineIndex += 1;
      syllableIndex = 0;
      while (lineIndex < source.length && source[lineIndex].syllables.length === 0) {
        lineIndex += 1;
      }
      if (lineIndex < source.length) return { lineIndex, syllableIndex: 0 };
    }
    return null;
  }, []);

  const snapshot = useCallback(() => {
    const c = cursorRef.current;
    if (!c) return;
    historyRef.current.push({ cursor: c, lines: cloneLines(workingRef.current) });
    if (historyRef.current.length > 500) historyRef.current.shift();
  }, []);

  const start = useCallback(
    (from?: TapCursor) => {
      const source = cloneLines(lines);
      workingRef.current = source;
      historyRef.current = [];

      let init: TapCursor | null = from ?? { lineIndex: 0, syllableIndex: 0 };
      if (
        init &&
        (init.lineIndex >= source.length || source[init.lineIndex].syllables.length === 0)
      ) {
        init = advance({ lineIndex: init.lineIndex, syllableIndex: -1 }, source);
      }

      cursorRef.current = init;
      holdingRef.current = false;
      setCursor(init);
      setIsHolding(false);
      setPreview(source);
      setIsTapping(true);
    },
    [lines, advance]
  );

  const stop = useCallback(() => {
    setIsTapping(false);
    setIsHolding(false);
    holdingRef.current = false;
    cursorRef.current = null;
    setCursor(null);
    onCommit(workingRef.current);
    onFinished?.();
  }, [onCommit, onFinished]);

  /** Key went down: open the current syllable at the playhead. */
  const beginHold = useCallback(() => {
    const c = cursorRef.current;
    if (!c || holdingRef.current) return;
    snapshot();

    const t = getTime();
    const next = cloneLines(workingRef.current);
    const syl = next[c.lineIndex].syllables[c.syllableIndex];
    syl.start = t;
    syl.end = t + MIN_DURATION;

    workingRef.current = next;
    holdingRef.current = true;
    setPreview(next);
    setIsHolding(true);
  }, [getTime, snapshot]);

  /** Key came up: close the syllable and step to the next one. */
  const endHold = useCallback(() => {
    const c = cursorRef.current;
    if (!c || !holdingRef.current) return;

    const t = getTime();
    const next = cloneLines(workingRef.current);
    const syl = next[c.lineIndex].syllables[c.syllableIndex];
    syl.end = Math.max(t, syl.start + MIN_DURATION);

    workingRef.current = next;
    holdingRef.current = false;
    setPreview(next);
    setIsHolding(false);

    const advanced = advance(c, next);
    cursorRef.current = advanced;
    setCursor(advanced);

    if (!advanced) {
      setIsTapping(false);
      onCommit(next);
      onFinished?.();
    }
  }, [getTime, advance, onCommit, onFinished]);

  const undoTap = useCallback(() => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    workingRef.current = prev.lines;
    holdingRef.current = false;
    setPreview(prev.lines);
    cursorRef.current = prev.cursor;
    setCursor(prev.cursor);
    setIsHolding(false);
    setIsTapping(true);
  }, []);

  /** Glue the syllable at the cursor to the next one so they time together. */
  const mergeAtCursor = useCallback(() => {
    const c = cursorRef.current;
    if (!c) return;
    const line = workingRef.current[c.lineIndex];
    if (!line || c.syllableIndex >= line.syllables.length - 1) return;
    snapshot();

    const next = cloneLines(workingRef.current);
    const syllables = next[c.lineIndex].syllables;
    const a = syllables[c.syllableIndex];
    const b = syllables[c.syllableIndex + 1];
    syllables.splice(c.syllableIndex, 2, {
      ...a,
      text: a.text + b.text,
      end: Math.max(a.end, b.end),
    });

    workingRef.current = next;
    setPreview(next);
  }, [snapshot]);

  /** Leave the current syllable untimed and move on. */
  const skipCursor = useCallback(() => {
    const c = cursorRef.current;
    if (!c) return;
    snapshot();
    const advanced = advance(c, workingRef.current);
    cursorRef.current = advanced;
    setCursor(advanced);
    if (!advanced) {
      setIsTapping(false);
      onCommit(workingRef.current);
      onFinished?.();
    }
  }, [advance, snapshot, onCommit, onFinished]);

  useEffect(() => {
    if (!isTapping) return;

    const isTypingTarget = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA';
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        // Ignore auto-repeat: holding the key is one continuous word.
        if (e.repeat) return;
        beginHold();
      } else if (e.code === 'Backspace') {
        e.preventDefault();
        undoTap();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        stop();
      } else if (e.code === 'Delete') {
        e.preventDefault();
        mergeAtCursor();
      } else if (e.code === 'Tab') {
        e.preventDefault();
        skipCursor();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        endHold();
      }
    };

    // Releasing outside the window would otherwise leave a word open forever.
    const onBlur = () => {
      if (holdingRef.current) endHold();
    };

    // Capture phase so the studio's own spacebar transport never sees these.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [isTapping, beginHold, endHold, undoTap, stop, mergeAtCursor, skipCursor]);

  return {
    isTapping,
    isHolding,
    cursor,
    preview,
    start,
    stop,
    undoTap,
    mergeAtCursor,
    skipCursor,
  };
}
