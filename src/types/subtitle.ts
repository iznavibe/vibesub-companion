export interface Subtitle {
  id: number;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  originalText: string;
  translatedText: string;
}

export type SubtitleDisplayMode = 'original' | 'translation' | 'both';
