import { useState, useEffect, useCallback } from 'react';
import { Subtitle } from '../types/subtitle';
import styles from './TextSplitDialog.module.css';

interface TextSplitDialogProps {
  subtitle: Subtitle;
  splitTime: number;
  onConfirm: (firstText: string, secondText: string) => void;
  onCancel: () => void;
}

// Tokenize text into words (normalising all whitespace)
function getWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(w => w.length > 0);
}

// Find the best initial split index: nearest sentence boundary to the time proportion
function findInitialSplit(words: string[], proportion: number): number {
  const target = Math.round(proportion * words.length);

  let best = -1;
  let bestDist = Infinity;

  for (let i = 1; i < words.length; i++) {
    const prevWord = words[i - 1];
    // word ends with sentence-ending punctuation (ignore trailing quotes/brackets)
    if (/[.?!][\'"»)\]]*$/.test(prevWord)) {
      const dist = Math.abs(i - target);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
  }

  // Only use sentence break if it's within 30% of the text length from the target
  if (best !== -1 && bestDist <= words.length * 0.3) {
    return Math.max(1, Math.min(words.length - 1, best));
  }

  return Math.max(1, Math.min(words.length - 1, target));
}

export function TextSplitDialog({ subtitle, splitTime, onConfirm, onCancel }: TextSplitDialogProps) {
  const words = getWords(subtitle.originalText);

  const proportion =
    (splitTime - subtitle.startSeconds) /
    Math.max(subtitle.endSeconds - subtitle.startSeconds, 0.001);

  const [splitIndex, setSplitIndex] = useState(() =>
    findInitialSplit(words, proportion)
  );

  // Dismiss on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitIndex]);

  const handleConfirm = useCallback(() => {
    const first = words.slice(0, splitIndex).join(' ');
    const second = words.slice(splitIndex).join(' ');
    onConfirm(first, second);
  }, [words, splitIndex, onConfirm]);

  const firstText = words.slice(0, splitIndex).join(' ');
  const secondText = words.slice(splitIndex).join(' ');

  return (
    <div className={styles.overlay} onMouseDown={onCancel}>
      <div className={styles.dialog} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Split subtitle text</span>
          <span className={styles.subtitle}>Click between words to set the split point</span>
        </div>

        <div className={styles.textArea}>
          {words.map((word, i) => (
            <span key={i}>
              {i > 0 && (
                <span
                  className={`${styles.gap} ${splitIndex === i ? styles.activeGap : ''}`}
                  onClick={() => setSplitIndex(i)}
                  title="Split here"
                >
                  <span className={styles.gapBar}>|</span>
                </span>
              )}
              <span
                className={i < splitIndex ? styles.firstWord : styles.secondWord}
                onClick={() => {
                  // clicking a word sets split just before it (unless it's word 0)
                  if (i > 0) setSplitIndex(i);
                }}
              >
                {word}
              </span>
            </span>
          ))}
        </div>

        <div className={styles.previews}>
          <div className={styles.preview}>
            <span className={styles.previewLabel}>Sub 1</span>
            <span className={styles.previewText + ' ' + styles.previewFirst}>
              {firstText || <em className={styles.empty}>empty</em>}
            </span>
          </div>
          <div className={styles.preview}>
            <span className={styles.previewLabel}>Sub 2</span>
            <span className={styles.previewText + ' ' + styles.previewSecond}>
              {secondText || <em className={styles.empty}>empty</em>}
            </span>
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onCancel}>Cancel</button>
          <button
            className={styles.confirmBtn}
            onClick={handleConfirm}
            disabled={!firstText || !secondText}
          >
            Split  <kbd>Ctrl+Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
