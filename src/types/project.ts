import { Subtitle, SubtitleDisplayMode } from './subtitle';
import { ProviderConfig } from './provider';

export interface Project {
  version: string;
  id: string;
  name: string;
  createdAt: string;
  lastModifiedAt: string;
  video: { path: string; fileName: string } | null;
  srtFileName: string;
  subtitles: Subtitle[];
  displayMode: SubtitleDisplayMode;
  providerConfig: ProviderConfig;
}

export interface ProjectSummary {
  id: string;
  name: string;
  lastModifiedAt: string;
  videoFileName: string;
  thumbnailPath?: string;
}
