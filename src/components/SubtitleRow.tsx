import { useEffect, useRef, useState, memo, useCallback } from 'react';
import { Subtitle } from '../types/subtitle';
import styles from './SubtitleRow.module.css';

interface SubtitleRowProps {
  subtitle: Subtitle;
  index: number;
  isPlaying?: boolean;
  isSelected?: boolean;
  focusTranslation?: boolean;
  onOriginalChange: (id: number, newText: string) => void;
  onTranslationChange: (id: number, newText: string) => void;
  onRowClick: (id: number, index: number) => void;
  onDelete: (id: number) => void;
  onAdd: (id: number) => void;
  registerTextarea?: (id: number, el: HTMLTextAreaElement | null) => void;
}

function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export const SubtitleRow = memo(function SubtitleRow({
  subtitle,
  index,
  isPlaying,
  isSelected,
  focusTranslation,
  onOriginalChange,
  onTranslationChange,
  onRowClick,
  onDelete,
  onAdd,
  registerTextarea,
}: SubtitleRowProps) {
  const originalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [localOriginal, setLocalOriginal] = useState(subtitle.originalText);
  const [localTranslation, setLocalTranslation] = useState(subtitle.translatedText);
  const [isOriginalFocused, setIsOriginalFocused] = useState(false);
  const [isTranslationFocused, setIsTranslationFocused] = useState(false);

  const formatTime = (time: string) => {
    return time.split(',')[0];
  };

  // Sync original from parent when not focused
  useEffect(() => {
    if (!isOriginalFocused) {
      setLocalOriginal(subtitle.originalText);
    }
  }, [subtitle.originalText, isOriginalFocused]);

  // Sync translation from parent when not focused
  useEffect(() => {
    if (!isTranslationFocused) {
      setLocalTranslation(subtitle.translatedText);
    }
  }, [subtitle.translatedText, isTranslationFocused]);

  // Auto-resize both textareas whenever their content changes
  useEffect(() => { autoResize(originalRef.current); }, [localOriginal]);
  useEffect(() => { autoResize(textareaRef.current); }, [localTranslation]);

  useEffect(() => {
    registerTextarea?.(subtitle.id, textareaRef.current);
    return () => registerTextarea?.(subtitle.id, null);
  }, [subtitle.id, registerTextarea]);

  useEffect(() => {
    if (focusTranslation && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [focusTranslation]);

  const handleRowClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON') return;
    onRowClick(subtitle.id, index);
  };

  const handleOriginalChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalOriginal(e.target.value);
    autoResize(e.target);
  }, []);

  const handleTranslationChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalTranslation(e.target.value);
    autoResize(e.target);
  }, []);

  const handleOriginalBlur = () => {
    setIsOriginalFocused(false);
    if (localOriginal !== subtitle.originalText) {
      onOriginalChange(subtitle.id, localOriginal);
    }
  };

  const handleTranslationBlur = () => {
    setIsTranslationFocused(false);
    if (localTranslation !== subtitle.translatedText) {
      onTranslationChange(subtitle.id, localTranslation);
    }
  };

  const rowClasses = [
    styles.row,
    isPlaying && styles.playing,
    isSelected && styles.selected,
  ].filter(Boolean).join(' ');

  return (
    <div className={rowClasses} onClick={handleRowClick} data-row>
      <div className={styles.timeCell}>
        <div className={styles.timeInfo}>
          <span className={styles.id}>#{subtitle.id}</span>
          <span className={styles.time}>
            {formatTime(subtitle.startTime)}
          </span>
          <span className={styles.timeSeparator}>→</span>
          <span className={styles.time}>
            {formatTime(subtitle.endTime)}
          </span>
        </div>
        <div className={styles.actions}>
          <button
            className={styles.actionBtn}
            onClick={(e) => { e.stopPropagation(); onAdd(subtitle.id); }}
            title="Add subtitle after"
          >
            +
          </button>
          <button
            className={`${styles.actionBtn} ${styles.deleteBtn}`}
            onClick={(e) => { e.stopPropagation(); onDelete(subtitle.id); }}
            title="Delete subtitle"
          >
            ×
          </button>
        </div>
      </div>
      <div className={styles.textCell}>
        <textarea
          ref={originalRef}
          className={styles.originalInput}
          value={localOriginal}
          onChange={handleOriginalChange}
          onFocus={() => setIsOriginalFocused(true)}
          onBlur={handleOriginalBlur}
          placeholder="Original text..."
        />
      </div>
      <div className={styles.textCell}>
        <textarea
          ref={textareaRef}
          className={`${styles.translationInput} ${focusTranslation ? styles.focused : ''}`}
          value={localTranslation}
          onChange={handleTranslationChange}
          onFocus={() => setIsTranslationFocused(true)}
          onBlur={handleTranslationBlur}
          placeholder="Translation will appear here..."
        />
      </div>
    </div>
  );
});
