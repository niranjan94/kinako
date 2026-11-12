// @effect-diagnostics nodeBuiltinImport:off - vitest setup runs synchronously before any Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

// Override inherited autocrlf, signing and init-branch settings through env so every git child gets stable fixtures.
const entries: ReadonlyArray<readonly [key: string, value: string]> = [
  ["core.autocrlf", "false"],
  ["core.filemode", "false"],
  ["core.longpaths", "true"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
];

const existing = Number(process.env.GIT_CONFIG_COUNT ?? "0");
process.env.GIT_CONFIG_COUNT = String(existing + entries.length);
entries.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${existing + index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${existing + index}`] = value;
});

// A developer's global branch.autoSetupMerge=always gives fixture branches an upstream. Reset it
// at global precedence, not through env, so a repository's own setting still wins as in real use.
const globalConfig = NodePath.join(NodeOS.tmpdir(), `t3-test-gitconfig-${process.getuid?.() ?? 0}`);
if (process.env.GIT_CONFIG_GLOBAL !== globalConfig) {
  const home = NodeOS.homedir();
  const globalConfigs = process.env.GIT_CONFIG_GLOBAL
    ? [process.env.GIT_CONFIG_GLOBAL]
    : [
        NodePath.join(
          process.env.XDG_CONFIG_HOME || NodePath.join(home, ".config"),
          "git",
          "config",
        ),
        NodePath.join(home, ".gitconfig"),
      ];
  const contents = [
    ...globalConfigs.map((file) => `[include]\n\tpath = ${JSON.stringify(file)}\n`),
    "[branch]\n\tautoSetupMerge = true\n",
  ].join("");
  const staged = `${globalConfig}.${process.pid}.${NodeWorkerThreads.threadId}`;
  NodeFS.writeFileSync(staged, contents);
  NodeFS.renameSync(staged, globalConfig);
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
}
