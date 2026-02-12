import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { Subtitle } from '../types/subtitle';
import { SubtitleRow } from './SubtitleRow';
import styles from './SubtitleList.module.css';

interface SubtitleListProps {
  subtitles: Subtitle[];
  currentTime: number;
  onOriginalChange: (id: number, newText: string) => void;
  onTranslationChange: (id: number, newText: string) => void;
  onSubtitleClick?: (subtitle: Subtitle) => void;
  onSubtitleDelete?: (id: number) => void;
  onSubtitleAdd?: (afterId: number | null) => void;
}

export function SubtitleList({
  subtitles,
  currentTime,
  onOriginalChange,
  onTranslationChange,
  onSubtitleClick,
  onSubtitleDelete,
  onSubtitleAdd,
}: SubtitleListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [focusedField, setFocusedField] = useState<'row' | 'translation'>('row');
  const textareaRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());

  // Find currently playing subtitle
  const currentSubtitleIndex = subtitles.findIndex(
    (s) => currentTime >= s.startSeconds && currentTime < s.endSeconds
  );

  const registerTextarea = useCallback((id: number, el: HTMLTextAreaElement | null) => {
    if (el) {
      textareaRefs.current.set(id, el);
    } else {
      textareaRefs.current.delete(id);
    }
  }, []);

  // Scroll selected row into view (instant for keyboard nav)
  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const rows = listRef.current.querySelectorAll('[data-row]');
      const row = rows[selectedIndex] as HTMLElement;
      if (row) {
        row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      }
    }
  }, [selectedIndex]);

  // Auto-scroll to follow currently playing subtitle (debounced)
  const lastAutoScrollIndex = useRef(-1);
  useEffect(() => {
    // Don't auto-scroll if user is editing a translation
    const isEditingTextarea = document.activeElement?.tagName === 'TEXTAREA';
    if (focusedField === 'translation' || isEditingTextarea) return;
    if (currentSubtitleIndex < 0 || !listRef.current) return;
    // Skip if same index (avoid repeated scrolls)
    if (currentSubtitleIndex === lastAutoScrollIndex.current) return;
    lastAutoScrollIndex.current = currentSubtitleIndex;

    const rows = listRef.current.querySelectorAll('[data-row]');
    const row = rows[currentSubtitleIndex] as HTMLElement;
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }, [currentSubtitleIndex, focusedField]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (subtitles.length === 0) return;

    // Check if we're actually in a textarea (handles direct click into textarea)
    const isInTextarea = (e.target as HTMLElement).tagName === 'TEXTAREA';

    // If we're editing in textarea
    if (focusedField === 'translation' || isInTextarea) {
      // Shift+Enter adds new line (let it happen naturally)
      if (e.key === 'Enter' && e.shiftKey) {
        return; // Don't prevent default, let textarea handle it
      }
      // Escape or Enter (without shift) exits the textarea
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        setFocusedField('row');
        // Blur the textarea
        const textarea = textareaRefs.current.get(subtitles[selectedIndex]?.id);
        textarea?.blur();
        containerRef.current?.focus();
      }
      return;
    }

    // Row navigation
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, subtitles.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (selectedIndex >= 0) {
          setFocusedField('translation');
          const textarea = textareaRefs.current.get(subtitles[selectedIndex]?.id);
          textarea?.focus();
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0) {
          // Jump to this subtitle's time
          onSubtitleClick?.(subtitles[selectedIndex]);
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (selectedIndex >= 0) {
            const id = subtitles[selectedIndex].id;
            onSubtitleDelete?.(id);
            setSelectedIndex((prev) => Math.min(prev, subtitles.length - 2));
          }
        }
        break;
      case 'n':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const afterId = selectedIndex >= 0 ? subtitles[selectedIndex].id : null;
          onSubtitleAdd?.(afterId);
        }
        break;
    }
  }, [subtitles, selectedIndex, focusedField, onSubtitleClick, onSubtitleDelete, onSubtitleAdd]);

  // Stable callback that receives id/index from child
  const handleRowClick = useCallback((id: number, index: number) => {
    setSelectedIndex(index);
    setFocusedField('row');
    const subtitle = subtitles.find(s => s.id === id);
    if (subtitle) onSubtitleClick?.(subtitle);
    containerRef.current?.focus();
  }, [subtitles, onSubtitleClick]);

  const handleDelete = useCallback((id: number) => {
    onSubtitleDelete?.(id);
  }, [onSubtitleDelete]);

  const handleAdd = useCallback((id: number) => {
    onSubtitleAdd?.(id);
  }, [onSubtitleAdd]);

  // Memoize row data to prevent unnecessary re-renders
  const rowsData = useMemo(() => subtitles.map((subtitle, index) => ({
    subtitle,
    index,
    isPlaying: index === currentSubtitleIndex,
  })), [subtitles, currentSubtitleIndex]);

  return (
    <div
      ref={containerRef}
      className={styles.container}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.header}>
        <div className={styles.headerCell}>Time</div>
        <div className={styles.headerCell}>Korean (Original)</div>
        <div className={styles.headerCell}>English (Translation)</div>
      </div>
      <div className={styles.hint}>
        ↑↓ navigate • Enter jump • → edit • Esc exit • Ctrl+N add • Ctrl+Del delete
      </div>
      <div ref={listRef} className={styles.list}>
        {rowsData.map(({ subtitle, index, isPlaying }) => (
          <SubtitleRow
            key={subtitle.id}
            subtitle={subtitle}
            index={index}
            isPlaying={isPlaying}
            isSelected={index === selectedIndex}
            focusTranslation={index === selectedIndex && focusedField === 'translation'}
            onOriginalChange={onOriginalChange}
            onTranslationChange={onTranslationChange}
            onRowClick={handleRowClick}
            onDelete={handleDelete}
            onAdd={handleAdd}
            registerTextarea={registerTextarea}
          />
        ))}
      </div>
    </div>
  );
}
