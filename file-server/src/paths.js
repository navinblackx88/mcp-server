// Turns any user-supplied path (absolute, relative, or ~/...) into a real path,
// and refuses anything outside the allowed roots (including via ../ or symlinks).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, expandHome } from './config.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

let realRoots;
async function getRealRoots() {
  if (!realRoots) {
    realRoots = [];
    for (const r of config.roots) {
      try { realRoots.push(await fs.realpath(r)); } catch { /* missing root: ignore */ }
    }
  }
  return realRoots;
}

export function isAllowed(realPath, roots) {
  return config.allowAll || roots.some((r) => isInside(realPath, r));
}

/** @param {'file'|'dir'} kind */
export async function resolvePath(input, kind = 'file') {
  if (input === undefined || input === null || String(input).trim() === '') {
    if (kind === 'dir') input = config.defaultDir;
    else throw new HttpError(400, 'Query parameter "path" is required');
  }
  const abs = path.resolve(config.defaultDir, expandHome(String(input).trim()));
  let real, stat;
  try {
    real = await fs.realpath(abs);
    stat = await fs.stat(real);
  } catch {
    throw new HttpError(404, `${kind === 'dir' ? 'Directory' : 'File'} not found: ${input}`);
  }
  if (!isAllowed(real, await getRealRoots())) {
    throw new HttpError(403, `Access denied: ${input} is outside the allowed folders. Add its folder to ALLOWED_ROOTS.`);
  }
  if (kind === 'file' && !stat.isFile()) throw new HttpError(400, `Not a file: ${input}`);
  if (kind === 'dir' && !stat.isDirectory()) throw new HttpError(400, `Not a directory: ${input}`);
  return { abs: real, stat };
}

export async function getRoots() {
  return { allowAll: config.allowAll, roots: await getRealRoots(), defaultDir: config.defaultDir };
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', '.cache', 'Library', 'AppData']);

/** Walk a directory. Yields { path, name, isDir, stat }. */
export async function* walk(dir, { recursive = false, depth = 0 } = {}) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield { path: full, name: e.name, isDir: true };
      if (recursive && depth < config.maxDepth && !SKIP_DIRS.has(e.name)) {
        yield* walk(full, { recursive, depth: depth + 1 });
      }
    } else if (e.isFile()) {
      let stat;
      try { stat = await fs.stat(full); } catch { continue; }
      yield { path: full, name: e.name, isDir: false, stat };
    }
  }
}
