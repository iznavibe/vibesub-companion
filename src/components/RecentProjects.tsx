import { useState, useEffect } from 'react';
import { ProjectSummary } from '../types/project';
import { listProjects, deleteProject } from '../services/projectService';
import {
  LyricProjectSummary,
  deleteLyricProject,
  listLyricProjects,
} from '../services/lyricProjectService';
import styles from './RecentProjects.module.css';

interface RecentProjectsProps {
  onProjectSelect: (projectId: string) => void;
  onNewProject: () => void;
  onLyricProjectSelect: (projectId: string) => void;
  onNewLyricProject: () => void;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffDays === 1) {
    return `Yesterday at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

export function RecentProjects({
  onProjectSelect,
  onNewProject,
  onLyricProjectSelect,
  onNewLyricProject,
}: RecentProjectsProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [lyricProjects, setLyricProjects] = useState<LyricProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    setLoading(true);
    try {
      const [projectList, lyricList] = await Promise.all([
        listProjects(),
        listLyricProjects(),
      ]);
      setProjects(projectList);
      setLyricProjects(lyricList);
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteLyric = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();

    if (deleteConfirm === projectId) {
      try {
        await deleteLyricProject(projectId);
        setLyricProjects((prev) => prev.filter((p) => p.id !== projectId));
      } catch (err) {
        console.error('Failed to delete lyric project:', err);
      }
      setDeleteConfirm(null);
    } else {
      setDeleteConfirm(projectId);
      setTimeout(() => setDeleteConfirm(null), 3000);
    }
  };

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();

    if (deleteConfirm === projectId) {
      try {
        await deleteProject(projectId);
        setProjects((prev) => prev.filter((p) => p.id !== projectId));
      } catch (err) {
        console.error('Failed to delete project:', err);
      }
      setDeleteConfirm(null);
    } else {
      setDeleteConfirm(projectId);
      setTimeout(() => setDeleteConfirm(null), 3000);
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading projects...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Recent Projects</h2>
        <div className={styles.headerButtons}>
          <button onClick={onNewLyricProject} className={styles.newButtonAlt}>
            + New Lyric Video
          </button>
          <button onClick={onNewProject} className={styles.newButton}>
            + New Project
          </button>
        </div>
      </div>

      {lyricProjects.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>Lyric videos</h3>
          <div className={styles.grid}>
            {lyricProjects.map((project) => (
              <div
                key={project.id}
                className={styles.card}
                onClick={() => onLyricProjectSelect(project.id)}
              >
                <div className={styles.cardThumbnail}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </div>
                <div className={styles.cardContent}>
                  <h3 className={styles.cardTitle}>{project.name}</h3>
                  <p className={styles.cardMeta}>{project.audioFileName}</p>
                  <p className={styles.cardDate}>
                    {project.lineCount} line{project.lineCount === 1 ? '' : 's'} ·{' '}
                    {formatDate(project.lastModifiedAt)}
                  </p>
                </div>
                <button
                  className={`${styles.deleteButton} ${deleteConfirm === project.id ? styles.deleteConfirm : ''}`}
                  onClick={(e) => handleDeleteLyric(e, project.id)}
                  title={deleteConfirm === project.id ? 'Click again to confirm' : 'Delete lyric video'}
                >
                  {deleteConfirm === project.id ? 'Confirm?' : '×'}
                </button>
              </div>
            ))}
          </div>
          <h3 className={styles.sectionTitle}>Subtitle projects</h3>
        </>
      )}

      {projects.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <p className={styles.emptyText}>No projects yet</p>
          <p className={styles.emptySubtext}>Create a new project to get started</p>
          <button onClick={onNewProject} className={styles.emptyButton}>
            Create New Project
          </button>
        </div>
      ) : (
        <div className={styles.grid}>
          {projects.map((project) => (
            <div
              key={project.id}
              className={styles.card}
              onClick={() => onProjectSelect(project.id)}
            >
              <div className={styles.cardThumbnail}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                  <line x1="7" y1="2" x2="7" y2="22" />
                  <line x1="17" y1="2" x2="17" y2="22" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <line x1="2" y1="7" x2="7" y2="7" />
                  <line x1="2" y1="17" x2="7" y2="17" />
                  <line x1="17" y1="17" x2="22" y2="17" />
                  <line x1="17" y1="7" x2="22" y2="7" />
                </svg>
              </div>
              <div className={styles.cardContent}>
                <h3 className={styles.cardTitle}>{project.name}</h3>
                <p className={styles.cardMeta}>{project.videoFileName}</p>
                <p className={styles.cardDate}>{formatDate(project.lastModifiedAt)}</p>
              </div>
              <button
                className={`${styles.deleteButton} ${deleteConfirm === project.id ? styles.deleteConfirm : ''}`}
                onClick={(e) => handleDelete(e, project.id)}
                title={deleteConfirm === project.id ? 'Click again to confirm' : 'Delete project'}
              >
                {deleteConfirm === project.id ? 'Confirm?' : '×'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
