import { Subtitle } from '../types/subtitle';
import { ProviderConfig } from '../types/provider';

const BATCH_SIZE = 10;

interface TranslationProgress {
  completed: number;
  total: number;
}

const TRANSLATION_PROMPT = `Translate the following Korean subtitle texts to English. Maintain the natural flow and tone. Return ONLY a JSON array with objects containing "id" and "translation" fields. Do not include any other text or explanation.

Input:
`;

export async function translateSubtitles(
  subtitles: Subtitle[],
  config: ProviderConfig,
  onProgress: (progress: TranslationProgress) => void
): Promise<Subtitle[]> {
  const result = [...subtitles];
  const batches: Subtitle[][] = [];

  for (let i = 0; i < subtitles.length; i += BATCH_SIZE) {
    batches.push(subtitles.slice(i, i + BATCH_SIZE));
  }

  let completed = 0;

  for (const batch of batches) {
    const textsToTranslate = batch.map((s) => ({
      id: s.id,
      text: s.originalText,
    }));

    const prompt = TRANSLATION_PROMPT + JSON.stringify(textsToTranslate, null, 2);

    let content: string;

    switch (config.type) {
      case 'claude':
        content = await translateWithClaude(prompt, config.apiKey!);
        break;
      case 'openai':
        content = await translateWithOpenAI(prompt, config.apiKey!);
        break;
      case 'ollama':
        content = await translateWithOllama(prompt, config.localModel!, config.baseUrl);
        break;
      default:
        throw new Error(`Unknown provider: ${config.type}`);
    }

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const translations = JSON.parse(jsonMatch[0]);
        // Build a lookup map for O(n) matching instead of O(n²)
        const resultMap = new Map(result.map((s, i) => [s.id, i]));
        for (const t of translations) {
          const index = resultMap.get(t.id);
          if (index !== undefined) {
            result[index] = { ...result[index], translatedText: t.translation };
          }
        }
      } catch {
        console.warn('Failed to parse translation response for batch, skipping');
      }
    }

    completed += batch.length;
    onProgress({ completed, total: subtitles.length });
  }

  return result;
}

async function translateWithClaude(prompt: string, apiKey: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Claude API request failed');
  }

  const data = await response.json();
  return data.content[0]?.text || '';
}

async function translateWithOpenAI(prompt: string, apiKey: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'OpenAI API request failed');
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

async function translateWithOllama(
  prompt: string,
  model: string,
  baseUrl?: string
): Promise<string> {
  const url = baseUrl || 'http://localhost:11434';

  const response = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error('Ollama API request failed. Make sure Ollama is running.');
  }

  const data = await response.json();
  return data.response || '';
}

