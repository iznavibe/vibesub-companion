import { useCallback, useEffect, useRef, useState } from 'react';

export interface UndoableState<T> {
  value: T;
  /** Replace the value and push the previous one onto the undo stack. */
  set: (next: T, options?: { coalesce?: boolean }) => void;
  /** Replace without recording history — for continuous drags. */
  setTransient: (next: T) => void;
  /** Record the current value as an undo point, e.g. when a drag begins. */
  commit: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Swap in a whole new document, clearing history. */
  reset: (next: T) => void;
}

const LIMIT = 100;

/**
 * Undo/redo over a single value.
 *
 * `coalesce` folds rapid successive edits (typing in a number field, nudging a
 * slider) into one history entry so a single Ctrl+Z does not undo one keystroke
 * at a time. Drags use `commit` once at the start, then `setTransient`.
 */
export function useUndoable<T>(initial: T, coalesceMs = 500): UndoableState<T> {
  const [value, setValue] = useState<T>(initial);
  const undoStack = useRef<T[]>([]);
  const redoStack = useRef<T[]>([]);
  const valueRef = useRef<T>(initial);
  const lastPush = useRef(0);
  const [, force] = useState(0);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const push = useCallback((snapshot: T) => {
    undoStack.current.push(snapshot);
    if (undoStack.current.length > LIMIT) undoStack.current.shift();
    redoStack.current = [];
  }, []);

  const set = useCallback(
    (next: T, options?: { coalesce?: boolean }) => {
      const now = Date.now();
      const skip = options?.coalesce && now - lastPush.current < coalesceMs;
      if (!skip) {
        push(valueRef.current);
        lastPush.current = now;
      }
      valueRef.current = next;
      setValue(next);
      force((n) => n + 1);
    },
    [push, coalesceMs]
  );

  const setTransient = useCallback((next: T) => {
    valueRef.current = next;
    setValue(next);
  }, []);

  const commit = useCallback(() => {
    push(valueRef.current);
    lastPush.current = Date.now();
    force((n) => n + 1);
  }, [push]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (prev === undefined) return;
    redoStack.current.push(valueRef.current);
    valueRef.current = prev;
    setValue(prev);
    // A fresh edit after undoing should start its own history entry.
    lastPush.current = 0;
    force((n) => n + 1);
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (next === undefined) return;
    undoStack.current.push(valueRef.current);
    valueRef.current = next;
    setValue(next);
    lastPush.current = 0;
    force((n) => n + 1);
  }, []);

  const reset = useCallback((next: T) => {
    undoStack.current = [];
    redoStack.current = [];
    valueRef.current = next;
    setValue(next);
    lastPush.current = 0;
    force((n) => n + 1);
  }, []);

  return {
    value,
    set,
    setTransient,
    commit,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    reset,
  };
}
