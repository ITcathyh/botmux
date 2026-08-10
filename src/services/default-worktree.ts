/** Auto-worktree configuration gate shared by new-session admission paths. */
import { getBot } from '../bot-registry.js';

/**
 * Whether this bot opts into auto-worktree on new sessions: it must be in
 * 「仅默认目录」mode (`defaultWorkingDir` set) with the toggle on. Because the
 * toggle is only settable in that mode, this doubles as the "in default mode"
 * check. Callers still gate on the resolved dir actually being the default one.
 */
export function botAutoWorktreeEnabled(larkAppId: string): boolean {
  try {
    const cfg = getBot(larkAppId).config;
    return cfg.defaultWorkingDirAutoWorktree === true && !!cfg.defaultWorkingDir;
  } catch {
    return false;
  }
}
