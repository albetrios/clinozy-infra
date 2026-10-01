/**
 * Cross-platform clipboard helper for setup-infra secret reveal.
 *
 * Used by `setup:infra:output --copy <KEY>` to put a secret value on the system
 * clipboard WITHOUT ever printing it to stdout (so it never enters the terminal /
 * agent transcript). Shells out to the native tool via the shared `exec` helpers —
 * no dependency: macOS → pbcopy · Wayland → wl-copy · X11 → xclip / xsel · Windows → clip
 */
import { commandExists, runCommand } from './exec.js';

interface ClipboardTool {
  cmd: string;
  args: string[];
}

function detectTool(): ClipboardTool | null {
  if (process.platform === 'darwin' && commandExists('pbcopy')) return { cmd: 'pbcopy', args: [] };
  if (process.platform === 'win32') return { cmd: 'clip', args: [] };
  if (commandExists('wl-copy')) return { cmd: 'wl-copy', args: [] };
  if (commandExists('xclip')) return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  if (commandExists('xsel')) return { cmd: 'xsel', args: ['--clipboard', '--input'] };
  return null;
}

/** True when a native clipboard tool is available on this machine. */
export function clipboardAvailable(): boolean {
  return detectTool() !== null;
}

/** Copy a value to the clipboard via stdin (never echoed). Returns false if unavailable. */
export function copyToClipboard(value: string): boolean {
  const tool = detectTool();
  if (!tool) return false;
  return runCommand(tool.cmd, { args: tool.args, input: value, allowFailure: true }).status === 0;
}

/** Overwrite the clipboard with an empty string (best-effort). */
export function clearClipboard(): void {
  const tool = detectTool();
  if (tool) runCommand(tool.cmd, { args: tool.args, input: '', allowFailure: true });
}
