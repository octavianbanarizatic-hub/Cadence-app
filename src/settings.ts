/** Small typed wrapper around localStorage that never throws. */
export const settings = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`cadence.${key}`);
      return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`cadence.${key}`, JSON.stringify(value));
    } catch {
      /* storage full or unavailable */
    }
  },
  /** Every setting as one JSON object, for backups. */
  exportAll(): string {
    const all: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith("cadence.")) all[key] = localStorage.getItem(key) ?? "";
      }
    } catch {
      /* storage unavailable: back up the rest */
    }
    return JSON.stringify(all);
  },
  /** Replaces every setting with those from `exportAll`. */
  importAll(json: string) {
    try {
      const all = JSON.parse(json) as Record<string, string>;
      for (const key of Object.keys(localStorage)) if (key.startsWith("cadence.")) localStorage.removeItem(key);
      for (const [key, value] of Object.entries(all)) if (key.startsWith("cadence.")) localStorage.setItem(key, value);
    } catch {
      /* a backup without readable settings keeps the current ones */
    }
  },
};
