/**
 * pi-working-vibe
 *
 * Customizes pi's inline "Working…" indicator:
 *   • Replaces the default text with random lines from a vibe file
 *     (~/.pi/agent/vibes/<name>.txt). Rotates every N ms while streaming.
 *   • Context-aware: switches to a tool-specific message pool when the
 *     model invokes a tool (e.g. [tool:bash] section).
 *   • Swaps the spinner glyph for a configurable preset, with a themed
 *     color, or fully custom frames.
 *
 * Configuration: top-level keys in settings.json. Project
 * (.pi/settings.json) overrides global (~/.pi/agent/settings.json),
 * mirroring pi-powerline.
 *
 * Runtime control: /vibe slash command.
 *
 * Pi APIs (see @earendil-works/pi-coding-agent docs/tui.md pattern 4b):
 *   ctx.ui.setWorkingMessage(text?)
 *   ctx.ui.setWorkingIndicator({ frames, intervalMs }?)
 *
 * Lifecycle:
 *   session_start         → load settings, install indicator, build picker
 *   agent_start           → reset state, set message, start rotation
 *   tool_call             → activePool=`tool:<name>`, refresh message,
 *                           track call id
 *   tool_execution_end    → drop call id; if no more active tools, switch
 *                           activePool back to 'default'
 *   message_start (asst.) → force-refresh the visible message so the user
 *                           gets a snappy new line when the model resumes
 *                           talking after a tool round-trip
 *   agent_end             → stop rotation, reset all state
 *   session_shutdown      → tear down timer + null out ctx ref
 *
 * Why not `message_end`: an `agent` cycle contains many assistant
 * messages separated by tool calls. Pi shows the working indicator the
 * whole time. Stopping rotation at `message_end` would freeze it during
 * tool execution.
 *
 * Parallel tool safety: pi can in principle dispatch multiple tools in
 * one turn. We track call ids in a Set and only switch back to default
 * once the set is empty.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

// Local minimal shapes for events not re-exported from the package root.
// Matches the runtime payload documented in pi's core/extensions/types.d.ts.
interface LocalToolExecutionEndEvent {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  isError: boolean;
}
interface LocalMessageStartEvent {
  type: 'message_start';
  message: unknown; // we only care about .role; messageRole() narrows safely
}
import {
  INDICATOR_PRESETS,
  isSafeVibeName,
  MIN_ROTATE_MS,
  MIN_INDICATOR_INTERVAL_MS,
  persistMigrationOnce,
  readSettings,
  writeSetting,
  type IndicatorPreset,
  type WorkingVibeSettings,
} from './lib/settings.ts';
import {
  createPicker,
  DEFAULT_POOL,
  listVibes,
  loadVibe,
  type Picker,
} from './lib/vibes.ts';
import { buildIndicator } from './lib/indicators.ts';

// ─── live state ───────────────────────────────────────────────────────
//
// Single module-global because pi runs one interactive session per process.

interface LiveState {
  ctx: ExtensionContext;
  settings: WorkingVibeSettings;
  picker: Picker;
  rotateTimer: NodeJS.Timeout | null;
  streaming: boolean;
  /** Pool the rotation timer picks from. Updated by tool_call and
   *  tool_execution_end. */
  activePool: string;
  /** In-flight tool calls: callId → toolName. Insertion order tracks
   *  the most recent tool, so when a tool finishes we can fall back to
   *  the next most recent one still running.
   *
   *  Empty ⇒ not in a tool, back to default. Reset on
   *  agent_start/agent_end as a safety net in case any tool_execution_end
   *  was skipped. */
  activeTools: Map<string, string>;
}

let live: LiveState | null = null;

function clearRotate(): void {
  if (live?.rotateTimer) {
    clearInterval(live.rotateTimer);
    live.rotateTimer = null;
  }
}

function teardown(): void {
  clearRotate();
  live = null;
}

/**
 * Normalize a tool name into a pool key. Tool names can contain dots,
 * slashes (e.g. namespaced custom tools); we lowercase for matching but
 * keep all other chars.
 */
function poolKeyForTool(toolName: string): string {
  return `tool:${toolName.toLowerCase()}`;
}

/**
 * Type guard for AgentMessage role. Falls back gracefully on unknown
 * shapes (custom message types may not carry a `role`).
 */
function messageRole(message: unknown): string | undefined {
  if (
    message &&
    typeof message === 'object' &&
    'role' in message &&
    typeof (message as { role: unknown }).role === 'string'
  ) {
    return (message as { role: string }).role;
  }
  return undefined;
}

/**
 * Load settings + vibe file, rebuild the picker, push the indicator.
 * Preserves streaming state and per-pool picker history so mid-stream
 * config changes don't repeat the message currently on screen.
 */
