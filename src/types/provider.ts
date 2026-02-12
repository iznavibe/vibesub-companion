export type ProviderType = 'claude' | 'openai' | 'ollama';

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  localModel?: string;
  baseUrl?: string;
}

export interface ProviderOption {
  value: ProviderType;
  label: string;
  requiresApiKey: boolean;
  requiresLocalModel: boolean;
  defaultModels?: string[];
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: 'ollama',
    label: 'Ollama (Local)',
    requiresApiKey: false,
    requiresLocalModel: true,
    defaultModels: ['qwen3:30b', 'qwen3:8b', 'qwen3:14b', 'qwen2.5:7b', 'llama3.2', 'mistral'],
  },
  {
    value: 'claude',
    label: 'Claude (Anthropic)',
    requiresApiKey: true,
    requiresLocalModel: false,
  },
  {
    value: 'openai',
    label: 'ChatGPT (OpenAI)',
    requiresApiKey: true,
    requiresLocalModel: false,
  },
];

export const DEFAULT_OLLAMA_MODEL = 'qwen3:8b';
