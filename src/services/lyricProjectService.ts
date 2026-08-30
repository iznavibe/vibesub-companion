import { LyricProject, createEmptyLyricProject } from '../types/karaoke';
import { getProjectsDir } from './projectService';
import { isTauri } from './tauriService';

const EXTENSION = '.vibelyric';

export interface LyricProjectSummary {
  id: string;
  name: string;
  lastModifiedAt: string;
  audioFileName: string;
  lineCount: number;
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createLyricProject(name = 'Untitled lyric video'): LyricProject {
  return createEmptyLyricProject(generateUUID(), name);
}

export async function saveLyricProject(project: LyricProject): Promise<void> {
  if (!isTauri()) return;
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');
  const { join } = await import('@tauri-apps/api/path');
  const dir = await getProjectsDir();
  const filePath = await join(dir, `${project.id}${EXTENSION}`);
  await writeTextFile(
    filePath,
    JSON.stringify({ ...project, lastModifiedAt: new Date().toISOString() }, null, 2)
  );
}

export async function loadLyricProject(id: string): Promise<LyricProject> {
  if (!isTauri()) throw new Error('Lyric projects are only available in the desktop app');
  const { readTextFile } = await import('@tauri-apps/plugin-fs');
  const { join } = await import('@tauri-apps/api/path');
  const dir = await getProjectsDir();
  const content = await readTextFile(await join(dir, `${id}${EXTENSION}`));
  return JSON.parse(content) as LyricProject;
}

export async function listLyricProjects(): Promise<LyricProjectSummary[]> {
  if (!isTauri()) return [];
  const { readDir, readTextFile } = await import('@tauri-apps/plugin-fs');
  const { join } = await import('@tauri-apps/api/path');
  const dir = await getProjectsDir();

  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return [];
  }

  const summaries: LyricProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.name?.endsWith(EXTENSION)) continue;
    try {
      const content = await readTextFile(await join(dir, entry.name));
      const project = JSON.parse(content) as LyricProject;
      summaries.push({
        id: project.id,
        name: project.name,
        lastModifiedAt: project.lastModifiedAt,
        audioFileName: project.audio?.fileName ?? 'No audio',
        lineCount: project.lines.length,
      });
    } catch (err) {
      console.error(`Failed to read lyric project ${entry.name}:`, err);
    }
  }

  summaries.sort(
    (a, b) => new Date(b.lastModifiedAt).getTime() - new Date(a.lastModifiedAt).getTime()
  );
  return summaries;
}

export async function deleteLyricProject(id: string): Promise<void> {
  if (!isTauri()) return;
  const { remove } = await import('@tauri-apps/plugin-fs');
  const { join } = await import('@tauri-apps/api/path');
  const dir = await getProjectsDir();
  await remove(await join(dir, `${id}${EXTENSION}`));
}
