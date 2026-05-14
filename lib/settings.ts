/**
 * Settings loader for pi-working-vibe.
 *
 * Read order (later overrides earlier):
 *   1. ~/.pi/agent/settings.json   (global)
 *   2. <cwd>/.pi/settings.json     (project)
 *
 * All keys live at the top level of settings.json to stay flat & friendly,
 * mirroring how pi-powerline namespaces its keys.
 *
 * Every value is validated and coerced to a safe default on read. Bad input
 * never reaches the renderer. A legacy `workingVibe: "<name>"` string from
 * earlier ad-hoc usage is auto-migrated to the new shape.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export type IndicatorPreset =
  | 'default'
  | 'dots'
  | 'line'
  | 'pulse'
  | 'braille'
  | 'arrow'
  | 'custom';

export const INDICATOR_PRESETS: readonly IndicatorPreset[] = [
  'default',
  'dots',
  'line',
  'pulse',
  'braille',
  'arrow',
  'custom',
] as const;

export interface WorkingVibeSettings {
  workingVibe: boolean;
  workingVibeName: string;
  workingVibeRotateMs: number;
  workingIndicator: IndicatorPreset;
  workingIndicatorColor: string;
  workingIndicatorFrames: string[];
  workingIndicatorIntervalMs: number;
}

const DEFAULTS: WorkingVibeSettings = {
  workingVibe: true,
  workingVibeName: 'mafia',
  workingVibeRotateMs: 3500,
  workingIndicator: 'default',
  workingIndicatorColor: 'accent',
  workingIndicatorFrames: [],
  workingIndicatorIntervalMs: 90,
};

// Renderer-safety floors. Going below these would hammer the TUI and
// produce visual flicker without benefit.
export const MIN_ROTATE_MS = 750;
export const MIN_INDICATOR_INTERVAL_MS = 40;

const HOME = homedir();
const GLOBAL_SETTINGS = join(HOME, '.pi', 'agent', 'settings.json');
export const VIBES_DIR = join(HOME, '.pi', 'agent', 'vibes');

function readJsonSafe(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const txt = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(txt || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ─── per-field validators ─────────────────────────────────────────────

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}
function isPreset(v: unknown): v is IndicatorPreset {
  return typeof v === 'string' && (INDICATOR_PRESETS as readonly string[]).includes(v);
}

/**
 * Reject vibe names containing path separators, leading dots, or null bytes.
 * Limits filesystem access to a flat ~/.pi/agent/vibes/ directory.
 */
export function isSafeVibeName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 100) return false;
  if (name.startsWith('.')) return false;
  if (/[\\/\0]/.test(name)) return false;
  // Final sanity: resolved path must stay inside VIBES_DIR. Use path.sep
  // so the check works on Windows too.
  const resolved = resolve(VIBES_DIR, `${name}.txt`);
  return resolved.startsWith(VIBES_DIR + sep) || resolved === join(VIBES_DIR, `${name}.txt`);
}

// ─── reader with migration ────────────────────────────────────────────

interface MigrationNote {
  /** True when a legacy shape was detected and rewritten in-memory. */
  migrated: boolean;
  /** Path of the file whose legacy value triggered the migration. */
  source: string | null;
}

let lastMigration: MigrationNote = { migrated: false, source: null };

/**
 * Detects `workingVibe: "<name>"` (legacy string form) and rewrites the
 * merged settings object in-memory into the new {bool, name} shape.
 * Does NOT touch the file — that's the caller's job via maybePersistMigration.
 */
function migrate(merged: Record<string, unknown>, source: string | null): void {
  const v = merged.workingVibe;
  if (typeof v === 'string' && v.length > 0) {
    if (merged.workingVibeName === undefined) {
      merged.workingVibeName = v;
    }
    merged.workingVibe = true;
    lastMigration = { migrated: true, source };
  }
}

