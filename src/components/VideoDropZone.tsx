import { useState, useRef, DragEvent, ChangeEvent, useEffect } from 'react';
import { isTauri } from '../services/tauriService';
import styles from './VideoDropZone.module.css';

interface VideoDropZoneProps {
  onVideoLoaded: (file: File, path?: string) => void;
}

export function VideoDropZone({ onVideoLoaded }: VideoDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const validExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v'];

  // Set up Tauri drag-and-drop listener
  useEffect(() => {
    if (!isTauri()) return;

    let unlistenDrop: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const webview = getCurrentWebview();

        // Listen for file drop events from Tauri
        unlistenDrop = await webview.onDragDropEvent(async (event) => {
          try {
            if (event.payload.type === 'drop') {
              const paths = event.payload.paths;
              if (paths && paths.length > 0) {
                const filePath = paths[0];
                const ext = '.' + filePath.split('.').pop()?.toLowerCase();

                if (!validExtensions.includes(ext)) {
                  setError(`Please select a video file (${validExtensions.join(', ')})`);
                  return;
                }

                // Create a minimal File object - don't load video into memory
                const fileName = filePath.split(/[/\\]/).pop() || 'video';
                const file = new File([], fileName, { type: 'video/mp4' });
                onVideoLoaded(file, filePath);
              }
            }
          } catch (e) {
            console.error('Error handling drop event:', e);
            setError('Failed to load video file');
          }
        });
      } catch (e) {
        console.error('Failed to set up Tauri drag-drop listener:', e);
      }
    };

    setupListener();

    return () => {
      if (unlistenDrop) unlistenDrop();
    };
  }, [onVideoLoaded]);

  const handleFile = (file: File, path?: string) => {
    setError(null);

    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!validExtensions.includes(ext)) {
      setError(`Please select a video file (${validExtensions.join(', ')})`);
      return;
    }

    onVideoLoaded(file, path);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    // In Tauri, the tauri://drag-drop event will handle this
    if (isTauri()) {
      return;
    }

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  };

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFile(files[0]);
    }
  };

  const handleClick = async () => {
    if (isTauri()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          multiple: false,
          filters: [{
            name: 'Video',
            extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v']
          }]
        });

        if (selected && typeof selected === 'string') {
          const fileName = selected.split(/[/\\]/).pop() || 'video';
          // Create a minimal File object - don't load video into memory
          const file = new File([], fileName, { type: 'video/mp4' });
          onVideoLoaded(file, selected);
        }
      } catch (e) {
        console.error('Failed to open file dialog:', e);
        // Fall back to native file input
        fileInputRef.current?.click();
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  return (
    <div
      ref={dropZoneRef}
      className={`${styles.dropZone} ${isDragging ? styles.dragging : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,.mkv"
        onChange={handleFileSelect}
        className={styles.fileInput}
      />
      <div className={styles.content}>
        <svg
          className={styles.icon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <p className={styles.title}>Drop video file here</p>
        <p className={styles.subtitle}>or click to browse</p>
        <p className={styles.formats}>MP4, MKV, AVI, MOV, WebM</p>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
