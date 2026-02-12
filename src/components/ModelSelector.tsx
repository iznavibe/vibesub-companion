import { useState, useEffect } from 'react';
import { ProviderType, ProviderConfig, PROVIDER_OPTIONS } from '../types/provider';
import styles from './ModelSelector.module.css';

interface ModelSelectorProps {
  config: ProviderConfig;
  onChange: (config: ProviderConfig) => void;
}

export function ModelSelector({ config, onChange }: ModelSelectorProps) {
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  const selectedProvider = PROVIDER_OPTIONS.find((p) => p.value === config.type);

  useEffect(() => {
    if (config.type === 'ollama') {
      fetchOllamaModels();
    }
  }, [config.type]);

  const fetchOllamaModels = async () => {
    setIsLoadingModels(true);
    setOllamaError(null);

    try {
      const baseUrl = config.baseUrl || 'http://localhost:11434';
      const response = await fetch(`${baseUrl}/api/tags`);

      if (!response.ok) {
        throw new Error('Failed to fetch Ollama models');
      }

      const data = await response.json();
      const models = data.models?.map((m: { name: string }) => m.name) || [];
      setOllamaModels(models);

      if (models.length > 0 && !config.localModel) {
        onChange({ ...config, localModel: models[0] });
      }
    } catch {
      setOllamaError('Cannot connect to Ollama. Make sure it is running.');
      setOllamaModels(selectedProvider?.defaultModels || []);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const handleProviderChange = (type: ProviderType) => {
    onChange({
      type,
      apiKey: '',
      localModel: '',
      baseUrl: type === 'ollama' ? 'http://localhost:11434' : undefined,
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.field}>
        <label className={styles.label}>Translation Provider</label>
        <select
          value={config.type}
          onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
          className={styles.select}
        >
          {PROVIDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {selectedProvider?.requiresApiKey && (
        <div className={styles.field}>
          <label className={styles.label}>API Key</label>
          <input
            type="password"
            placeholder={`Enter ${selectedProvider.label} API Key`}
            value={config.apiKey || ''}
            onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
            className={styles.input}
          />
        </div>
      )}

      {config.type === 'ollama' && (
        <>
          <div className={styles.field}>
            <label className={styles.label}>Ollama URL</label>
            <input
              type="text"
              placeholder="http://localhost:11434"
              value={config.baseUrl || ''}
              onChange={(e) => onChange({ ...config, baseUrl: e.target.value })}
              className={styles.input}
            />
            <button
              onClick={fetchOllamaModels}
              className={styles.refreshBtn}
              disabled={isLoadingModels}
            >
              {isLoadingModels ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Model</label>
            {ollamaModels.length > 0 ? (
              <select
                value={config.localModel || ''}
                onChange={(e) => onChange({ ...config, localModel: e.target.value })}
                className={styles.select}
              >
                {ollamaModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                placeholder="Enter model name (e.g., qwen3:30b)"
                value={config.localModel || ''}
                onChange={(e) => onChange({ ...config, localModel: e.target.value })}
                className={styles.input}
              />
            )}
            {ollamaError && <span className={styles.warning}>{ollamaError}</span>}
          </div>
        </>
      )}
    </div>
  );
}
