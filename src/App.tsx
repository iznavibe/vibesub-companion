import { useState, useCallback, useRef, useEffect } from 'react';
import { VideoDropZone } from './components/VideoDropZone';
import { VideoPlayer, VideoPlayerRef } from './components/VideoPlayer';
import { SrtDropZone } from './components/SrtDropZone';
import { SubtitleList } from './components/SubtitleList';
import { SubtitleTimeline } from './components/SubtitleTimeline';
import { ModelSelector } from './components/ModelSelector';
import { DisplayModeSelector } from './components/DisplayModeSelector';
import { RecentProjects } from './components/RecentProjects';
import { TextSplitDialog } from './components/TextSplitDialog';
import { KaraokeStudio } from './components/KaraokeStudio';
import { LyricProject } from './types/karaoke';
import {
  createLyricProject,
  loadLyricProject,
  saveLyricProject,
} from './services/lyricProjectService';
import { Subtitle, SubtitleDisplayMode } from './types/subtitle';
import { ProviderConfig } from './types/provider';
import { Project } from './types/project';
import { parseSRT, generateSRT } from './utils/srtParser';
import { translateSubtitles } from './services/translationService';
import { createProject, saveProject, loadProject } from './services/projectService';
import { isTauri } from './services/tauriService';
import { useWaveformData } from './hooks/useWaveformData';
import styles from './App.module.css';

function secondsToTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function App() {
  const videoPlayerRef = useRef<VideoPlayerRef>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPath, setVideoPath] = useState<string>('');
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [srtFileName, setSrtFileName] = useState<string>('');
  const [displayMode, setDisplayMode] = useState<SubtitleDisplayMode>('both');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    localModel: 'qwen3:30b',
  });
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationProgress, setTranslationProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showProviderConfig, setShowProviderConfig] = useState(false);
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<number | null>(null);
  const [pendingSplit, setPendingSplit] = useState<{ subtitle: Subtitle; splitTime: number } | null>(null);
  const [timelineDisplayMode, setTimelineDisplayMode] = useState<SubtitleDisplayMode>('original');

  // Undo/redo history for subtitles
  const undoStackRef = useRef<Subtitle[][]>([]);
  const redoStackRef = useRef<Subtitle[][]>([]);
  const isUndoRedoRef = useRef(false);

  const lastUndoPushRef = useRef(0);

  // Push current subtitles onto undo stack before a mutation.
  // `throttle` skips if last push was <300ms ago (for high-frequency drag updates).
  const pushUndo = useCallback((throttle = false) => {
    if (isUndoRedoRef.current) return;
    if (throttle) {
      const now = Date.now();
      if (now - lastUndoPushRef.current < 300) return;
      lastUndoPushRef.current = now;
    }
    undoStackRef.current.push(structuredClone(subtitlesRef.current));
    // Cap at 50 entries
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, []);

  const handleUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    redoStackRef.current.push(structuredClone(subtitlesRef.current));
    const prev = stack.pop()!;
    isUndoRedoRef.current = true;
    setSubtitles(prev);
    isUndoRedoRef.current = false;
  }, []);

  const handleRedo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    undoStackRef.current.push(structuredClone(subtitlesRef.current));
    const next = stack.pop()!;
    isUndoRedoRef.current = true;
    setSubtitles(next);
    isUndoRedoRef.current = false;
  }, []);

  // Ctrl+Z undo, Ctrl+X redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // The karaoke studio owns history while it is open.
      if (lyricProjectRef.current) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo]);

  const exportWrapperRef = useRef<HTMLDivElement>(null);
  const syncWrapperRef = useRef<HTMLDivElement>(null);

  // Project state
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [showRecentProjects, setShowRecentProjects] = useState(true);
  const [showNewProjectDropZone, setShowNewProjectDropZone] = useState(false);

  // Karaoke / lyric-video studio. Non-null means the studio owns the screen.
  const [lyricProject, setLyricProject] = useState<LyricProject | null>(null);
  const lastSavedRef = useRef<string>('');

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportWrapperRef.current && !exportWrapperRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (syncWrapperRef.current && !syncWrapperRef.current.contains(e.target as Node)) {
        setShowSyncMenu(false);
      }
    };
    if (showExportMenu || showSyncMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showExportMenu, showSyncMenu]);

  // Track latest state in refs for auto-save (avoids expensive snapshots on every render)
  const subtitlesRef = useRef(subtitles);
  const srtFileNameRef = useRef(srtFileName);
  const displayModeRef = useRef(displayMode);
  const providerConfigRef = useRef(providerConfig);
  const currentProjectRef = useRef(currentProject);

  useEffect(() => {
    subtitlesRef.current = subtitles;
  }, [subtitles]);
  useEffect(() => { srtFileNameRef.current = srtFileName; }, [srtFileName]);
  useEffect(() => { displayModeRef.current = displayMode; }, [displayMode]);
  useEffect(() => { providerConfigRef.current = providerConfig; }, [providerConfig]);
  useEffect(() => { currentProjectRef.current = currentProject; }, [currentProject]);

  // Auto-save effect (every 30 seconds)
  useEffect(() => {
    if (!currentProject || !isTauri()) return;

    const interval = setInterval(async () => {
      const project = currentProjectRef.current;
      if (!project) return;

      const currentSnapshot = JSON.stringify({
        subtitles: subtitlesRef.current,
        srtFileName: srtFileNameRef.current,
        displayMode: displayModeRef.current,
        providerConfig: providerConfigRef.current,
      });

      if (currentSnapshot !== lastSavedRef.current) {
        const updatedProject: Project = {
          ...project,
          subtitles: subtitlesRef.current,
          srtFileName: srtFileNameRef.current,
          displayMode: displayModeRef.current,
          providerConfig: providerConfigRef.current,
        };
        try {
          await saveProject(updatedProject);
          lastSavedRef.current = currentSnapshot;
          setCurrentProject(updatedProject);
        } catch (err) {
          console.error('Auto-save failed:', err);
        }
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [currentProject]);

  // Auto-save the open lyric project on the same cadence as subtitle projects.
  const lyricProjectRef = useRef<LyricProject | null>(null);
  const lastSavedLyricRef = useRef<string>('');
  useEffect(() => {
    lyricProjectRef.current = lyricProject;
  }, [lyricProject]);

  useEffect(() => {
    if (!lyricProject || !isTauri()) return;
    const interval = setInterval(async () => {
      const project = lyricProjectRef.current;
      if (!project) return;
      const snapshot = JSON.stringify({ ...project, lastModifiedAt: '' });
      if (snapshot === lastSavedLyricRef.current) return;
      try {
        await saveLyricProject(project);
        lastSavedLyricRef.current = snapshot;
      } catch (err) {
        console.error('Lyric auto-save failed:', err);
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [lyricProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleVideoLoaded = useCallback((file: File, path?: string) => {
    setVideoFile(file);
    const videoPathToUse = path || '';
    if (path) {
      setVideoPath(path);
    }

    // Create a new project when video is loaded (only in Tauri)
    if (isTauri() && videoPathToUse) {
      const project = createProject(videoPathToUse, file.name);
      setCurrentProject(project);
      saveProject(project).catch(console.error);
      lastSavedRef.current = JSON.stringify({
        subtitles: [],
        srtFileName: '',
        displayMode: 'both',
        providerConfig,
      });
    }

    setShowNewProjectDropZone(false);
    setError(null);
  }, [providerConfig]);

  const handleSrtLoaded = useCallback((content: string, name: string) => {
    pushUndo();
    const parsed = parseSRT(content);
    setSubtitles(parsed);
    setSrtFileName(name);
    setError(null);
  }, [pushUndo]);

  const handleTranslationSrtLoaded = useCallback((content: string) => {
    pushUndo();
    const parsed = parseSRT(content);
    setSubtitles((prev) =>
      prev.map((sub, index) => ({
        ...sub,
        translatedText: parsed[index]?.originalText || sub.translatedText,
      }))
    );
    setError(null);
  }, [pushUndo]);

  const handleOriginalChange = useCallback((id: number, newText: string) => {
    pushUndo(true);
    setSubtitles((prev) =>
      prev.map((sub) =>
        sub.id === id ? { ...sub, originalText: newText } : sub
      )
    );
  }, [pushUndo]);

  const handleTranslationChange = useCallback((id: number, newText: string) => {
    pushUndo(true);
    setSubtitles((prev) =>
      prev.map((sub) =>
        sub.id === id ? { ...sub, translatedText: newText } : sub
      )
    );
  }, [pushUndo]);

  const handleSubtitleUpdate = useCallback((id: number, startSeconds: number, endSeconds: number) => {
    pushUndo(true);
    setSubtitles((prev) =>
      prev.map((sub) =>
        sub.id === id
          ? {
              ...sub,
              startSeconds,
              endSeconds,
              startTime: secondsToTimestamp(startSeconds),
              endTime: secondsToTimestamp(endSeconds),
            }
          : sub
      )
    );
  }, [pushUndo]);

  const handleSubtitleDelete = useCallback((id: number) => {
    pushUndo();
    setSubtitles((prev) => {
      const filtered = prev.filter((sub) => sub.id !== id);
      return filtered.map((sub, index) => ({ ...sub, id: index + 1 }));
    });
  }, [pushUndo]);

  const handleSubtitleAdd = useCallback((afterId: number | null, startSeconds: number, endSeconds: number) => {
    pushUndo();
    setSubtitles((prev) => {
      const newSub: Subtitle = {
        id: 0,
        startTime: secondsToTimestamp(startSeconds),
        endTime: secondsToTimestamp(endSeconds),
        startSeconds,
        endSeconds,
        originalText: 'New subtitle',
        translatedText: '',
      };

      let newList: Subtitle[];
      if (afterId === null) {
        newList = [newSub, ...prev];
      } else {
        const index = prev.findIndex((s) => s.id === afterId);
        newList = [...prev.slice(0, index + 1), newSub, ...prev.slice(index + 1)];
      }

      return newList.map((sub, index) => ({ ...sub, id: index + 1 }));
    });
  }, [pushUndo]);

  // Waveform data extraction
  const { data: waveformData, isLoading: isWaveformLoading } = useWaveformData(videoFile, videoPath);

  const handleSubtitleSelect = useCallback((id: number | null) => {
    setSelectedSubtitleId(id);
  }, []);

  // Opens the text-split dialog instead of splitting immediately
  const handleSubtitleSplit = useCallback((id: number, splitTime: number) => {
    const sub = subtitles.find(s => s.id === id);
    if (!sub) return;
    if (splitTime <= sub.startSeconds || splitTime >= sub.endSeconds) return;
    setPendingSplit({ subtitle: sub, splitTime });
    setSelectedSubtitleId(null);
  }, [subtitles]);

  // Called when the user confirms text split in the dialog
  const handleConfirmSplit = useCallback((firstText: string, secondText: string) => {
    if (!pendingSplit) return;
    const { subtitle: sub, splitTime } = pendingSplit;
    pushUndo();
    setSubtitles((prev) => {
      const index = prev.findIndex((s) => s.id === sub.id);
      if (index === -1) return prev;

      const firstHalf: Subtitle = {
        ...sub,
        endSeconds: splitTime,
        endTime: secondsToTimestamp(splitTime),
        originalText: firstText,
        translatedText: '',
      };

      const secondHalf: Subtitle = {
        ...sub,
        id: 0,
        startSeconds: splitTime,
        startTime: secondsToTimestamp(splitTime),
        originalText: secondText,
        translatedText: '',
      };

      const newList = [...prev.slice(0, index), firstHalf, secondHalf, ...prev.slice(index + 1)];
      return newList.map((s, i) => ({ ...s, id: i + 1 }));
    });
    setPendingSplit(null);
  }, [pendingSplit, pushUndo]);

  const handleSeek = useCallback((time: number) => {
    videoPlayerRef.current?.seek(time);
  }, []);

  const handleSubtitleClick = useCallback((subtitle: Subtitle) => {
    videoPlayerRef.current?.seek(subtitle.startSeconds);
  }, []);

  const handleSubtitleAddFromList = useCallback((afterId: number | null) => {
    const afterSub = afterId ? subtitles.find((s) => s.id === afterId) : null;
    const startTime = afterSub ? afterSub.endSeconds : currentTime;
    // Cap end at the next subtitle's start so new entries never overlap
    const nextSub = subtitles.find((s) => s.startSeconds >= startTime && s.id !== afterId);
    const endTime = Math.min(startTime + 2, nextSub ? nextSub.startSeconds : (duration || startTime + 2));
    handleSubtitleAdd(afterId, startTime, endTime);
  }, [subtitles, currentTime, duration, handleSubtitleAdd]);

  const validateConfig = (): boolean => {
    if (providerConfig.type === 'claude' || providerConfig.type === 'openai') {
      if (!providerConfig.apiKey?.trim()) {
        setError(`Please enter your ${providerConfig.type === 'claude' ? 'Claude' : 'OpenAI'} API key`);
        return false;
      }
    }

    if (providerConfig.type === 'ollama') {
      if (!providerConfig.localModel?.trim()) {
        setError('Please select or enter an Ollama model');
        return false;
      }
    }

    return true;
  };

  // Close gaps smaller than threshold between adjacent subtitles
  const handleTrimGaps = useCallback(() => {
    const THRESHOLD = 0.5; // seconds — gaps smaller than this get closed
    pushUndo();
    setSubtitles(prev =>
      prev.map((sub, i) => {
        if (i >= prev.length - 1) return sub;
        const next = prev[i + 1];
        const gap = next.startSeconds - sub.endSeconds;
        if (gap > 0 && gap < THRESHOLD) {
          return {
            ...sub,
            endSeconds: next.startSeconds,
            endTime: secondsToTimestamp(next.startSeconds),
          };
        }
        return sub;
      })
    );
  }, [pushUndo]);

  const handleTranslateAll = async () => {
    if (!validateConfig()) return;

    setIsTranslating(true);
    setError(null);

    try {
      const translated = await translateSubtitles(
        subtitles,
        providerConfig,
        setTranslationProgress
      );
      pushUndo();
      setSubtitles(translated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Translation failed');
    } finally {
      setIsTranslating(false);
    }
  };

  const handleExport = async (useTranslation: boolean) => {
    const srtContent = generateSRT(subtitles, useTranslation);
    const suffix = useTranslation ? '_english' : '_original';
    const defaultName = srtFileName.replace('.srt', `${suffix}.srt`);

    if (isTauri()) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        const filePath = await save({
          defaultPath: defaultName,
          filters: [{ name: 'SRT Subtitle', extensions: ['srt'] }],
        });
        if (filePath) {
          await writeTextFile(filePath, srtContent);
        }
      } catch (err) {
        console.error('Export failed:', err);
        setError('Export failed');
      }
    } else {
      const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const handleImportTranslation = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const content = e.target?.result as string;
          handleTranslationSrtLoaded(content);
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  const handleReset = () => {
    setVideoFile(null);
    setVideoPath('');
    setSubtitles([]);
    setSrtFileName('');
    setError(null);
    setCurrentTime(0);
    setDuration(0);
    setCurrentProject(null);
    setSelectedSubtitleId(null);
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastSavedRef.current = '';
  };

  const handleBackToProjects = async () => {
    // Save current project before going back
    if (currentProject && isTauri()) {
      const updatedProject: Project = {
        ...currentProject,
        subtitles,
        srtFileName,
        displayMode,
        providerConfig,
      };
      try {
        await saveProject(updatedProject);
      } catch (err) {
        console.error('Failed to save project:', err);
      }
    }
    handleReset();
    setShowRecentProjects(true);
    setShowNewProjectDropZone(false);
  };

  const handleProjectSelect = async (projectId: string) => {
    try {
      const project = await loadProject(projectId);
      setCurrentProject(project);
      setSubtitles(project.subtitles);
      setSrtFileName(project.srtFileName);
      setDisplayMode(project.displayMode);
      setProviderConfig(project.providerConfig);
      if (project.video) {
        setVideoPath(project.video.path);
        // Create a placeholder File object for VideoPlayer
        const file = new File([], project.video.fileName, { type: 'video/mp4' });
        setVideoFile(file);
      }
      lastSavedRef.current = JSON.stringify({
        subtitles: project.subtitles,
        srtFileName: project.srtFileName,
        displayMode: project.displayMode,
        providerConfig: project.providerConfig,
      });
      setShowRecentProjects(false);
    } catch (err) {
      console.error('Failed to load project:', err);
      setError('Failed to load project');
    }
  };

  const handleNewProject = () => {
    handleReset();
    setShowRecentProjects(false);
    setShowNewProjectDropZone(true);
  };

  const handleNewLyricProject = () => {
    setLyricProject(createLyricProject());
    setShowRecentProjects(false);
  };

  const handleLyricProjectSelect = async (projectId: string) => {
    try {
      setLyricProject(await loadLyricProject(projectId));
      setShowRecentProjects(false);
    } catch (err) {
      console.error('Failed to load lyric project:', err);
      setError('Failed to load lyric video project');
    }
  };

  const handleLyricBack = async () => {
    if (lyricProject) {
      try {
        await saveLyricProject(lyricProject);
      } catch (err) {
        console.error('Failed to save lyric project:', err);
      }
    }
    setLyricProject(null);
    setShowRecentProjects(true);
  };

  // Initial state: show two drop zones side by side
  const showInitialDropZones = !videoFile || subtitles.length === 0;

  // Karaoke studio takes over the whole window while a lyric project is open.
  if (lyricProject) {
    return (
      <div className={`${styles.app} ${styles.appStudio}`}>
        <main className={`${styles.main} ${styles.mainStudio}`}>
          <KaraokeStudio
            project={lyricProject}
            onProjectChange={setLyricProject}
            onBack={handleLyricBack}
          />
        </main>
      </div>
    );
  }

  // Show recent projects screen in Tauri environment
  if (showRecentProjects && isTauri()) {
    return (
      <div className={styles.app}>
        <header className={styles.header}>
          <h1 className={styles.title}>VibeSub</h1>
        </header>
        <main className={styles.main}>
          <RecentProjects
            onProjectSelect={handleProjectSelect}
            onNewProject={handleNewProject}
            onLyricProjectSelect={handleLyricProjectSelect}
            onNewLyricProject={handleNewLyricProject}
          />
        </main>
      </div>
    );
  }

  // Show new project drop zone (video upload)
  if (showNewProjectDropZone && !videoFile) {
    return (
      <div className={styles.app}>
        <header className={styles.header}>
          <h1 className={styles.title}>VibeSub</h1>
        </header>
        <main className={styles.main}>
          <div className={styles.newProjectContainer}>
            <button onClick={handleBackToProjects} className={styles.backButton}>
              &larr; Back to Projects
            </button>
            <VideoDropZone onVideoLoaded={handleVideoLoaded} />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>VibeSub</h1>
      </header>

      <main className={styles.main}>
        {showInitialDropZones ? (
          /* Initial state: two drop zones side by side */
          <div className={styles.initialView}>
            {videoFile && (
              <button
                onClick={isTauri() ? handleBackToProjects : handleReset}
                className={styles.backButton}
              >
                &larr; {isTauri() ? 'Back to Projects' : 'Home'}
              </button>
            )}
            <div className={styles.dropZoneRow}>
              <div className={styles.dropZoneContainer}>
                {!videoFile ? (
                  <VideoDropZone onVideoLoaded={handleVideoLoaded} />
                ) : (
                  <div className={styles.videoPreview}>
                    <VideoPlayer
                      ref={videoPlayerRef}
                      videoFile={videoFile}
                      videoPath={videoPath}
                      subtitles={[]}
                      displayMode={displayMode}
                      onTimeUpdate={setCurrentTime}
                      onDurationChange={setDuration}
                    />
                  </div>
                )}
              </div>
              <div className={styles.dropZoneContainer}>
                <SrtDropZone
                  onFileLoaded={handleSrtLoaded}
                  hasSubtitles={false}
                  fileName=""
                />
              </div>
            </div>
          </div>
        ) : (
          /* Main workspace: video left, subtitles right */
          <div className={styles.workspace}>
            <div className={styles.videoPanel}>
              <VideoPlayer
                ref={videoPlayerRef}
                videoFile={videoFile}
                videoPath={videoPath}
                subtitles={subtitles}
                displayMode={displayMode}
                onTimeUpdate={setCurrentTime}
                onDurationChange={setDuration}
              />
              <div className={styles.videoControls}>
                <SrtDropZone
                  onFileLoaded={handleSrtLoaded}
                  hasSubtitles={subtitles.length > 0}
                  fileName={srtFileName}
                />
                <DisplayModeSelector
                  mode={displayMode}
                  onChange={setDisplayMode}
                />
              </div>
              {subtitles.length > 0 && duration > 0 && (
                <SubtitleTimeline
                  subtitles={subtitles}
                  duration={duration}
                  currentTime={currentTime}
                  onSeek={handleSeek}
                  onSubtitleUpdate={handleSubtitleUpdate}
                  onSubtitleDelete={handleSubtitleDelete}
                  onSubtitleAdd={handleSubtitleAdd}
                  selectedSubtitleId={selectedSubtitleId}
                  onSubtitleSelect={handleSubtitleSelect}
                  onSubtitleSplit={handleSubtitleSplit}
                  waveformData={waveformData}
                  isWaveformLoading={isWaveformLoading}
                  timelineDisplayMode={timelineDisplayMode}
                  onTimelineDisplayModeChange={setTimelineDisplayMode}
                />
              )}
            </div>

            <div className={styles.editorPanel}>
              <div className={styles.toolbar}>
                <div className={styles.actions}>
                  <button
                    onClick={handleTranslateAll}
                    disabled={isTranslating || subtitles.length === 0}
                    className={styles.translateBtn}
                  >
                    {isTranslating
                      ? `${translationProgress.completed}/${translationProgress.total}`
                      : 'Translate'}
                  </button>
                  <button
                    onClick={handleImportTranslation}
                    disabled={subtitles.length === 0}
                    className={styles.importBtn}
                  >
                    Import
                  </button>
                  <button
                    onClick={handleTrimGaps}
                    disabled={subtitles.length === 0}
                    className={styles.trimBtn}
                    title="Extend each subtitle's end time to meet the next one when the gap is under 500ms"
                  >
                    Trim Gaps
                  </button>
                  <div ref={exportWrapperRef} className={styles.exportWrapper}>
                    <button
                      onClick={() => setShowExportMenu(!showExportMenu)}
                      disabled={subtitles.length === 0}
                      className={styles.exportBtn}
                    >
                      Export
                      <span className={styles.dropdownArrow}>▾</span>
                    </button>
                    {showExportMenu && (
                      <div className={styles.exportMenu}>
                        <button
                          onClick={() => { handleExport(true); setShowExportMenu(false); }}
                          className={styles.exportMenuItem}
                        >
                          Translation (English)
                        </button>
                        <button
                          onClick={() => { handleExport(false); setShowExportMenu(false); }}
                          className={styles.exportMenuItem}
                        >
                          Original (Korean)
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={isTauri() ? handleBackToProjects : handleReset}
                    className={styles.resetBtn}
                  >
                    {isTauri() ? 'Back to Projects' : 'New Video'}
                  </button>
                </div>
              </div>

              <div className={styles.modelSection}>
                <button
                  className={styles.modelToggle}
                  onClick={() => setShowProviderConfig(!showProviderConfig)}
                >
                  <span>Translation Provider</span>
                  <span className={`${styles.toggleArrow} ${showProviderConfig ? styles.open : ''}`}>
                    ▼
                  </span>
                </button>
                {showProviderConfig && (
                  <div className={styles.modelContent}>
                    <ModelSelector
                      config={providerConfig}
                      onChange={setProviderConfig}
                    />
                  </div>
                )}
              </div>

              {error && <div className={styles.error}>{error}</div>}

              <SubtitleList
                subtitles={subtitles}
                currentTime={currentTime}
                onOriginalChange={handleOriginalChange}
                onTranslationChange={handleTranslationChange}
                onSubtitleClick={handleSubtitleClick}
                onSubtitleDelete={handleSubtitleDelete}
                onSubtitleAdd={handleSubtitleAddFromList}
              />
            </div>
          </div>
        )}
      </main>

      {pendingSplit && (
        <TextSplitDialog
          subtitle={pendingSplit.subtitle}
          splitTime={pendingSplit.splitTime}
          onConfirm={handleConfirmSplit}
          onCancel={() => setPendingSplit(null)}
        />
      )}
    </div>
  );
}

export default App;
