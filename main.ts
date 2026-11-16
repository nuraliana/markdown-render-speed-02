// The program the harness runs (node /bot/main.ts, Node 22, TypeScript types
// stripped natively). It renders every case of /input/cases.json with the
// parse() of parse.js — a fast drop-in for marked 18.1.3 — and writes the
// 720 HTML strings, in the cases' order, to /output/html.json.
//
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output. The render is deterministic: the same input
// always yields the same output file, byte for byte.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases: Case[] = JSON.parse(
  readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'),
);
if (!Array.isArray(cases)) {
  throw new Error('cases.json does not hold a JSON array of cases');
}

// Each case is rendered alone: parse() keeps nothing from one call to
// the next, so a case's HTML depends only on that case's markdown.
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  // Render in the cases' order; the output array keeps that order.
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
