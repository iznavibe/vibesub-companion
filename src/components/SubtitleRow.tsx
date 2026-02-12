import { useEffect, useRef, useState, memo } from 'react';
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Local state for smooth typing - only syncs on blur
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
          className={styles.originalInput}
          value={localOriginal}
          onChange={(e) => setLocalOriginal(e.target.value)}
          onFocus={() => setIsOriginalFocused(true)}
          onBlur={handleOriginalBlur}
          placeholder="Original text..."
          rows={Math.max(2, localOriginal.split('\n').length)}
        />
      </div>
      <div className={styles.textCell}>
        <textarea
          ref={textareaRef}
          className={`${styles.translationInput} ${focusTranslation ? styles.focused : ''}`}
          value={localTranslation}
          onChange={(e) => setLocalTranslation(e.target.value)}
          onFocus={() => setIsTranslationFocused(true)}
          onBlur={handleTranslationBlur}
          placeholder="Translation will appear here..."
          rows={Math.max(2, localOriginal.split('\n').length)}
        />
      </div>
    </div>
  );
});
