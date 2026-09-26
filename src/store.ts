// localStorage can be missing or throw (private windows, sandboxed pages); never let it break the app.
export const lsGet = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};
export const lsSet = (k: string, v: string): void => {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
};
export const lsRemove = (k: string): void => {
  try { localStorage.removeItem(k); } catch { /* ignore */ }
};
