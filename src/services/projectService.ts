import { Project, ProjectSummary } from '../types/project';
import { Subtitle, SubtitleDisplayMode } from '../types/subtitle';
import { ProviderConfig } from '../types/provider';
import { isTauri } from './tauriService';

const PROJECT_VERSION = '1.0';
const PROJECTS_FOLDER = 'vibesub-companion/projects';

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function getProjectsDir(): Promise<string> {
  if (!isTauri()) {
    throw new Error('Projects can only be saved in Tauri environment');
  }

  const { appDataDir } = await import('@tauri-apps/api/path');
  const { mkdir } = await import('@tauri-apps/plugin-fs');

  const { join } = await import('@tauri-apps/api/path');
  const appData = await appDataDir();
  const projectsDir = await join(appData, PROJECTS_FOLDER);

  // Ensure directory exists
  try {
    await mkdir(projectsDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  return projectsDir;
}

export function createProject(
  videoPath: string,
  videoFileName: string,
  subtitles: Subtitle[] = [],
  srtFileName: string = '',
  displayMode: SubtitleDisplayMode = 'both',
  providerConfig: ProviderConfig = {
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    localModel: 'qwen3:30b',
  }
): Project {
  const now = new Date().toISOString();
  const projectName = videoFileName.replace(/\.[^.]+$/, '');

  return {
    version: PROJECT_VERSION,
    id: generateUUID(),
    name: projectName,
    createdAt: now,
    lastModifiedAt: now,
    video: { path: videoPath, fileName: videoFileName },
    srtFileName,
    subtitles,
    displayMode,
    providerConfig,
  };
}

export async function saveProject(project: Project): Promise<void> {
  if (!isTauri()) {
    console.warn('Cannot save project: not in Tauri environment');
    return;
  }

  const { writeTextFile } = await import('@tauri-apps/plugin-fs');

  const { join } = await import('@tauri-apps/api/path');
  const projectsDir = await getProjectsDir();
  const filePath = await join(projectsDir, `${project.id}.vibesub`);

  const projectToSave = {
    ...project,
    lastModifiedAt: new Date().toISOString(),
  };

  await writeTextFile(filePath, JSON.stringify(projectToSave, null, 2));
}

export async function loadProject(projectId: string): Promise<Project> {
  if (!isTauri()) {
    throw new Error('Cannot load project: not in Tauri environment');
  }

  const { readTextFile } = await import('@tauri-apps/plugin-fs');
  const { join } = await import('@tauri-apps/api/path');

  const projectsDir = await getProjectsDir();
  const filePath = await join(projectsDir, `${projectId}.vibesub`);

  const content = await readTextFile(filePath);
  return JSON.parse(content) as Project;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  if (!isTauri()) {
    return [];
  }

  const { readDir, readTextFile } = await import('@tauri-apps/plugin-fs');
  const { join } = await import('@tauri-apps/api/path');

  const projectsDir = await getProjectsDir();

  let entries;
  try {
    entries = await readDir(projectsDir);
  } catch {
    return [];
  }

  const summaries: ProjectSummary[] = [];

  for (const entry of entries) {
    if (entry.name?.endsWith('.vibesub')) {
      try {
        const filePath = await join(projectsDir, entry.name);
        const content = await readTextFile(filePath);
        const project = JSON.parse(content) as Project;

        summaries.push({
          id: project.id,
          name: project.name,
          lastModifiedAt: project.lastModifiedAt,
          videoFileName: project.video?.fileName || 'Unknown',
        });
      } catch (err) {
        console.error(`Failed to read project ${entry.name}:`, err);
      }
    }
  }

  // Sort by last modified, newest first
  summaries.sort(
    (a, b) =>
      new Date(b.lastModifiedAt).getTime() - new Date(a.lastModifiedAt).getTime()
  );

  return summaries;
}

export async function deleteProject(projectId: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('Cannot delete project: not in Tauri environment');
  }

  const { remove } = await import('@tauri-apps/plugin-fs');
  const { join } = await import('@tauri-apps/api/path');

  const projectsDir = await getProjectsDir();
  const filePath = await join(projectsDir, `${projectId}.vibesub`);

  await remove(filePath);
}
