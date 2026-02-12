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
        // In Tauri, use the native Rust command for fast, reliable extraction
        if (isTauri() && videoPath) {
          const { invoke } = await import('@tauri-apps/api/core');
          const result = await invoke<{ peaks: number[]; duration: number }>(
            'extract_waveform',
            { path: videoPath, peaksPerSecond: 50 }
          );

          if (!cancelled && result.peaks.length > 0) {
            setWaveformData({
              peaks: new Float32Array(result.peaks),
              duration: result.duration,
            });
          }
          return;
        }

        // Browser fallback: Web Audio API
        if (!videoFile || videoFile.size === 0) return;

        const arrayBuf = await videoFile.arrayBuffer();
        if (cancelled) return;

        const audioCtx = new AudioContext();
        let audioBuffer: AudioBuffer;

        try {
          audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
        } catch {
          audioCtx.close();
          return;
        }

        if (cancelled) {
          audioCtx.close();
          return;
        }

        const channelData = audioBuffer.getChannelData(0);
        const audioDuration = audioBuffer.duration;

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
          let sumSq = 0;
          for (let j = start; j < end; j++) {
            sumSq += channelData[j] * channelData[j];
          }
          peaks[i] = Math.sqrt(sumSq / (end - start));
        }

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
