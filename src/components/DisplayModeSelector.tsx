import { SubtitleDisplayMode } from '../types/subtitle';
import styles from './DisplayModeSelector.module.css';

interface DisplayModeSelectorProps {
  mode: SubtitleDisplayMode;
  onChange: (mode: SubtitleDisplayMode) => void;
}

export function DisplayModeSelector({ mode, onChange }: DisplayModeSelectorProps) {
  const options: { value: SubtitleDisplayMode; label: string }[] = [
    { value: 'original', label: 'Original' },
    { value: 'translation', label: 'Translation' },
    { value: 'both', label: 'Both' },
  ];

  return (
    <div className={styles.container}>
      <span className={styles.label}>Subtitles:</span>
      <div className={styles.buttons}>
        {options.map((option) => (
          <button
            key={option.value}
            className={`${styles.button} ${mode === option.value ? styles.active : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
