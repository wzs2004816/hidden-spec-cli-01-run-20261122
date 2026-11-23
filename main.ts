// mend — one patch tool for every AI edit format. Node 22, standard library only.
//
//   node main.ts [--format=<name>] [--check] [--strict] [--] [PATCH]
//
// It reads a patch (a file, or standard input when PATCH is omitted or "-"),
// applies it to the tree of text files in the working directory, and reports
// what changed. The patch is one of four formats: unified diff, SEARCH/REPLACE
// blocks, V4A (*** Begin Patch), or JSON edits. Each edit finds the lines it
// names at the first of three matching tiers (exact; ignore trailing
// whitespace; ignore leading and trailing whitespace), and writes every change
// or none: a failed edit changes nothing, later edits still run, and when any
// edit fails no file is written at all.
//
// When MAKEFUN_ENV_URL is set, main.ts hands over to runner.ts (the trial
// runner) instead of running as the CLI; see the hand-over at the end.

import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- helpers

const isBlank = (s: string): boolean => s.trim() === '';
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const noTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const noBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const rstripPatch = (s: string): string => s.replace(/[ \t]+$/, '');

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** One file of the tree: its lines, its line break, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: '\n' | '\r\n';
  endsWithBreak: boolean;
}

function splitFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const firstNl = text.indexOf('\n');
  const br: '\n' | '\r\n' = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const endsWithBreak = parts[parts.length - 1] === '';
  if (endsWithBreak) parts.pop();
  return { lines: parts, br, endsWithBreak };
}

function joinFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.endsWithBreak ? doc.br : '');
}

/** A file's lines spliced, keeping its line break; the final break is rewritten only when touchEnd. */
function spliceDoc(doc: FileDoc, pos: number, take: number, insert: string[], touchEnd: boolean, noFinalBreak: boolean): FileDoc {
  const lines = [...doc.lines];
  lines.splice(pos, take, ...insert);
  return { lines, br: doc.br, endsWithBreak: touchEnd ? !noFinalBreak : doc.endsWithBreak };
}

// ---------------------------------------------------------------- errors

/** A per-edit failure: `error: <code> <path>`. */
class Fail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

/** A parse failure: `error: parse <line>`. */
class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ---------------------------------------------------------------- the tree

