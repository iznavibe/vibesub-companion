import { useRef, useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import { Subtitle, SubtitleDisplayMode } from '../types/subtitle';
import { getCurrentSubtitle } from '../utils/srtParser';
import { isTauri } from '../services/tauriService';
import styles from './VideoPlayer.module.css';

export interface VideoPlayerRef {
  seek: (time: number) => void;
  getDuration: () => number;
}

interface VideoPlayerProps {
  videoFile: File;
  videoPath?: string; // For Tauri: the actual file path
  subtitles: Subtitle[];
  displayMode: SubtitleDisplayMode;
  onTimeUpdate?: (time: number) => void;
  onDurationChange?: (duration: number) => void;
}

export const VideoPlayer = forwardRef<VideoPlayerRef, VideoPlayerProps>(
  ({ videoFile, videoPath, subtitles, displayMode, onTimeUpdate, onDurationChange }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [videoUrl, setVideoUrl] = useState<string>('');
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const currentSubtitle = getCurrentSubtitle(subtitles, currentTime);

    useImperativeHandle(ref, () => ({
      seek: (time: number) => {
        if (videoRef.current) {
          videoRef.current.currentTime = time;
        }
      },
      getDuration: () => duration,
    }));

    useEffect(() => {
      let url: string | undefined;
      let shouldRevoke = false;

      const setupVideo = async () => {
        try {
          // In Tauri with a file path, use convertFileSrc
          if (isTauri() && videoPath) {
            const { convertFileSrc } = await import('@tauri-apps/api/core');
            url = convertFileSrc(videoPath);
            setVideoUrl(url);
            setError(null);
          } else if (videoFile && videoFile.size > 0) {
            // Regular browser File object with actual data
            url = URL.createObjectURL(videoFile);
            shouldRevoke = true;
            setVideoUrl(url);
            setError(null);
          } else if (!isTauri()) {
            // Only show error in browser mode if we don't have a valid file
            setError('Could not load video file');
          }
        } catch (e) {
          console.error('Error setting up video:', e);
          setError('Error loading video');
        }
      };

      setupVideo();

      return () => {
        if (shouldRevoke && url) {
          URL.revokeObjectURL(url);
        }
      };
    }, [videoFile, videoPath]);

    // Spacebar to play/pause (only when not typing in an input/textarea)
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.code === 'Space') {
          const activeElement = document.activeElement;
          const isTyping = activeElement?.tagName === 'INPUT' ||
                          activeElement?.tagName === 'TEXTAREA';

          if (!isTyping && videoRef.current) {
            e.preventDefault();
            if (videoRef.current.paused) {
              videoRef.current.play();
            } else {
              videoRef.current.pause();
            }
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const handleTimeUpdate = () => {
      if (videoRef.current) {
        const time = videoRef.current.currentTime;
        setCurrentTime(time);
        onTimeUpdate?.(time);
      }
    };

    const handleLoadedMetadata = () => {
      if (videoRef.current) {
        const dur = videoRef.current.duration;
        setDuration(dur);
        onDurationChange?.(dur);
      }
    };

    const handleError = () => {
      setError('Failed to load video. The file format may not be supported.');
    };

    const renderSubtitleText = () => {
      if (!currentSubtitle) return null;

      const hasTranslation = currentSubtitle.translatedText.trim() !== '';

      switch (displayMode) {
        case 'original':
          return (
            <div className={styles.subtitleText}>
              {currentSubtitle.originalText}
            </div>
          );
        case 'translation':
          return hasTranslation ? (
            <div className={styles.subtitleText}>
              {currentSubtitle.translatedText}
            </div>
          ) : (
            <div className={styles.subtitleText}>
              {currentSubtitle.originalText}
            </div>
          );
        case 'both':
          return (
            <div className={styles.subtitleBoth}>
              <div className={styles.subtitleOriginal}>
                {currentSubtitle.originalText}
              </div>
              {hasTranslation && (
                <div className={styles.subtitleTranslation}>
                  {currentSubtitle.translatedText}
                </div>
              )}
            </div>
          );
      }
    };

    return (
      <div className={styles.container}>
        <div className={styles.videoWrapper}>
          {error ? (
            <div className={styles.error}>{error}</div>
          ) : (
            <video
              ref={videoRef}
              className={styles.video}
              src={videoUrl}
              controls
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onError={handleError}
            />
          )}
          {currentSubtitle && !error && (
            <div className={styles.subtitleOverlay}>
              {renderSubtitleText()}
            </div>
          )}
        </div>
      </div>
    );
  }
);

VideoPlayer.displayName = 'VideoPlayer';
