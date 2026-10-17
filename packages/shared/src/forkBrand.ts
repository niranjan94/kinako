/**
 * Identity this fork ships under. Call sites import from here instead of
 * carrying literals, so upstream merges only conflict on one-line imports.
 * Every name differs from upstream's so both apps can be installed and run on
 * one machine. Shell and PowerShell installers, the Electron launcher, and the
 * GNOME extension cannot import TypeScript and repeat these values; FORK.md
 * lists them.
 */

export const FORK_DISPLAY_NAME = "Kinako";

/** Base data directory under the user's home, the default `T3CODE_HOME`. */
export const FORK_HOME_DIR_NAME = ".kinako";

/** CLI command, release archive prefix, and single-executable name. */
export const FORK_CLI_NAME = "kinako";

/** npm package of the CLI launcher. Its command is still `FORK_CLI_NAME`; `kinako` on npm belongs to someone else. */
export const FORK_NPM_PACKAGE_NAME = "kinako-cli";

/** GitHub `owner/name` for releases, triage, and issues. */
export const FORK_REPOSITORY = "niranjan94/kinako";

/** Checked-in project file the app reads first and is the only one it writes; upstream's `t3.json` is still read when this one is absent. */
export const FORK_PROJECT_FILE_NAME = "kinako.json";

/** Email for commits the app makes itself; matches no real account. */
export const FORK_GIT_EMAIL = "kinako@localhost";

export const FORK_DESKTOP_APP_ID = "io.niranjan.kinako";
export const FORK_DESKTOP_DEV_APP_ID = `${FORK_DESKTOP_APP_ID}.dev`;

/**
 * Desktop package name, Linux executable, and X11 WM class. Distinct from
 * `FORK_CLI_NAME` because a .deb links its executable into /usr/bin.
 */
export const FORK_DESKTOP_NAME = "kinako-desktop";

/** Electron profile directory under the OS app-data directory. */
export const FORK_DESKTOP_PROFILE_DIR = "kinako";
export const FORK_DESKTOP_DEV_PROFILE_DIR = "kinako-dev";

/** Freedesktop application id, also the D-Bus name prefix the GNOME extension trusts. */
export const FORK_LINUX_APP_ID = "io.niranjan.Kinako";

/** systemd unit, launchd label stem, and agent slice name for the background service. */
export const FORK_SERVICE_NAME = "kinako";

export const FORK_URL_SCHEME = "kinako";
export const FORK_DEV_URL_SCHEME = "kinako-dev";
export const FORK_PREVIEW_URL_SCHEME = "kinako-preview";

export const FORK_DEFAULT_PORT = 3873;
export const FORK_DEFAULT_TAILSCALE_SERVE_PORT = 8443;