/** The tree before the patch (orig) and as edits leave it (now; null is deleted). */
class Tree {
  orig = new Map<string, string>();
  now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  read(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p) ?? null;
    let text: string | null = null;
    try {
      text = readFileSync(join(process.cwd(), ...p.split('/')), 'utf8');
    } catch {
      text = null;
    }
    this.now.set(p, text);
    if (text !== null) this.orig.set(p, text);
    return text;
  }

  write(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

/** A path is unsafe when empty, absolute, or escaping the working directory by `..`. */
function checkSafe(p: string): void {
  if (p === '' || p.startsWith('/') || p.split('/').includes('..')) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------- matching

/** The three tiers: exact; ignore trailing spaces and tabs; ignore both ends. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return noTrail(s);
  return noBoth(s);
}

/** Every position where O occurs in lines at this tier, at or after `from`. */
function occurrences(o: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(o[j], tier) !== normLine(lines[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function firstTierWith(o: string[], lines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(o, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// ---------------------------------------------------------------- N lines

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function ctxLine(text: string, oIdx: number): NLine {
  return { text, ctx: true, oIdx };
}
function newLine(text: string): NLine {
  return { text, ctx: false, oIdx: -1 };
}

/**
 * Build N at a match: context lines are the file's own matched lines; at tier 2
 * every other line that is not empty, not only whitespace, and starts with P (the
 * leading whitespace of O's first line) has that P replaced by F (the leading
 * whitespace of the file's first matched line); all other lines are written as they are.
 */
function buildNew(nItems: NLine[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[pos]);
    p = leadWs(o[0]);
  }
  const out: string[] = [];
  for (const it of nItems) {
    if (it.ctx) out.push(fileLines[pos + it.oIdx]);
    else if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(p)) out.push(f + it.text.slice(p.length));
    else out.push(it.text);
  }
  return out;
}

// ---------------------------------------------------------------- edits

type Edit = (tree: Tree, strict: boolean) => void;

// ---------------------------------------------------------------- unified

type HunkItem = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

interface Hunk {
  a: number;
  items: HunkItem[];
  o: string[];
  nItems: NLine[];
}

function parseHunk(lines: string[], start: number, a: number): { hunk: Hunk; end: number } {
  const items: HunkItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
    if (line.startsWith(' ')) {
      items.push({ kind: 'ctx', text: line.slice(1) });
      i++;
    } else if (line.startsWith('-')) {
      items.push({ kind: 'old', text: line.slice(1) });
      i++;
    } else if (line.startsWith('+')) {
      items.push({ kind: 'new', text: line.slice(1) });
      i++;
    } else if (line.startsWith('\\')) {
      items.push({ kind: 'bs', text: line.slice(1) });
      i++;
    } else if (line === '') {
      items.push({ kind: 'ctx', text: '' });
      i++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (items.length > 0) {
    const lastItem = items[items.length - 1];
    if (lastItem.kind === 'ctx' && lastItem.text === '') items.pop();
    else break;
  }
  const o: string[] = [];
  const nItems: NLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push(it.text);
      nItems.push(ctxLine(it.text, idx));
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      nItems.push(newLine(it.text));
    }
  }
  return { hunk: { a, items, o, nItems }, end: i };
}

/** Is a `\` line immediately after the hunk's last context or `+` line? */
function hunkNoFinalBreak(h: Hunk): boolean {
  let lastCtxNew = -1;
  for (let i = 0; i < h.items.length; i++) {
    if (h.items[i].kind === 'ctx' || h.items[i].kind === 'new') lastCtxNew = i;
  }
  if (lastCtxNew < 0) return false;
  return lastCtxNew + 1 < h.items.length && h.items[lastCtxNew + 1].kind === 'bs';
}

interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function headerPath(rest: string): string {
  return rest.split('\t')[0].trim();
}
function stripAb(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: UnifiedSection | null = null;
  const finishSection = (): void => {
    if (sec !== null) edits.push(buildUnifiedEdit(sec));
    sec = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      finishSection();
      sec = { pairOld: null, pairNew: null, renameOld: null, renameNew: null, diffOld: m[1], diffNew: m[2], creation: false, deletion: false, hunks: [] };
      i++;
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const oldP = stripAb(headerPath(line.slice(4)));
      const newP = stripAb(headerPath(lines[i + 1].slice(4)));
      if (sec !== null && sec.hunks.length === 0) {
        // The pair is this section's header.
        sec.pairOld = oldP;
        sec.pairNew = newP;
      } else {
        finishSection();
        sec = { pairOld: oldP, pairNew: newP, renameOld: null, renameNew: null, diffOld: null, diffNew: null, creation: false, deletion: false, hunks: [] };
      }
      i += 2;
    } else if (line.startsWith('--- ') && sec !== null && sec.hunks.length === 0) {
      // A `--- ` line in a header not followed by a `+++ ` line.
      throw new ParseErr(i + 2);
    } else if (line.startsWith('@@')) {
      if (sec === null) throw new ParseErr(i + 1);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new ParseErr(i + 1);
      const { hunk, end } = parseHunk(lines, i + 1, Number(hm[1]));
      sec.hunks.push(hunk);
      i = end;
    } else if (sec !== null && sec.hunks.length === 0) {
      // A header line.
      if (line.startsWith('+++ ')) sec.pairNew = stripAb(headerPath(line.slice(4)));
      else if (line.startsWith('rename from ')) sec.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.creation = true;
      else if (line.startsWith('deleted file mode')) sec.deletion = true;
      // Every other header line is ignored.
      i++;
    } else {
      // Outside a section, or after its hunks: ignored unless it starts a section.
      i++;
    }
  }
  finishSection();
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function applyUnifiedHunks(doc: FileDoc, hunks: Hunk[], path: string, strict: boolean): FileDoc {
  let d = 0;
  let cur = doc;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(h.a + d, cur.lines.length);
      const built = buildNew(h.nItems, h.o, cur.lines, pos, 0);
      cur = spliceDoc(cur, pos, 0, built, pos === cur.lines.length, hunkNoFinalBreak(h));
      d += built.length;
    } else {
      const found = firstTierWith(h.o, cur.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const built = buildNew(h.nItems, h.o, cur.lines, best, found.tier);
      cur = spliceDoc(cur, best, h.o.length, built, best + h.o.length === cur.lines.length, hunkNoFinalBreak(h));
      d += built.length - h.o.length;
    }
  }
  return cur;
}

function buildUnifiedEdit(sec: UnifiedSection): Edit {
  const oldPath = sec.pairOld ?? sec.renameOld ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.renameNew ?? sec.diffNew;
  return (tree, strict) => {
    if (sec.creation || oldPath === null) {
      const target = newPath ?? '/dev/null';
      checkSafe(target);
      if (tree.read(target) !== null) throw new Fail('exists', target);
      const made: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') made.push(it.text);
        }
      }
      // A created file ends with a line break unless a `\` line follows its last `+` line.
      let noBreak = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi];
        for (let k = h.items.length - 1; k >= 0; k--) {
          if (h.items[k].kind === 'new') {
            noBreak = k + 1 < h.items.length && h.items[k + 1].kind === 'bs';
            break outer;
          }
        }
      }
      const doc: FileDoc = { lines: made, br: '\n', endsWithBreak: made.length > 0 && !noBreak };
      tree.write(target, joinFile(doc));
      return;
    }
    if (sec.deletion || newPath === null) {
      const target = oldPath ?? '/dev/null';
      checkSafe(target);
      if (tree.read(target) === null) throw new Fail('missing', target);
      tree.write(target, null);
      return;
    }
    if (oldPath !== newPath) {
      checkSafe(oldPath);
      checkSafe(newPath);
      const text = tree.read(oldPath);
      if (text === null) throw new Fail('missing', oldPath);
      if (tree.read(newPath) !== null) throw new Fail('exists', newPath);
      const done = applyUnifiedHunks(splitFile(text), sec.hunks, oldPath, strict);
      tree.write(oldPath, null);
      tree.write(newPath, joinFile(done));
      tree.moves.push([oldPath, newPath]);
      return;
    }
    checkSafe(oldPath);
    const text = tree.read(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    const done = applyUnifiedHunks(splitFile(text), sec.hunks, oldPath, strict);
    tree.write(oldPath, joinFile(done));
  };
}