function applySettings(ctx: ExtensionContext): void {
  const settings = readSettings(ctx.cwd);
  const vibeData = settings.workingVibe
    ? loadVibe(settings.workingVibeName)
    : { pools: new Map([[DEFAULT_POOL, []]]) };
  const prevState = live?.picker?.getState?.();
  const picker = createPicker(vibeData.pools, prevState);

  live = {
    ctx,
    settings,
    picker,
    rotateTimer: live?.rotateTimer ?? null,
    streaming: live?.streaming ?? false,
    activePool: live?.activePool ?? DEFAULT_POOL,
    activeTools: live?.activeTools ?? new Map<string, string>(),
  };

  // Apply indicator unconditionally. Master switch only governs the text;
  // the spinner is independently useful.
  try {
    ctx.ui.setWorkingIndicator(
      buildIndicator(ctx, {
        preset: settings.workingIndicator,
        color: settings.workingIndicatorColor,
        customFrames: settings.workingIndicatorFrames,
        intervalMs: settings.workingIndicatorIntervalMs,
      }),
    );
  } catch {
    // Defensive: never let a bad theme/frame brick the session.
  }

  // No content available → revert to pi's default Working… text.
  const totalLines = picker.sizeOf(DEFAULT_POOL) + picker.nonEmptyPools().filter(p => p !== DEFAULT_POOL).reduce((a, p) => a + picker.sizeOf(p), 0);
  if (!settings.workingVibe || totalLines === 0) {
    clearRotate();
    try {
      ctx.ui.setWorkingMessage();
    } catch {
      /* ignore */
    }
    return;
  }

  if (live.streaming) {
    setMessage();
    startRotation();
  }
}

function setMessage(): void {
  if (!live) return;
  const msg = live.picker.pickFrom(live.activePool);
  if (!msg) return;
  try {
    live.ctx.ui.setWorkingMessage(msg);
  } catch {
    /* ignore — ctx may be tearing down */
  }
}

function startRotation(): void {
  if (!live) return;
  clearRotate();
  const requested = live.settings.workingVibeRotateMs;
  if (requested <= 0) return; // 0 = no rotation
  // Don't spin a timer when no pool has more than one line — rotation
  // would never visibly change anything.
  const totalAvailable = live.picker.nonEmptyPools().reduce((a, p) => a + live!.picker.sizeOf(p), 0);
  if (totalAvailable <= 1) return;
  const interval = Math.max(MIN_ROTATE_MS, requested);
  // unref() so the timer never blocks node from exiting on session_shutdown
  live.rotateTimer = setInterval(setMessage, interval);
  if (typeof live.rotateTimer.unref === 'function') live.rotateTimer.unref();
}

function switchPool(name: string): void {
  if (!live || !live.streaming || !live.settings.workingVibe) return;
  if (live.activePool === name) return;
  live.activePool = name;
  // Immediate refresh so the user sees the new flavor instantly.
  setMessage();
}

/** Force a new message to be picked from the current pool, even if the
 *  pool didn't change. Used at assistant message_start. */
function refreshMessage(): void {
  if (!live || !live.streaming || !live.settings.workingVibe) return;
  setMessage();
}

