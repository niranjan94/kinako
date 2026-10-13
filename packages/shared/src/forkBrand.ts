/**
 * Identity this fork ships under. Call sites import from here instead of
 * carrying literals, so upstream merges only conflict on one-line imports.
 * Shell and PowerShell installers and the Electron launcher cannot import
 * TypeScript and repeat these values; FORK.md lists them.
 */

export const FORK_DISPLAY_NAME = "Kinako";

/** Base data directory under the user's home, the default `T3CODE_HOME`. */
export const FORK_HOME_DIR_NAME = ".kinako";

/** CLI command, release archive prefix, and single-executable name. */
export const FORK_CLI_NAME = "kinako";

export const FORK_DESKTOP_APP_ID = "io.niranjan.kinako";
export const FORK_DESKTOP_DEV_APP_ID = `${FORK_DESKTOP_APP_ID}.dev`;
export const FORK_LINUX_WM_CLASS = "kinako";

export const FORK_URL_SCHEME = "kinako";
export const FORK_DEV_URL_SCHEME = "kinako-dev";
export const FORK_PREVIEW_URL_SCHEME = "kinako-preview";
