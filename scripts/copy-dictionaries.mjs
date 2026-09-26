// Copies the Hunspell dictionary files (English, Russian, Ukrainian) into public/dictionaries/, where
// src/spell.ts fetches them at runtime. The dictionary-* packages keep their .aff/.dic files private
// (their package.json "exports" only allows importing index.js, which itself uses Node's fs — not
// available in the browser/Tauri webview), so this copies the two files each package actually ships
// instead of trying to import them. Runs automatically after `npm install` (see package.json).
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public', 'dictionaries');

const langs = [
  ['en', 'dictionary-en'],
  ['ru', 'dictionary-ru'],
  ['uk', 'dictionary-uk'],
];

await mkdir(outDir, { recursive: true });
for (const [lang, pkg] of langs) {
  const pkgDir = join(root, 'node_modules', pkg);
  try {
    await copyFile(join(pkgDir, 'index.aff'), join(outDir, `${lang}.aff`));
    await copyFile(join(pkgDir, 'index.dic'), join(outDir, `${lang}.dic`));
    console.log(`spell-check: copied ${pkg} -> public/dictionaries/${lang}.{aff,dic}`);
  } catch (e) {
    // Not fatal: the app still runs, spell-check for this language just fails to load until `npm install` succeeds.
    console.warn(`spell-check: could not copy ${pkg} (${e.message}). Run "npm install" if this package is missing.`);
  }
}
