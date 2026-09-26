// In-app spell-check: Hunspell dictionaries (English, Russian, Ukrainian) run entirely offline through
// nspell, a pure-JavaScript Hunspell-compatible checker. No native OS spell-check is used, so the red
// underlines look and work the same on every platform (the Mac app's window engine draws none of its own).
//
// A dictionary is only fetched the first time its language is actually needed, and then kept in memory
// for the rest of the session. Words the author adds ("Add to dictionary") are remembered per language in
// this browser/app (localStorage) and folded back in every time that dictionary loads.

import nspell from 'nspell';
import { lsGet, lsSet } from './store';
import type { SpellSetting } from './project';

export type { SpellSetting };
export type SpellLang = Exclude<SpellSetting, 'off'>;

type Speller = ReturnType<typeof nspell>;

const NAMES: Record<SpellLang, string> = { en: 'English', ru: 'Russian', uk: 'Ukrainian' };
export const spellLangName = (lang: SpellLang): string => NAMES[lang];

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url}: ${res.status}`);
  return res.text();
}

// The dictionary-* packages keep their .aff/.dic files private (package.json "exports" only allows
// importing index.js, which itself reads them with Node's fs — no use in a browser/Tauri webview), so
// `npm install` copies the two files each one ships into public/dictionaries/ (see scripts/copy-
// dictionaries.mjs); those are plain static files, fetched from here lazily, not bundled into any chunk.
const dictUrl = (lang: SpellLang, ext: 'aff' | 'dic') => `${import.meta.env.BASE_URL}dictionaries/${lang}.${ext}`;

const personalKey = (lang: SpellLang) => `inkwell.dict.${lang}`;
function loadPersonal(lang: SpellLang): string[] {
  try {
    const raw = lsGet(personalKey(lang));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

const spellers = new Map<SpellLang, Promise<Speller>>();
function loadSpeller(lang: SpellLang): Promise<Speller> {
  let p = spellers.get(lang);
  if (!p) {
    p = (async () => {
      const [aff, dic] = await Promise.all([fetchText(dictUrl(lang, 'aff')), fetchText(dictUrl(lang, 'dic'))]);
      const sp = nspell(aff, dic);
      for (const w of loadPersonal(lang)) sp.add(w);
      return sp;
    })();
    spellers.set(lang, p);
  }
  return p;
}

/** Every word in the list that isn't in the dictionary (case handled the way Hunspell handles it). */
export async function misspelled(lang: SpellLang, words: string[]): Promise<Set<string>> {
  const sp = await loadSpeller(lang);
  const bad = new Set<string>();
  for (const w of words) if (!sp.correct(w)) bad.add(w);
  return bad;
}

/** Suggested replacements for one word, best guess first. */
export async function suggest(lang: SpellLang, word: string): Promise<string[]> {
  const sp = await loadSpeller(lang);
  return sp.suggest(word);
}

/** Remember this word (this language, this browser/app) so it stops being flagged. */
export async function addToDictionary(lang: SpellLang, word: string): Promise<void> {
  const list = loadPersonal(lang);
  if (!list.includes(word)) {
    list.push(word);
    try { lsSet(personalKey(lang), JSON.stringify(list)); } catch { /* ignore */ }
  }
  (await loadSpeller(lang)).add(word);
}
