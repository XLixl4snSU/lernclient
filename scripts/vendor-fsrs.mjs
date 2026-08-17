import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(root, 'node_modules', 'ts-fsrs');
const targetRoot = resolve(root, 'js', 'vendor');

await mkdir(targetRoot, {recursive: true});

const moduleSource = await readFile(resolve(sourceRoot, 'dist', 'index.mjs'), 'utf8');
const withoutSourceMapReference = moduleSource.replace(/\r?\n\/\/# sourceMappingURL=.*\s*$/, '\n');
await writeFile(resolve(targetRoot, 'ts-fsrs.mjs'), withoutSourceMapReference, 'utf8');

const license = await readFile(resolve(sourceRoot, 'LICENSE'), 'utf8');
await writeFile(resolve(targetRoot, 'ts-fsrs.LICENSE.txt'), license, 'utf8');

console.log('FSRS-Browsermodul und Lizenz wurden aktualisiert.');
