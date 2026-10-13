// @effect-diagnostics nodeBuiltinImport:off - vitest setup runs synchronously before any Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

// macOS keeps temp folders under /var, a symlink to /private/var, so a fixture's
// path differs from its realpath and trips path-equality assertions and symlink
// guards that pass on Linux CI. Windows reads TEMP/TMP, so this only affects POSIX.
process.env.TMPDIR = NodeFS.realpathSync.native(NodeOS.tmpdir());
