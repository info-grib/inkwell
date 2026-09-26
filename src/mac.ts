// The macOS look: a translucent window with a solid page card ("Zen" style).
//
// The window is made transparent and given the system's sidebar blur by the desktop shell (see
// src-tauri/tauri.macos.conf.json). This file only switches that on and off from Settings, keeps the
// window's light/dark appearance in step with the app's theme (so the blurred sidebar is never
// light-on-light), and tells the page it has the title bar overlaid so it can leave room for the
// traffic-light buttons. macOS itself turns the blur off when "Reduce transparency" is on.
//
// Everywhere else (browser, Windows, Linux) none of this does anything.

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const isMacApp = () => inTauri() && /Mac/i.test(navigator.platform || navigator.userAgent);

let lastKey = '';

/** Apply the translucent look (or remove it) and match the window's appearance to the theme. */
export async function applyWindowLook(translucent: boolean, theme: 'auto' | 'light' | 'dark'): Promise<void> {
  if (!isMacApp()) return;
  const on = translucent;
  document.documentElement.classList.toggle('translucent', on);
  document.body.classList.toggle('translucent', on);
  document.body.classList.add('overlay');
  const key = `${on}|${theme}`;
  if (key === lastKey) return;
  lastKey = key;
  try {
    const { getCurrentWindow, Effect, EffectState } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    await w.setTheme(theme === 'auto' ? null : theme);
    if (on) await w.setEffects({ effects: [Effect.Sidebar], state: EffectState.FollowsWindowActiveState });
    else await w.clearEffects();
  } catch (e) {
    // Older macOS or a missing permission: the page falls back to its solid look.
    console.warn('window effects unavailable', e);
    document.documentElement.classList.remove('translucent');
    document.body.classList.remove('translucent');
  }
}
