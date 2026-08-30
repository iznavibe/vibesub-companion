import { useEffect, useState } from 'react';
import { isTauri } from '../services/tauriService';

export interface AudioWaveform {
  peaks: Float32Array;
  duration: number;
}

/**
 * Waveform peaks for a file addressed by path.
 *
 * The subtitle workspace's `useWaveformData` needs a `File` handle; the lyric
 * studio only ever has a path from the native file dialog, so this wraps the
 * same Rust extractor without that requirement.
 */
export function useAudioWaveform(path: string | null): {
  data: AudioWaveform | null;
  isLoading: boolean;
} {
  const [data, setData] = useState<AudioWaveform | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!path || !isTauri()) {
      setData(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setData(null);

    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const result = await invoke<{ peaks: number[]; duration: number }>('extract_waveform', {
          path,
          peaksPerSecond: 80,
        });
        if (!cancelled && result.peaks.length > 0) {
          setData({ peaks: new Float32Array(result.peaks), duration: result.duration });
        }
      } catch (err) {
        console.error('Waveform extraction failed:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  return { data, isLoading };
}