// ---------------------------------------------------------------- search/replace

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (rstripPatch(lines[i]) === '<<<<<<< SEARCH') {
      const s = i;
      let eq = -1;
      let rep = -1;
      for (let j = s + 1; j < lines.length; j++) {
        const t = rstripPatch(lines[j]);
        if (t === '=======') {
          if (eq < 0) eq = j;
        } else if (t === '>>>>>>> REPLACE') {
          if (rep < 0) rep = j;
        }
      }
      if (eq < 0 || rep < 0 || rep < eq) throw new ParseErr(s + 1);
      let path: string | null = null;
      for (let j = s - 1; j > lastReplaceEnd; j--) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new ParseErr(s + 1);
        path = prevPath;
      }
      prevPath = path;
      const oldLines = lines.slice(s + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(buildSearchReplaceEdit(path, oldLines, newLines));
      lastReplaceEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function buildSearchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, strict) => {
    checkSafe(path);
    if (oldLines.length === 0) {
      if (tree.read(path) !== null) throw new Fail('exists', path);
      tree.write(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const text = tree.read(path);
    if (text === null) throw new Fail('missing', path);
    const doc = splitFile(text);
    const found = firstTierWith(oldLines, doc.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0];
    const built = buildNew(newLines.map((t) => newLine(t)), oldLines, doc.lines, pos, found.tier);
    const out = [...doc.lines];
    out.splice(pos, oldLines.length, ...built);
    tree.write(path, joinFile({ lines: out, br: doc.br, endsWithBreak: doc.endsWithBreak }));
  };
}

// ---------------------------------------------------------------- v4a

const isV4aSection = (line: string): boolean =>
  line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: Array<{ kind: 'ctx' | 'old' | 'new'; text: string }>;
}

