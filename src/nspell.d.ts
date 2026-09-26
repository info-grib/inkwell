// nspell ships no TypeScript types; this covers the small part of its API Inkwell uses.
declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    spell(word: string): boolean;
    add(word: string, model?: string): NSpell;
    remove(word: string): NSpell;
  }
  export default function nspell(aff: string | Uint8Array, dic?: string | Uint8Array): NSpell;
}
