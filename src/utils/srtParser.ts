import { Subtitle } from '../types/subtitle';

function timeToSeconds(time: string): number {
  // Parse "00:01:23,456" to seconds
  const parts = time.split(',');
  const timePart = parts[0] || '0:0:0';
  const msPart = parts[1] || '0';
  const timeParts = timePart.split(':').map(Number);
  const hours = timeParts[0] || 0;
  const minutes = timeParts[1] || 0;
  const seconds = timeParts[2] || 0;
  const ms = parseInt(msPart, 10) || 0;
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

export function parseSRT(content: string): Subtitle[] {
  const subtitles: Subtitle[] = [];

  // Normalize line endings and split into blocks
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');

    if (lines.length < 3) continue;

    // First line is the subtitle number
    const id = parseInt(lines[0], 10);
    if (isNaN(id)) continue;

    // Second line is the timestamp
    const timestampMatch = lines[1].match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );

    if (!timestampMatch) continue;

    const startTime = timestampMatch[1];
    const endTime = timestampMatch[2];

    // Rest is the subtitle text (can be multiple lines)
    const text = lines.slice(2).join('\n');

    subtitles.push({
      id,
      startTime,
      endTime,
      startSeconds: timeToSeconds(startTime),
      endSeconds: timeToSeconds(endTime),
      originalText: text,
      translatedText: '',
    });
  }

  return subtitles;
}

export function generateSRT(subtitles: Subtitle[], useTranslated: boolean = true): string {
  return subtitles
    .map((sub) => {
      const text = useTranslated && sub.translatedText
        ? sub.translatedText
        : sub.originalText;
      return `${sub.id}\n${sub.startTime} --> ${sub.endTime}\n${text}`;
    })
    .join('\n\n') + '\n';
}

export function getCurrentSubtitle(subtitles: Subtitle[], currentTime: number): Subtitle | null {
  // Binary search for better performance with large subtitle lists
  if (subtitles.length === 0) return null;

  let left = 0;
  let right = subtitles.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const sub = subtitles[mid];

    if (currentTime >= sub.startSeconds && currentTime <= sub.endSeconds) {
      return sub;
    }

    if (currentTime < sub.startSeconds) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return null;
}