function v4aChunkParts(chunk: V4aChunk): { o: string[]; nItems: NLine[] } {
  const o: string[] = [];
  const nItems: NLine[] = [];
  for (const it of chunk.items) {
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push(it.text);
      nItems.push(ctxLine(it.text, idx));
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      nItems.push(newLine(it.text));
    }
  }
  return { o, nItems };
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    if (lines[i].startsWith('*** Add File: ')) {
      const path = lines[i].slice('*** Add File: '.length).trim();
      i++;
      const start = i;
      while (i < last && !isV4aSection(lines[i])) i++;
      const secLines = lines.slice(start, i);
      while (secLines.length > 0 && isBlank(secLines[secLines.length - 1])) secLines.pop();
      for (let k = 0; k < secLines.length; k++) {
        if (secLines[k] !== '' && !secLines[k].startsWith('+')) throw new ParseErr(start + k + 1);
      }
      const fileLines = secLines.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push((tree) => {
        checkSafe(path);
        if (tree.read(path) !== null) throw new Fail('exists', path);
        tree.write(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
    } else if (lines[i].startsWith('*** Delete File: ')) {
      const path = lines[i].slice('*** Delete File: '.length).trim();
      i++;
      const start = i;
      while (i < last && !isV4aSection(lines[i])) i++;
      for (let k = start; k < i; k++) {
        if (!isBlank(lines[k])) throw new ParseErr(k + 1);
      }
      edits.push((tree) => {
        checkSafe(path);
        if (tree.read(path) === null) throw new Fail('missing', path);
        tree.write(path, null);
      });
    } else if (lines[i].startsWith('*** Update File: ')) {
      const path = lines[i].slice('*** Update File: '.length).trim();
      const headerLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      // The section's lines, blank lines at its end not part of it.
      const start = i;
      while (i < last && !isV4aSection(lines[i])) i++;
      const secLines = lines.slice(start, i);
      while (secLines.length > 0 && isBlank(secLines[secLines.length - 1])) secLines.pop();
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (let k = 0; k < secLines.length; k++) {
        const line = secLines[k];
        if (line.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: line.slice(2).trim(), eof: false, items: [] };
        } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
          if (cur === null) cur = { anchor: null, eof: false, items: [] };
          const kind: 'ctx' | 'old' | 'new' = line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : 'new';
          cur.items.push({ kind, text: line === '' ? '' : line.slice(1) });
        } else if (line.trim() === '*** End of File') {
          if (cur !== null) {
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          }
        } else {
          throw new ParseErr(start + k + 1);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(headerLine);
      edits.push(buildV4aUpdateEdit(path, moveTo, chunks));
    } else {
      throw new ParseErr(i + 1);
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function buildV4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[]): Edit {
  return (tree, strict) => {
    checkSafe(path);
    if (moveTo !== null) checkSafe(moveTo);
    const text = tree.read(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.read(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = splitFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      const { o, nItems } = v4aChunkParts(chunk);
      if (chunk.anchor !== null) {
        const af = firstTierWith([chunk.anchor], doc.lines, strict, cursor);
        if (af === null) throw new Fail('no-match', path);
        cursor = af.pos[0] + 1;
      }
      if (o.length === 0) {
        const pos = chunk.eof ? doc.lines.length : cursor;
        const built = buildNew(nItems, o, doc.lines, pos, 0);
        const out = [...doc.lines];
        out.splice(pos, 0, ...built);
        doc = { lines: out, br: doc.br, endsWithBreak: doc.endsWithBreak };
        cursor = pos + built.length;
      } else {
        const found = firstTierWith(o, doc.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos = found.pos[0];
        if (chunk.eof) {
          const atEnd = found.pos.filter((p) => p + o.length === doc.lines.length);
          if (atEnd.length === 0) throw new Fail('no-match', path);
          pos = atEnd[0];
        }
        const built = buildNew(nItems, o, doc.lines, pos, found.tier);
        const out = [...doc.lines];
        out.splice(pos, o.length, ...built);
        doc = { lines: out, br: doc.br, endsWithBreak: doc.endsWithBreak };
        cursor = pos + built.length;
      }
    }
    if (moveTo !== null) {
      tree.write(path, null);
      tree.write(moveTo, joinFile(doc));
      tree.moves.push([path, moveTo]);
    } else {
      tree.write(path, joinFile(doc));
    }
  };
}

// ---------------------------------------------------------------- json

function jsonEdit(o: unknown): Edit | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  const path = rec.path;
  const cmd = rec.command;
  if (typeof path !== 'string' || typeof cmd !== 'string') return null;
  if (cmd === 'create') {
    const fileText = rec.file_text;
    if (typeof fileText !== 'string') return null;
    return (tree) => {
      checkSafe(path);
      if (tree.read(path) !== null) throw new Fail('exists', path);
      tree.write(path, fileText);
    };
  }
  if (cmd === 'str_replace') {
    const oldStr = rec.old_str;
    const newStr = rec.new_str;
    if (typeof oldStr !== 'string' || oldStr === '') return null;
    if (newStr !== undefined && typeof newStr !== 'string') return null;
    const repl = newStr === undefined ? '' : newStr;
    return (tree) => {
      checkSafe(path);
      const before = tree.read(path);
      if (before === null) throw new Fail('missing', path);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replace(/\r\n/g, '\n') : s);
      const hay = norm(before);
      const needle = norm(oldStr);
      const after = norm(repl);
      let count = 0;
      let firstPos = -1;
      let k = 0;
      for (;;) {
        const idx = hay.indexOf(needle, k);
        if (idx < 0) break;
        if (firstPos < 0) firstPos = idx;
        count++;
        k = idx + 1;
      }
      if (count === 0) throw new Fail('no-match', path);
      if (count > 1) throw new Fail('ambiguous', path);
      let result = hay.slice(0, firstPos) + after + hay.slice(firstPos + needle.length);
      if (crlf) result = result.replace(/\n/g, '\r\n');
      tree.write(path, result);
    };
  }
  if (cmd === 'insert') {
    const line = rec.insert_line;
    const newStr = rec.new_str;
    if (!Number.isInteger(line) || typeof newStr !== 'string') return null;
    return (tree) => {
      checkSafe(path);
      const before = tree.read(path);
      if (before === null) throw new Fail('missing', path);
      const doc = splitFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', path);
      let ins: string[] = [];
      if (newStr !== '') {
        ins = newStr.split('\n').map((s) => (s.endsWith('\r') ? s.slice(0, -1) : s));
        if (ins[ins.length - 1] === '') ins.pop();
      }
      const out = [...doc.lines];
      out.splice(line, 0, ...ins);
      tree.write(path, joinFile({ lines: out, br: doc.br, endsWithBreak: doc.endsWithBreak }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseErr(first + 1);
    for (const o of arr) {
      const e = jsonEdit(o);
      if (e === null) throw new ParseErr(first + 1);
      edits.push(e);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (isBlank(lines[i])) continue;
      let o: unknown;
      try {
        o = JSON.parse(lines[i]);
      } catch {
        throw new ParseErr(i + 1);
      }
      const e = jsonEdit(o);
      if (e === null) throw new ParseErr(i + 1);
      edits.push(e);
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------------------------------------------------------------- detection

function detect(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first].trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  for (const l of lines) {
    if (rstripPatch(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- output

function outputRows(tree: Tree): string[] {
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [old, nw] of tree.moves) {
    const beforeOld = tree.orig.has(old) ? tree.orig.get(old)! : null;
    const afterOld = tree.now.has(old) ? tree.now.get(old)! : null;
    const beforeNew = tree.orig.has(nw) ? tree.orig.get(nw)! : null;
    const afterNew = tree.now.has(nw) ? tree.now.get(nw)! : null;
    if (beforeOld !== null && afterOld === null && beforeNew === null && afterNew !== null) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      covered.add(old);
      covered.add(nw);
    }
  }
  for (const [p, after] of tree.now) {
    if (covered.has(p)) continue;
    const before = tree.orig.has(p) ? tree.orig.get(p)! : null;
    if (before === after) continue;
    if (before === null) rows.push({ key: p, line: `A ${p}` });
    else if (after === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  return rows.map((r) => r.line);
}

// ---------------------------------------------------------------- the run

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

interface RunResult {
  code: number;
  out: string[];
}

function run(argv: string[]): RunResult {
  const usage = (): RunResult => ({ code: 2, out: ['error: usage'] });
  let format: string | null = null;
  let check = false;
  let strict = false;
  let file: string | null = null;
  let seenDashDash = false;
  for (const a of argv) {
    if (!seenDashDash && a === '--') {
      seenDashDash = true;
      continue;
    }
    if (!seenDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage();
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usage();
        format = v;
      } else if (a === '--check') {
        if (check) return usage();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage();
        strict = true;
      } else {
        return usage();
      }
    } else {
      if (file !== null) return usage();
      file = a;
    }
  }
  let text = '';
  if (file !== null && file !== '-') {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  } else {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  }
  const lines = patchLines(text);
  const fmt = format === null || format === 'auto' ? detect(lines) : format;
  if (fmt === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(text, lines);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (e instanceof Fail) {
        tree.now = snapshot;
        tree.moves.length = movesLen;
        fails.push(e);
      } else throw e;
    }
  }
  if (fails.length > 0) {
    const out = fails.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${fails.length} of ${edits.length} edits`);
    return { code: 1, out };
  }
  const rows = outputRows(tree);
  if (!check) {
    for (const [p, v] of tree.now) {
      const before = tree.orig.has(p) ? tree.orig.get(p)! : null;
      if (v === before) continue;
      const f = join(process.cwd(), ...p.split('/'));
      if (v === null) {
        try {
          rmSync(f, { force: true });
        } catch {
          // A file that was already gone is still gone.
        }
      } else {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, v);
      }
    }
  }
  const out = [...rows, `ok: ${rows.length} file${rows.length === 1 ? '' : 's'}`];
  return { code: 0, out };
}

// ---------------------------------------------------------------- hand-over

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
