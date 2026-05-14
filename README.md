# pi-working-vibe

Custom **Working…** message and spinner for [pi](https://github.com/badlogic/pi-mono).
Drop-in vibes from `~/.pi/agent/vibes/*.txt` plus configurable spinner presets.

Inspired by the `setWorkingMessage` / `setWorkingIndicator` patterns documented
in `@earendil-works/pi-coding-agent` (`docs/tui.md`, pattern 4b) and the
overall layout of `pi-powerline`.

## Install

This extension is local-only. Register it in `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "~/.pi/agent/extensions/pi-working-vibe"
  ]
}
```

(or add the path to your existing `extensions` array)

## Settings

All keys live at the top level of `settings.json`. Project file
`<cwd>/.pi/settings.json` overrides the global file.

| Key | Type | Default | Effect |
|---|---|---|---|
| `workingVibe` | boolean | `true` | Master switch for vibe messages |
| `workingVibeName` | string | `"mafia"` | Vibe file in `~/.pi/agent/vibes/` (no `.txt`) |
| `workingVibeRotateMs` | number | `3500` | Rotate message every N ms while streaming. `0` = no rotation |
| `workingIndicator` | enum | `"default"` | `default` \| `dots` \| `line` \| `pulse` \| `braille` \| `arrow` \| `custom` |
| `workingIndicatorColor` | string | `"accent"` | Theme color token applied to spinner frames |
| `workingIndicatorFrames` | string[] | `[]` | Custom frames (only when `workingIndicator: "custom"`) |
| `workingIndicatorIntervalMs` | number | `90` | Spinner frame interval |

## Vibe files

A vibe is a text file in `~/.pi/agent/vibes/`. One message per line. Blank
lines and `#`-comments are ignored. mtime-based cache, so edits hot-reload.

```text
# ~/.pi/agent/vibes/mafia.txt
The Don is stirring...
Shadows tally the books...
Whispers move the merchandise...
```

## `/vibe` command

| Form | Effect |
|---|---|
| `/vibe` | Toggle master switch |
| `/vibe info` | Print active settings + vibe line count |
| `/vibe list` | List installed vibe files |
| `/vibe on` \| `/vibe off` | Enable / disable |
| `/vibe reload` | Re-read settings + vibe file from disk |
| `/vibe vibe:<name>` | Switch active vibe |
| `/vibe indicator:<preset>` | Switch spinner preset |
| `/vibe color:<token>` | Theme color for spinner |
| `/vibe rotate:<ms>` | Message rotation interval (0 = off) |
| `/vibe interval:<ms>` | Spinner frame interval |

## Notes

- Only affects the normal streaming working line. Compaction and retry
  loaders keep their built-in styling — this is a pi constraint, not
  ours.
- Custom frames are rendered verbatim by pi, so colors are applied via
  the theme. Unknown theme tokens degrade gracefully to no styling.

## License

MIT
