import { useState, useRef, DragEvent, ChangeEvent, useEffect } from 'react';
import { isTauri } from '../services/tauriService';
import styles from './SrtDropZone.module.css';

interface SrtDropZoneProps {
  onFileLoaded: (content: string, fileName: string) => void;
  hasSubtitles: boolean;
  fileName?: string;
}

export function SrtDropZone({ onFileLoaded, hasSubtitles, fileName }: SrtDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Set up Tauri drag-and-drop listener
  useEffect(() => {
    if (!isTauri()) return;

    let unlistenDrop: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const webview = getCurrentWebview();

        unlistenDrop = await webview.onDragDropEvent(async (event) => {
          try {
            if (event.payload.type === 'drop') {
              const paths = event.payload.paths;
              if (paths && paths.length > 0) {
                const filePath = paths[0];

                if (!filePath.toLowerCase().endsWith('.srt')) {
                  // Not an SRT file, ignore (let VideoDropZone handle it)
                  return;
                }

                const fileName = filePath.split(/[/\\]/).pop() || 'subtitles.srt';

                // Read the file content using Tauri's fs plugin
                try {
                  const { readTextFile } = await import('@tauri-apps/plugin-fs');
                  const content = await readTextFile(filePath);
                  onFileLoaded(content, fileName);
                } catch (e) {
                  console.error('Failed to read SRT file:', e);
                  setError('Failed to read SRT file');
                }
              }
            }
          } catch (e) {
            console.error('Error handling SRT drop event:', e);
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
  }, [onFileLoaded]);

  const handleFile = async (file: File) => {
    setError(null);

    if (!file.name.toLowerCase().endsWith('.srt')) {
      setError('Please select an SRT file');
      return;
    }

    try {
      const content = await file.text();
      onFileLoaded(content, file.name);
    } catch {
      setError('Failed to read file');
    }
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

    // In Tauri, the drag-drop event will handle this
    if (isTauri()) {
      return;
    }

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  };

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
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
            name: 'Subtitle',
            extensions: ['srt']
          }]
        });

        if (selected && typeof selected === 'string') {
          const fileName = selected.split(/[/\\]/).pop() || 'subtitles.srt';

          try {
            const { readTextFile } = await import('@tauri-apps/plugin-fs');
            const content = await readTextFile(selected);
            onFileLoaded(content, fileName);
          } catch (e) {
            console.error('Failed to read SRT file:', e);
            setError('Failed to read SRT file');
          }
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

  if (hasSubtitles) {
    return (
      <div className={styles.loaded} onClick={handleClick}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".srt"
          onChange={handleFileSelect}
          className={styles.fileInput}
        />
        <svg
          className={styles.checkIcon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span className={styles.loadedTitle}>{fileName}</span>
      </div>
    );
  }

  return (
    <div
      className={`${styles.dropZone} ${isDragging ? styles.dragging : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".srt"
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
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <p className={styles.title}>Drop SRT file here</p>
        <p className={styles.subtitle}>or click to browse</p>
        <p className={styles.formats}>SubRip Subtitle (.srt)</p>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
