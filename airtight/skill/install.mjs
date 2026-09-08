#!/usr/bin/env node
// Places the AIRTIGHT skill where an agent runtime will actually find it.
//
// This is a separate, explicit command rather than a postinstall hook on
// purpose: a dependency that writes into your .claude directory the moment you
// npm install it is doing something you did not ask for. One command, run by
// you, that says what it wrote.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const args   = new Set(process.argv.slice(2));
const global = args.has('--global') || args.has('-g');
const root   = global ? homedir() : process.cwd();
const dest   = join(root, '.claude', 'skills', 'airtight', 'SKILL.md');

const src  = join(import.meta.dirname, 'SKILL.md');
const body = await readFile(src, 'utf8');

let before = null;
try { before = await readFile(dest, 'utf8'); } catch { /* first install */ }

if (before === body) {
  console.log(`AIRTIGHT skill already current at ${dest}`);
} else {
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, body);
  console.log(`AIRTIGHT skill ${before === null ? 'installed' : 'updated'} at ${dest}`);
}
console.log(global
  ? '  Available in every project on this machine.'
  : '  Available in this project. Re-run with --global for every project.');
