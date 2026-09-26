// Turns the artifact-mode build into one HTML fragment: <title>, <style>, the app's markup, <script>.
// Usage: npm run preview:page   (writes dist-artifact/inkwell-preview.html)
import { readFileSync, writeFileSync } from 'node:fs';

const css = readFileSync('dist-artifact/app.css', 'utf8');
const js = readFileSync('dist-artifact/app.js', 'utf8')
  .replace(/<\/script/gi, '<\\/script')
  .replace(/<!--/g, '<\\!--');
const html = readFileSync('index.html', 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"')).trim();

writeFileSync(
  'dist-artifact/inkwell-preview.html',
  // The charset meta is redundant when a host (like the Artifact tool) wraps this in its own <head> --
  // but if this file is ever opened directly or served by something that doesn't declare an encoding,
  // it stops the page's own inlined fonts and text from being misread as anything but UTF-8.
  `<meta charset="utf-8">\n<title>Inkwell</title>\n<style>\n${css}\n</style>\n${body}\n<script type="module">\n${js}\n</script>\n`,
);
console.log('wrote dist-artifact/inkwell-preview.html', Math.round((css.length + js.length + body.length) / 1024) + ' KB');
