/**
 * web/scripts/check-translations.mjs
 *
 * Fails when the German dashboard would show English or broken text: text in JSX
 * that isn't passed through t(), English with no German entry, German entries
 * nothing uses, and German that drops or invents a {placeholder}.
 *
 * Run with `npm run check:translations`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { de } from '../src/locales/de.ts';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TEXT_ATTRIBUTES = new Set(['placeholder', 'aria-label', 'title', 'alt', 'label']);
// Text that reads the same in every language: addresses and commands.
const LANGUAGE_FREE = /^[\w.:/-]+\.[a-z]{2,}(\/\S*)?$|^https?:\/\//;
const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp']);

const files = fs
  .readdirSync(src, { recursive: true })
  .map(String)
  .filter(
    (file) => /\.tsx?$/.test(file) && !file.startsWith('locales') && !file.startsWith('player'),
  );

const problems = [];
const used = new Set();
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const walk = (node, visit, parents = []) => {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  for (const value of Object.values(node)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (child && typeof child === 'object') walk(child, visit, [...parents, node]);
    }
  }
};

for (const file of files) {
  const source = fs.readFileSync(path.join(src, file), 'utf8');
  const ast = parseAst(source, { lang: file.endsWith('x') ? 'tsx' : 'ts' });
  const line = (offset) => source.slice(0, offset).split('\n').length;
  const report = (node, message) => problems.push(`${file}:${line(node.start)} ${message}`);
  const inCode = (parents) =>
    parents.some(
      (parent) => parent.type === 'JSXElement' && CODE_TAGS.has(parent.openingElement.name.name),
    );

  walk(ast, (node, parents) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 't'
    ) {
      const [text] = node.arguments;
      if (text?.type !== 'Literal' || typeof text.value !== 'string') {
        report(node, 't() needs the English text written out, so it can be checked');
        return;
      }
      used.add(text.value);
      if (!(text.value in de)) report(node, `no German for "${text.value}"`);
      else if (placeholders(text.value).join() !== placeholders(de[text.value]).join()) {
        report(node, `German placeholders differ for "${text.value}"`);
      }
    }
    if (node.type === 'JSXText' && /[A-Za-z]{2,}/.test(node.value) && !inCode(parents)) {
      const text = node.value.trim();
      if (!LANGUAGE_FREE.test(text)) report(node, `text outside t(): "${text.slice(0, 60)}"`);
    }
    if (
      node.type === 'JSXAttribute' &&
      TEXT_ATTRIBUTES.has(node.name.name) &&
      node.value?.type === 'Literal' &&
      /[A-Za-z]{2,}/.test(String(node.value.value)) &&
      !LANGUAGE_FREE.test(String(node.value.value))
    ) {
      report(node, `${node.name.name} outside t(): "${node.value.value}"`);
    }
  });
}

for (const key of Object.keys(de)) {
  if (!used.has(key)) problems.push(`locales/de.ts: "${key}" is not used`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} translation problem(s).`);
  process.exit(1);
}
console.log(`German covers all ${used.size} texts.`);
