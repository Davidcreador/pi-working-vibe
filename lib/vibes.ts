/**
 * Vibe file loader. A vibe is a plain text file in ~/.pi/agent/vibes/.
 *
 * Format:
 *   - One message per line.
 *   - Blank lines and `#` comments ignored.
 *   - Optional `[section]` headers split lines into named pools.
 *     - `[default]`  — fallback pool (also implied when no header has been
 *                      seen yet).
 *     - `[tool:bash]`, `[tool:read]`, `[tool:<name>]` — used when the agent
 *                      is calling that tool. Falls back to `default` if the
 *                      section is missing.
 *
 * Backward compatible: a flat file with no headers becomes a single
 * `default` pool.
 *
 * Files cached on first load, invalidated by mtime. Directory listing also
 * mtime-cached so autocomplete keystrokes don't readdir per press.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { USER_VIBES_DIR, isSafeVibeName } from './settings.ts';

/**
 * Bundled vibe directory shipped with the package. Located via
 * `import.meta.url` so it works regardless of where pi installs the
 * package (npm global, project .pi/npm/, git clone, local path).
 *
 * Resolution order at runtime: user dir wins, bundled fills the gaps.
 * Users can override a bundled vibe by creating a file with the same
 * name in `~/.pi/agent/vibes/`.
 */
const BUNDLED_VIBES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vibes');

const SEARCH_DIRS: readonly string[] = [USER_VIBES_DIR, BUNDLED_VIBES_DIR];

const MAX_VIBE_BYTES = 256 * 1024; // 256 KB cap — protects against runaway files

export const DEFAULT_POOL = 'default';

export interface VibePools {
  /** Map of pool name → message lines. Always contains 'default' (possibly empty). */
  pools: Map<string, string[]>;
}

interface CachedVibe {
  mtimeMs: number;
  data: VibePools;
}

interface CachedListing {
  mtimeMs: number;
  names: string[];
}

const vibeCache = new Map<string, CachedVibe>();
let listingCache: CachedListing | null = null;

function dirMtime(dir: string): number {
  try {
    return existsSync(dir) ? statSync(dir).mtimeMs : 0;
  } catch {
    return 0;
  }
}

function readDirSafe(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function listVibes(): string[] {
  // Combined mtime fingerprint across all search dirs so the cache
  // invalidates when either user or bundled dir changes.
  const fingerprint = SEARCH_DIRS.map(dirMtime).join(':');
  const fpAsNum = fingerprint
    .split(':')
    .reduce((acc, v) => acc + Number(v || 0), 0);
  if (listingCache && listingCache.mtimeMs === fpAsNum) return listingCache.names;

  const seen = new Set<string>();
  for (const dir of SEARCH_DIRS) {
    for (const f of readDirSafe(dir)) {
      if (!f.endsWith('.txt')) continue;
      const name = f.slice(0, -4);
      if (!isSafeVibeName(name)) continue;
      seen.add(name);
    }
  }
  const names = Array.from(seen).sort();
  listingCache = { mtimeMs: fpAsNum, names };
  return names;
}

/**
 * Resolve a vibe name to the first existing file in the search path.
 * User dir wins; bundled dir is the fallback.
 */
function resolveVibePath(name: string): string | null {
  for (const dir of SEARCH_DIRS) {
    const p = join(dir, `${name}.txt`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Validate a section header label. Accepts `default` or `tool:<name>`.
 * Tool names follow JS identifier-ish rules (letters, digits, _, -, /, .)
 * to allow custom tool names from extensions.
 */
function isValidSectionName(name: string): boolean {
  if (name === DEFAULT_POOL) return true;
  if (!name.startsWith('tool:')) return false;
  const tool = name.slice(5);
  return /^[A-Za-z0-9_./-]+$/.test(tool) && tool.length <= 80;
}

function parseSections(raw: string): Map<string, string[]> {
  const pools = new Map<string, string[]>();
  let current = DEFAULT_POOL;
  pools.set(current, []);

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    // section header: [name]
    if (line.startsWith('[') && line.endsWith(']')) {
      const label = line.slice(1, -1).trim().toLowerCase();
      if (!isValidSectionName(label)) continue; // skip malformed headers silently
      current = label;
      if (!pools.has(current)) pools.set(current, []);
      continue;
    }

    pools.get(current)!.push(line);
  }

  // Always expose a 'default' bucket even if empty.
  if (!pools.has(DEFAULT_POOL)) pools.set(DEFAULT_POOL, []);
  return pools;
}

export function loadVibe(name: string): VibePools {
  const empty: VibePools = { pools: new Map([[DEFAULT_POOL, []]]) };
  if (!isSafeVibeName(name)) return empty;
  const path = resolveVibePath(name);
  if (!path) return empty;

  let stat;
  try {
    stat = statSync(path);
  } catch {
    return empty;
  }
  if (stat.size > MAX_VIBE_BYTES) return empty;

  // Cache key includes path so swapping between user/bundled invalidates.
  const cacheKey = `${path}\0${name}`;
  const cached = vibeCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return empty;
  }

  const data: VibePools = { pools: parseSections(raw) };
  vibeCache.set(cacheKey, { mtimeMs: stat.mtimeMs, data });
  return data;
}

/**
 * Multi-pool picker. Tracks `lastIdx` per pool so each section avoids
 * immediate repeats independently. `pickFrom(poolName)` falls back to
 * `default` when the requested pool is missing or empty.
 *
 * Use `getState()` / pass it back into `createPicker` to preserve indices
 * across rebuilds (e.g. mid-stream settings change).
 */
export type PickerState = Map<string, number>;

export function createPicker(pools: Map<string, string[]>, state?: PickerState) {
  const lastIdx: PickerState = new Map(state ?? []);

  function pickFromPool(name: string): string | undefined {
    const lines = pools.get(name);
    if (!lines || lines.length === 0) return undefined;
    if (lines.length === 1) {
      lastIdx.set(name, 0);
      return lines[0];
    }
    const prev = lastIdx.get(name) ?? -1;
    let idx = Math.floor(Math.random() * lines.length);
    if (idx === prev) idx = (idx + 1) % lines.length;
    lastIdx.set(name, idx);
    return lines[idx];
  }

  return {
    /**
     * Pick from a specific pool. If that pool is empty or missing, falls
     * back to the `default` pool.
     */
    pickFrom(name: string): string | undefined {
      const direct = pickFromPool(name);
      if (direct !== undefined) return direct;
      if (name === DEFAULT_POOL) return undefined;
      return pickFromPool(DEFAULT_POOL);
    },
    /** Number of lines in a pool. 0 if missing. */
    sizeOf(name: string): number {
      return pools.get(name)?.length ?? 0;
    },
    /** True if the pool has its own non-empty content (no fallback). */
    has(name: string): boolean {
      return (pools.get(name)?.length ?? 0) > 0;
    },
    /** Pool names that actually have content. */
    nonEmptyPools(): string[] {
      return Array.from(pools.entries())
        .filter(([, v]) => v.length > 0)
        .map(([k]) => k);
    },
    /** Snapshot of internal lastIdx state for rebuilding pickers. */
    getState(): PickerState {
      return new Map(lastIdx);
    },
  };
}

export type Picker = ReturnType<typeof createPicker>;