export function readSettings(cwd: string): WorkingVibeSettings {
  const globalRaw = readJsonSafe(GLOBAL_SETTINGS);
  const projectPath = join(cwd, '.pi', 'settings.json');
  const projectRaw = readJsonSafe(projectPath);

  // Migrate each layer independently so the source file is identifiable.
  lastMigration = { migrated: false, source: null };
  migrate(globalRaw, existsSync(GLOBAL_SETTINGS) ? GLOBAL_SETTINGS : null);
  migrate(projectRaw, existsSync(projectPath) ? projectPath : null);

  const m = { ...globalRaw, ...projectRaw };
  const s: WorkingVibeSettings = { ...DEFAULTS };

  if (isBool(m.workingVibe)) s.workingVibe = m.workingVibe;
  if (isSafeVibeName(m.workingVibeName)) s.workingVibeName = m.workingVibeName;
  if (isFiniteNumber(m.workingVibeRotateMs) && m.workingVibeRotateMs >= 0) {
    // 0 means "no rotation". Anything positive but below floor clamps later.
    s.workingVibeRotateMs = m.workingVibeRotateMs;
  }
  if (isPreset(m.workingIndicator)) s.workingIndicator = m.workingIndicator;
  if (isString(m.workingIndicatorColor) && m.workingIndicatorColor.length > 0) {
    s.workingIndicatorColor = m.workingIndicatorColor;
  }
  if (isStringArray(m.workingIndicatorFrames)) {
    // Cap to a reasonable upper bound — a 256-frame animation is already absurd.
    s.workingIndicatorFrames = m.workingIndicatorFrames.slice(0, 256);
  }
  if (isFiniteNumber(m.workingIndicatorIntervalMs) && m.workingIndicatorIntervalMs > 0) {
    s.workingIndicatorIntervalMs = Math.max(MIN_INDICATOR_INTERVAL_MS, m.workingIndicatorIntervalMs);
  }

  return s;
}

/**
 * Returns a snapshot of migration info from the most recent `readSettings`
 * call. Does NOT clear internal state — `persistMigrationOnce` consults the
 * same source-of-truth. Exposed for diagnostics / tests.
 */
export function peekMigration(): Readonly<MigrationNote> {
  return { ...lastMigration };
}

// ─── writer ───────────────────────────────────────────────────────────

/**
 * Atomic JSON write: write to a sibling tmp file then rename in place.
 * Rename is atomic on POSIX within the same filesystem. Best-effort
 * cleanup of the tmp file on failure.
 *
 * This protects the user's settings.json — which contains many unrelated
 * keys — from a partial write if pi crashes mid-write or the disk fills.
 */
function atomicWriteJson(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(value, null, 2) + '\n';

  // Preserve the existing file mode if any, so we don't silently tighten
  // (or loosen) permissions on a user's settings.json.
  let mode: number | undefined;
  try {
    if (existsSync(target)) mode = statSync(target).mode & 0o777;
  } catch {
    /* ignore */
  }

  try {
    writeFileSync(tmp, payload, { encoding: 'utf-8', mode: mode ?? 0o644 });
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Write a single setting. Targets the project file when a `.pi/` directory
 * exists in cwd; otherwise writes the global file. Matches pi-powerline.
 *
 * Read-modify-write under the assumption that no other process is editing
 * the same file concurrently. Pi owns it. If the user has settings.json
 * open in an editor with unsaved changes, the editor's next save will
 * blow ours away — same risk as any tool that edits config files.
 */
export function writeSetting<K extends keyof WorkingVibeSettings>(
  cwd: string,
  key: K,
  value: WorkingVibeSettings[K],
): void {
  const projectDir = join(cwd, '.pi');
  const target = existsSync(projectDir) ? join(projectDir, 'settings.json') : GLOBAL_SETTINGS;
  const current = readJsonSafe(target);
  current[key as string] = value as unknown;
  atomicWriteJson(target, current);
}

/**
 * One-shot persistence of the in-memory legacy migration. Rewrites the
 * source file once and only once per process.
 *
 * Reads from module state (`lastMigration`) which is set by `readSettings`.
 * Idempotent against multiple invocations. Safe against partial writes via
 * atomicWriteJson.
 */
let migrationPersisted = false;
export function persistMigrationOnce(): boolean {
  if (migrationPersisted) return false;
  const { migrated, source } = lastMigration;
  if (!migrated || !source) return false;
  migrationPersisted = true;
  try {
    const current = readJsonSafe(source);
    if (typeof current.workingVibe === 'string') {
      if (current.workingVibeName === undefined) {
        current.workingVibeName = current.workingVibe;
      }
      current.workingVibe = true;
      atomicWriteJson(source, current);
      return true;
    }
  } catch {
    // Silent — the in-memory migration already protects this session.
  }
  return false;
}
