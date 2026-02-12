import { useState, useEffect } from 'react';
import { isTauri } from '../services/tauriService';

export interface WaveformData {
  peaks: Float32Array;
  duration: number;
}

export function useWaveformData(
  videoFile: File | null,
  videoPath?: string
): WaveformData | null {
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);

  useEffect(() => {
    if (!videoFile) {
      setWaveformData(null);
      return;
    }

    let cancelled = false;

    async function extractWaveform() {
      try {
        let arrayBuf: ArrayBuffer;

        if (isTauri() && videoPath) {
          // In Tauri, the File object is a placeholder (size 0).
          // Read the actual file via the Tauri FS plugin.
          const { readFile } = await import('@tauri-apps/plugin-fs');
          const bytes = await readFile(videoPath);
          arrayBuf = bytes.buffer as ArrayBuffer;
        } else {
          // Browser: read directly from File
          arrayBuf = await videoFile!.arrayBuffer();
        }

        if (cancelled) return;

        const audioCtx = new AudioContext();
        let audioBuffer: AudioBuffer;

        try {
          audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
        } catch {
          // Some video formats can't be decoded — fail silently
          audioCtx.close();
          return;
        }

        if (cancelled) {
          audioCtx.close();
          return;
        }

        const channelData = audioBuffer.getChannelData(0);
        const audioDuration = audioBuffer.duration;

        // ~50 peaks/sec gives word-level detail for speech waveforms
        const peaksPerSecond = 50;
        const totalPeaks = Math.ceil(audioDuration * peaksPerSecond);
        if (totalPeaks === 0) {
          audioCtx.close();
          return;
        }
        const samplesPerPeak = Math.max(1, Math.floor(channelData.length / totalPeaks));
        const peaks = new Float32Array(totalPeaks);

        for (let i = 0; i < totalPeaks; i++) {
          const start = i * samplesPerPeak;
          const end = Math.min(start + samplesPerPeak, channelData.length);
          if (end <= start) continue;
          // Use RMS (root mean square) for smoother, speech-shaped waveform
          let sumSq = 0;
          for (let j = start; j < end; j++) {
            sumSq += channelData[j] * channelData[j];
          }
          peaks[i] = Math.sqrt(sumSq / (end - start));
        }

        // Normalize peaks so the loudest point fills the full height
        let maxPeak = 0;
        for (let i = 0; i < totalPeaks; i++) {
          if (peaks[i] > maxPeak) maxPeak = peaks[i];
        }
        if (maxPeak > 0) {
          for (let i = 0; i < totalPeaks; i++) {
            peaks[i] /= maxPeak;
          }
        }

        audioCtx.close();

        if (!cancelled) {
          setWaveformData({ peaks, duration: audioDuration });
        }
      } catch (err) {
        console.error('Waveform extraction failed:', err);
      }
    }

    extractWaveform();

    return () => {
      cancelled = true;
    };
  }, [videoFile, videoPath]);

  return waveformData;
}
