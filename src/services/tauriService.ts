// Check if we're running in Tauri
export const isTauri = (): boolean => {
  return '__TAURI__' in window;
};