// ─── entry point ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Expose configuration as flags so `pi --help` and tooling can introspect.
  pi.registerFlag('workingVibe', {
    description: 'Enable pi-working-vibe custom Working… message',
    type: 'boolean',
    default: true,
  });
  pi.registerFlag('workingVibeName', {
    description: 'Vibe file name in ~/.pi/agent/vibes/ (without .txt)',
    type: 'string',
    default: 'mafia',
  });
  pi.registerFlag('workingIndicator', {
    description: `Spinner preset: ${INDICATOR_PRESETS.join('|')}`,
    type: 'string',
    default: 'default',
  });

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;
    applySettings(ctx);
    // Persist legacy-shape migration once, after we've successfully booted.
    persistMigrationOnce();
  });

  // Always track streaming state, even when vibes are disabled, so enabling
  // /vibe on mid-stream can kick off rotation immediately.
  pi.on('agent_start', () => {
    if (!live) return;
    live.streaming = true;
    live.activePool = DEFAULT_POOL;
    live.activeTools.clear(); // safety: prior turn's leaked tool ids
    if (!live.settings.workingVibe) return;
    setMessage();
    startRotation();
  });

  // Tool call → switch to that tool's pool (falls back to default if the
  // section isn't authored). Refreshes message immediately for snappy
  // feedback. Tracks the call id so parallel tools don't prematurely
  // unwind to default.
  pi.on('tool_call', (event: ToolCallEvent) => {
    if (!live || !live.streaming || !live.settings.workingVibe) return;
    if (!event.toolName || !event.toolCallId) return;
    // Re-insert keeps the id as the "most recent" entry, which matters
    // for picking the fallback tool on out-of-order completion.
    live.activeTools.delete(event.toolCallId);
    live.activeTools.set(event.toolCallId, event.toolName);
    switchPool(poolKeyForTool(event.toolName));
  });

  // Tool finished. Three cases:
  //   1. last tool       → switch to default
  //   2. some tools left → switch to the most recently started survivor
  //                        (Map insertion order, take the last key)
  //   3. event for an unknown id (defensive) → no-op
  pi.on('tool_execution_end', (event) => {
    if (!live || !live.streaming || !live.settings.workingVibe) return;
    const e = event as LocalToolExecutionEndEvent;
    if (!e.toolCallId) return;
    if (!live.activeTools.has(e.toolCallId)) return;
    live.activeTools.delete(e.toolCallId);
    if (live.activeTools.size === 0) {
      switchPool(DEFAULT_POOL);
      return;
    }
    // Pick the most recently inserted remaining tool (Map iteration is
    // insertion order; take the last yielded key).
    let lastName: string | undefined;
    for (const name of live.activeTools.values()) lastName = name;
    if (lastName) switchPool(poolKeyForTool(lastName));
  });

  // Snap to a fresh line when a new assistant message begins streaming.
  // Gated to assistant only — user/toolResult message_start events are
  // not user-visible transitions worth re-rendering for.
  pi.on('message_start', (event) => {
    if (!live || !live.streaming || !live.settings.workingVibe) return;
    const e = event as LocalMessageStartEvent;
    if (messageRole(e.message) !== 'assistant') return;
    refreshMessage();
  });

  pi.on('agent_end', () => {
    if (!live) return;
    live.streaming = false;
    live.activePool = DEFAULT_POOL;
    live.activeTools.clear();
    clearRotate();
  });

  // Pi doesn't kill the node process between sessions; without this the
  // rotation timer survives /reload and references a dead ctx.
  pi.on('session_shutdown', () => {
    teardown();
  });

  // ─── /vibe slash command ───────────────────────────────────────────

  pi.registerCommand('vibe', {
    description: 'Configure working message + spinner (vibe, indicator, rotate)',
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [
        { value: 'info', label: 'info', description: 'Show current vibe settings' },
        { value: 'on', label: 'on', description: 'Enable vibe messages' },
        { value: 'off', label: 'off', description: 'Disable vibe messages' },
        { value: 'list', label: 'list', description: 'List installed vibe files' },
        { value: 'reload', label: 'reload', description: 'Reload settings + vibe file' },
        { value: 'preview', label: 'preview', description: 'Show a sample message now' },
        { value: 'pools', label: 'pools', description: 'List sections in active vibe' },
        ...listVibes().map((name) => ({
          value: `vibe:${name}`,
          label: `vibe:${name}`,
          description: `Use ~/.pi/agent/vibes/${name}.txt`,
        })),
        ...INDICATOR_PRESETS.map((p) => ({
          value: `indicator:${p}`,
          label: `indicator:${p}`,
          description: `Spinner preset: ${p}`,
        })),
        { value: 'color:', label: 'color:<token>', description: 'Theme color token' },
        { value: 'rotate:', label: 'rotate:<ms>', description: 'Rotate interval ms (0 = off)' },
        { value: 'interval:', label: 'interval:<ms>', description: 'Spinner frame interval ms' },
      ];
      if (!prefix) return items;
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const arg = args?.trim() ?? '';

      if (!arg) {
        const cur = readSettings(ctx.cwd).workingVibe;
        writeSetting(ctx.cwd, 'workingVibe', !cur);
        applySettings(ctx);
        ctx.ui.notify(`workingVibe → ${!cur ? 'on' : 'off'}`, 'info');
        return;
      }

      const low = arg.toLowerCase();

      switch (low) {
        case 'info': {
          const s = readSettings(ctx.cwd);
          const data = s.workingVibe ? loadVibe(s.workingVibeName) : null;
          const pools = data ? Array.from(data.pools.entries()).filter(([, v]) => v.length > 0) : [];
          const totalLines = pools.reduce((a, [, v]) => a + v.length, 0);
          ctx.ui.notify(
            [
              `workingVibe: ${s.workingVibe ? 'on' : 'off'}`,
              `vibe: ${s.workingVibeName} (${totalLines} lines across ${pools.length} pool${pools.length === 1 ? '' : 's'})`,
              `rotate: ${s.workingVibeRotateMs}ms${
                s.workingVibeRotateMs > 0 && s.workingVibeRotateMs < MIN_ROTATE_MS
                  ? ` (clamped to ${MIN_ROTATE_MS}ms)`
                  : ''
              }`,
              `indicator: ${s.workingIndicator}`,
              `color: ${s.workingIndicatorColor}`,
              `intervalMs: ${s.workingIndicatorIntervalMs}`,
            ].join('\n'),
            'info',
          );
          return;
        }
        case 'pools': {
          if (!live) return ctx.ui.notify('not initialized', 'warning');
          const names = live.picker.nonEmptyPools();
          ctx.ui.notify(
            names.length
              ? names.map((n) => `${n} (${live!.picker.sizeOf(n)} lines)`).join('\n')
              : 'no pools',
            'info',
          );
          return;
        }
        case 'list': {
          const vibes = listVibes();
          ctx.ui.notify(vibes.length ? vibes.join('\n') : 'no vibes in ~/.pi/agent/vibes/', 'info');
          return;
        }
        case 'on':
        case 'off': {
          writeSetting(ctx.cwd, 'workingVibe', low === 'on');
          applySettings(ctx);
          ctx.ui.notify(`workingVibe → ${low}`, 'info');
          return;
        }
        case 'reload': {
          applySettings(ctx);
          ctx.ui.notify('vibe reloaded', 'info');
          return;
        }
        case 'preview': {
          if (!live || live.settings.workingVibe === false) {
            ctx.ui.notify('vibe is disabled', 'warning');
            return;
          }
          const pool = live.activePool;
          const msg = live.picker.pickFrom(pool);
          ctx.ui.notify(msg ? `[${pool}] ${msg}` : '(empty vibe file)', 'info');
          return;
        }
      }

      const colonIdx = arg.indexOf(':');
      if (colonIdx === -1) {
        ctx.ui.notify(usage(), 'warning');
        return;
      }

      const ns = arg.slice(0, colonIdx).toLowerCase();
      const val = arg.slice(colonIdx + 1).trim();

      switch (ns) {
        case 'vibe': {
          if (!val) return ctx.ui.notify('vibe:<name> required', 'warning');
          if (!isSafeVibeName(val)) {
            return ctx.ui.notify('vibe name must be a flat filename without separators', 'warning');
          }
          if (!listVibes().includes(val)) {
            return ctx.ui.notify(`unknown vibe: ${val}. Try /vibe list`, 'warning');
          }
          writeSetting(ctx.cwd, 'workingVibeName', val);
          applySettings(ctx);
          ctx.ui.notify(`vibe → ${val}`, 'info');
          return;
        }
        case 'indicator': {
          if (!(INDICATOR_PRESETS as readonly string[]).includes(val)) {
            return ctx.ui.notify(
              `indicator must be one of: ${INDICATOR_PRESETS.join(', ')}`,
              'warning',
            );
          }
          writeSetting(ctx.cwd, 'workingIndicator', val as IndicatorPreset);
          applySettings(ctx);
          ctx.ui.notify(`indicator → ${val}`, 'info');
          return;
        }
        case 'color': {
          if (!val) return ctx.ui.notify('color:<token> required', 'warning');
          writeSetting(ctx.cwd, 'workingIndicatorColor', val);
          applySettings(ctx);
          ctx.ui.notify(`color → ${val}`, 'info');
          return;
        }
        case 'rotate': {
          const n = Number(val);
          if (!Number.isFinite(n) || n < 0) {
            return ctx.ui.notify('rotate:<ms> must be a non-negative number', 'warning');
          }
          writeSetting(ctx.cwd, 'workingVibeRotateMs', n);
          applySettings(ctx);
          ctx.ui.notify(
            `rotate → ${n}ms${
              n > 0 && n < MIN_ROTATE_MS ? ` (clamped to ${MIN_ROTATE_MS}ms at runtime)` : ''
            }`,
            'info',
          );
          return;
        }
        case 'interval': {
          const n = Number(val);
          if (!Number.isFinite(n) || n < MIN_INDICATOR_INTERVAL_MS) {
            return ctx.ui.notify(
              `interval:<ms> must be ≥${MIN_INDICATOR_INTERVAL_MS}`,
              'warning',
            );
          }
          writeSetting(ctx.cwd, 'workingIndicatorIntervalMs', n);
          applySettings(ctx);
          ctx.ui.notify(`interval → ${n}ms`, 'info');
          return;
        }
        default:
          ctx.ui.notify(usage(), 'warning');
      }
    },
  });
}

function usage(): string {
  return 'Usage: /vibe [on|off|info|list|reload|preview|pools|vibe:<name>|indicator:<preset>|color:<token>|rotate:<ms>|interval:<ms>]';
}
