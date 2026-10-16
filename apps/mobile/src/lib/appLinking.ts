import {
  FORK_DEV_URL_SCHEME,
  FORK_PREVIEW_URL_SCHEME,
  FORK_URL_SCHEME,
} from "@t3tools/shared/forkBrand";

const SCHEME_ONLY_URL = new RegExp(
  `^(?:${[FORK_URL_SCHEME, FORK_DEV_URL_SCHEME, FORK_PREVIEW_URL_SCHEME].join("|")}):\\/*$`,
);

/**
 * The Expo dev client launches the app via
 * <scheme>://expo-development-client/?url=<packager> — that URL addresses
 * the launcher, not app navigation. Without this filter it falls through
 * to the NotFound wildcard route on every dev launch.
 */
export function shouldHandleAppLink(url: string): boolean {
  return (
    !url.includes("expo-development-client") &&
    !url.includes("://expo-sharing") &&
    !SCHEME_ONLY_URL.test(url)
  );
}
