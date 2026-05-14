/**
 * Spinner presets + theming for `ctx.ui.setWorkingIndicator`.
 *
 * Pi renders custom frames verbatim, so we apply colors ourselves via the
 * theme. theme.fg accepts a typed `ThemeColor`; the user setting is a free
 * string. We cast at the boundary and wrap in try/catch so an unknown token
 * degrades to plain text instead of crashing.
 */
import type {
  ExtensionContext,
  ThemeColor,
  WorkingIndicatorOptions,
} from '@earendil-works/pi-coding-agent';
import type { IndicatorPreset } from './settings.ts';

const PRESETS: Record<Exclude<IndicatorPreset, 'default' | 'custom'>, readonly string[]> = {
  // braille spinner — same family as pi's default
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  // ASCII fallback, terminals without nerd fonts
  line: ['|', '/', '-', '\\'],
  // pulsing dot
  pulse: ['·', '•', '●', '•'],
  // denser braille
  braille: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
  // unicode arrow rotation
  arrow: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
};

function safeFg(ctx: ExtensionContext, color: string, text: string): string {
  try {
    return ctx.ui.theme.fg(color as ThemeColor, text);
  } catch {
    return text;
  }
}

function colorize(ctx: ExtensionContext, color: string, frames: readonly string[]): string[] {
  return frames.map((f) => safeFg(ctx, color, f));
}

export interface IndicatorParams {
  preset: IndicatorPreset;
  color: string;
  customFrames: string[];
  intervalMs: number;
}

/**
 * Build a `WorkingIndicatorOptions` payload for the given preset, or
 * return `undefined` to ask pi to restore its default spinner.
 *
 * Returns `undefined` (= default) when:
 *   - preset === 'default'
 *   - preset === 'custom' but the frames array is empty (avoids hiding
 *     the indicator entirely by accident; that's what {frames:[]} would do
 *     and the user has no way to recover without editing settings.json).
 *   - preset is otherwise unknown (defensive — settings.ts already filters).
 */
export function buildIndicator(
  ctx: ExtensionContext,
  p: IndicatorParams,
): WorkingIndicatorOptions | undefined {
  if (p.preset === 'default') return undefined;

  if (p.preset === 'custom') {
    if (p.customFrames.length === 0) return undefined;
    return {
      frames: colorize(ctx, p.color, p.customFrames),
      intervalMs: p.intervalMs,
    };
  }

  const base = PRESETS[p.preset];
  if (!base) return undefined;

  return {
    frames: colorize(ctx, p.color, base),
    intervalMs: p.intervalMs,
  };
}
