import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { FORK_DESKTOP_DEV_PROFILE_DIR, FORK_DESKTOP_PROFILE_DIR } from "@t3tools/shared/forkBrand";

/**
 * Select Electron's profile independently of the server's T3 home. Nothing is
 * carried over from an upstream T3 Code profile, so the two never share state.
 */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: { readonly appDataDirectory: string; readonly isDevelopment: boolean }) {
    const path = yield* Path.Path;
    return path.join(
      input.appDataDirectory,
      input.isDevelopment ? FORK_DESKTOP_DEV_PROFILE_DIR : FORK_DESKTOP_PROFILE_DIR,
    );
  },
);
