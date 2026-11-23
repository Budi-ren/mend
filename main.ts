// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type FileLines = { lines: string[]; br: string; final: boolean };
type HunkLine = { kind: ' ' | '+' | '-'; text: string };
type UnifiedHunk = { start: number; body: HunkLine[]; noFinalBreak: boolean };
type UnifiedSection = {
  diffOld: string | null;
  diffNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  paired: boolean;
  renameOld: string | null;
  renameNew: string | null;
  create: boolean;
  delete: boolean;
  hunks: UnifiedHunk[];
};

function splitFile(text: string): FileLines {
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

function sameAt(file: string[], old: string[], at: number, tier: number): boolean {
  if (at < 0 || at + old.length > file.length) return false;
  const norm = (s: string): string => tier === 1 ? s.replace(/[ \t]+$/, '') : tier === 2 ? s.replace(/^[ \t]+|[ \t]+$/g, '') : s;
  for (let i = 0; i < old.length; i += 1) {
    if (norm(file[at + i]!) !== norm(old[i]!)) return false;
  }
  return true;
}

function occurrences(file: string[], old: string[], strict: boolean, from = 0, to = file.length, endOnly = false): { tier: number; at: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const at: number[] = [];
    for (let i = Math.max(0, from); i <= Math.min(to, file.length - old.length); i += 1) {
      if ((!endOnly || i + old.length === file.length) && sameAt(file, old, i, tier)) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

function writeReplacement(file: string[], old: string[], fresh: string[], at: number, tier: number, contextOld: (number | null)[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < fresh.length; i += 1) {
    if (contextOld[i] !== null) {
      out.push(file[at + contextOld[i]!]!);
    } else {
      let line = fresh[i]!;
      if (tier === 2 && old.length > 0) {
        const p = old[0]!.match(/^[ \t]*/)?.[0] ?? '';
        const f = file[at]!.match(/^[ \t]*/)?.[0] ?? '';
        if (line !== '' && !/^[ \t]*$/.test(line) && line.startsWith(p)) line = f + line.slice(p.length);
      }
      out.push(line);
    }
  }
  return [...file.slice(0, at), ...out, ...file.slice(at + old.length)];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  const pathValue = (s: string): string => {
    const p = s.slice(4).split('\t', 1)[0]!.trim();
    return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
  };
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let current: UnifiedSection | null = null;
  const begin = (a: string | null, b: string | null): UnifiedSection => {
    const s: UnifiedSection = { diffOld: a, diffNew: b, oldPath: null, newPath: null, paired: false, renameOld: null, renameNew: null, create: false, delete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      current = begin(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (current === null || current.paired || current.hunks.length > 0) current = begin(null, null);
      current.oldPath = pathValue(line);
      current.newPath = pathValue(lines[i + 1]!);
      current.paired = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body: HunkLine[] = [];
      let noFinalBreak = false;
      let previousKind: ' ' | '+' | '-' | null = null;
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || pairAt(i)) break;
        if (b.startsWith('@@')) break;
        if (b === '\\ No newline at end of file') {
          if (previousKind === ' ' || previousKind === '+') noFinalBreak = true;
          i += 1;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('+') || b.startsWith('-')) {
          previousKind = b === '' ? ' ' : b[0] as ' ' | '+' | '-';
          body.push({ kind: previousKind, text: b === '' ? '' : b.slice(1) });
          if (previousKind === ' ' || previousKind === '+') noFinalBreak = false;
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      current.hunks.push({ start: Number(m[1]), body, noFinalBreak });
      continue;
    }
    if (current !== null && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (current !== null) {
      if (line.startsWith('rename from ')) current.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) current.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode ')) current.create = true;
      else if (line.startsWith('deleted file mode ')) current.delete = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    let old = s.paired ? s.oldPath : s.renameOld ?? s.diffOld;
    let next = s.paired ? s.newPath : s.renameNew ?? s.diffNew;
    if (old === null || next === null) throw new Exit2('error: parse 1');
    const isCreate = old === '/dev/null' || s.create;
    const isDelete = next === '/dev/null' || s.delete;
    const op = old;
    const np = next;
    return (tree: Tree): void => {
      for (const p of [isCreate ? null : op, isDelete ? null : np]) {
        if (p !== null && !safe(p)) throw new Fail('unsafe', p);
      }
      if (isCreate) {
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const added: string[] = [];
        let noFinal = false;
        for (const h of s.hunks) {
          for (const row of h.body) {
            if (row.kind === '+') {
              added.push(row.text);
              noFinal = false;
            }
          }
          if (h.noFinalBreak) noFinal = true;
        }
        tree.now.set(np, added.length === 0 ? '' : added.join('\n') + (noFinal ? '' : '\n'));
        return;
      }
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (isDelete) {
        tree.now.set(op, null);
        return;
      }
      const moving = op !== np;
      if (moving && tree.get(np) !== null) throw new Fail('exists', np);
      const source = splitFile(tree.get(op)!);
      let d = 0;
      for (const h of s.hunks) {
        const oldLines: string[] = [];
        const newLines: string[] = [];
        const contextOld: (number | null)[] = [];
        for (const row of h.body) {
          if (row.kind === ' ') {
            contextOld.push(oldLines.length);
            oldLines.push(row.text);
            newLines.push(row.text);
          } else if (row.kind === '-') oldLines.push(row.text);
          else {
            contextOld.push(null);
            newLines.push(row.text);
          }
        }
        const insertion = Math.min(source.lines.length, Math.max(0, h.start + d));
        let at: number;
        let tier = 0;
        if (oldLines.length === 0) at = insertion;
        else {
          const found = occurrences(source.lines, oldLines, strict);
          if (found === null) throw new Fail('no-match', op);
          tier = found.tier;
          const target = h.start - 1 + d;
          at = found.at.reduce((best, x) => Math.abs(x - target) < Math.abs(best - target) || (Math.abs(x - target) === Math.abs(best - target) && x < best) ? x : best);
        }
        const oldEnd = at + oldLines.length;
        source.lines = writeReplacement(source.lines, oldLines, newLines, at, tier, contextOld);
        d += newLines.length - oldLines.length;
        if (oldEnd === source.lines.length - (newLines.length - oldLines.length) || (oldLines.length === 0 && at === source.lines.length - newLines.length)) {
          source.final = !h.noFinalBreak;
        }
      }
      const result = joinFile(source);
      if (moving) {
        tree.now.set(op, null);
        tree.now.set(np, result);
        tree.moves.push({ old: op, next: np });
      } else tree.now.set(op, result);
    };
  });
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | null = null;
  let previousEnd = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let divider = i + 1;
    while (divider < lines.length && lines[divider]!.trimEnd() !== '=======') divider += 1;
    let end = divider + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (divider >= lines.length || end >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let k = i - 1; k > previousEnd; k -= 1) {
      const candidate = lines[k]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) {
        path = candidate;
        break;
      }
    }
    path ??= previousPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, divider);
    const newLines = lines.slice(divider + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const file = splitFile(text);
      const found = occurrences(file.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      file.lines = writeReplacement(file.lines, oldLines, newLines, found.at[0]!, found.tier, newLines.map(() => null));
      tree.now.set(p, joinFile(file));
    });
    previousPath = p;
    previousEnd = end;
    i = end;
  }
  return edits;
}

type V4AChunk = { anchor: string | null; eof: boolean; body: { kind: ' ' | '+' | '-'; text: string }[] };
type V4ASection = { kind: 'add' | 'delete' | 'update'; path: string; move: string | null; lines: string[]; chunks: V4AChunk[]; line: number };

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const endMarker = last;
  const sections: V4ASection[] = [];
  const sectionHeader = (s: string): 'add' | 'delete' | 'update' | null =>
    s.startsWith('*** Add File: ') ? 'add' : s.startsWith('*** Delete File: ') ? 'delete' : s.startsWith('*** Update File: ') ? 'update' : null;
  let i = first + 1;
  while (i < endMarker) {
    if (blank(lines[i]!)) { i += 1; continue; }
    const kind = sectionHeader(lines[i]!);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const line = i + 1;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = lines[i]!.slice(prefix.length).trim();
    i += 1;
    const start = i;
    while (i < endMarker && sectionHeader(lines[i]!) === null) i += 1;
    let contentEnd = i;
    while (contentEnd > start && blank(lines[contentEnd - 1]!)) contentEnd -= 1;
    const content = lines.slice(start, contentEnd);
    const s: V4ASection = { kind, path, move: null, lines: [], chunks: [], line };
    if (kind === 'add') {
      for (let j = 0; j < content.length; j += 1) {
        const v = content[j]!;
        if (v !== '' && !v.startsWith('+')) throw new Exit2(`error: parse ${start + j + 1}`);
        s.lines.push(v === '' ? '' : v.slice(1));
      }
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${start + 1}`);
    } else {
      let j = 0;
      if (content[j]?.startsWith('*** Move to: ')) {
        s.move = content[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      let chunk: V4AChunk | null = null;
      for (; j < content.length; j += 1) {
        const v = content[j]!;
        if (v === '*** End of File') {
          if (chunk === null) chunk = { anchor: null, eof: true, body: [] };
          else chunk.eof = true;
          s.chunks.push(chunk);
          chunk = null;
        } else if (v.startsWith('@@')) {
          if (chunk !== null) s.chunks.push(chunk);
          chunk = { anchor: v.slice(2).trim() || null, eof: false, body: [] };
        } else if (v === '' || v.startsWith(' ') || v.startsWith('+') || v.startsWith('-')) {
          if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
          chunk.body.push({ kind: v === '' ? ' ' : v[0] as ' ' | '+' | '-', text: v === '' ? '' : v.slice(1) });
        } else throw new Exit2(`error: parse ${start + j + 1}`);
      }
      if (chunk !== null) s.chunks.push(chunk);
      if (s.chunks.length === 0 && s.move === null) throw new Exit2(`error: parse ${line}`);
    }
    sections.push(s);
    if (i < endMarker && sectionHeader(lines[i]!) === null) throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.move !== null && !safe(s.move)) throw new Fail('unsafe', s.move);
    const text = tree.get(s.path);
    if (text === null) throw new Fail('missing', s.path);
    if (s.kind === 'delete') {
      tree.now.set(s.path, null);
      return;
    }
    if (s.move !== null && tree.get(s.move) !== null) throw new Fail('exists', s.move);
    const file = splitFile(text);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const anchorFound = occurrences(file.lines, [chunk.anchor], strict, cursor);
        if (anchorFound === null) throw new Fail('no-match', s.path);
        cursor = anchorFound.at[0]! + 1;
      }
      const oldLines: string[] = [];
      const newLines: string[] = [];
      const contextOld: (number | null)[] = [];
      for (const row of chunk.body) {
        if (row.kind === ' ') {
          contextOld.push(oldLines.length);
          oldLines.push(row.text);
          newLines.push(row.text);
        } else if (row.kind === '-') oldLines.push(row.text);
        else {
          contextOld.push(null);
          newLines.push(row.text);
        }
      }
      let at: number;
      let tier = 0;
      if (oldLines.length === 0) at = chunk.eof ? file.lines.length : Math.min(cursor, file.lines.length);
      else {
        const found = occurrences(file.lines, oldLines, strict, cursor, file.lines.length, chunk.eof);
        if (found === null) throw new Fail('no-match', s.path);
        at = found.at[0]!;
        tier = found.tier;
      }
      file.lines = writeReplacement(file.lines, oldLines, newLines, at, tier, contextOld);
      cursor = at + newLines.length;
    }
    const result = joinFile(file);
    if (s.move !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.move, result);
      tree.moves.push({ old: s.path, next: s.move });
    } else tree.now.set(s.path, result);
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
        : kind === 'search-replace' ? parseSearchReplace(lines, strict)
          : kind === 'v4a' ? parseV4A(lines, strict)
            : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.next) === null && tree.get(m.next) !== null) {
      movedOld.add(m.old);
      movedNew.add(m.next);
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
