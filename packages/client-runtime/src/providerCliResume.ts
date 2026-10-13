import {
  ClaudeSettings,
  CodexSettings,
  type ExecutionEnvironmentPlatformOs,
  type OrchestrationV2ThreadShellNativeThread,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const SAFE_SHELL_WORD_PATTERN = /^[A-Za-z0-9_./:\\-]+$/;

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Quote a provider binary for the host shell, keeping a leading `~/` expandable. */
export function quoteProviderBinary(
  binaryPath: string,
  fallback: string,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  if (
    SAFE_SHELL_WORD_PATTERN.test(binaryPath) &&
    (platform === "windows" || !binaryPath.includes("\\"))
  ) {
    return binaryPath;
  }
  if (platform === "windows") return `& ${quotePowerShell(binaryPath)}`;
  if (platform === "darwin" || platform === "linux") {
    if (binaryPath.startsWith("~/") || binaryPath.startsWith("~\\")) {
      return `~/${quotePosix(binaryPath.slice(2))}`;
    }
    return quotePosix(binaryPath);
  }
  return fallback;
}

function quoteShellWord(value: string, platform: ExecutionEnvironmentPlatformOs): string {
  if (platform === "windows") {
    return SAFE_SHELL_WORD_PATTERN.test(value) ? value : quotePowerShell(value);
  }
  if (SAFE_SHELL_WORD_PATTERN.test(value) && !value.includes("\\")) return value;
  if (value.startsWith("~/")) return `~/${quotePosix(value.slice(2))}`;
  return quotePosix(value);
}

interface HomeEnvironmentVariable {
  readonly name: "CLAUDE_CONFIG_DIR" | "CODEX_HOME";
  readonly value: string;
}

function instanceEnvironmentValue(
  instance: ProviderInstanceConfig | undefined,
  name: HomeEnvironmentVariable["name"],
): string | null {
  const variable = instance?.environment?.find(
    (entry) => entry.name === name && entry.valueRedacted !== true,
  );
  const value = variable?.value.trim() ?? "";
  return value.length > 0 ? value : null;
}

function homeVariable(
  name: HomeEnvironmentVariable["name"],
  value: string | null,
): HomeEnvironmentVariable | null {
  return value === null || value.length === 0 ? null : { name, value };
}

interface ResumeInvocation {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly home: HomeEnvironmentVariable | null;
}

function resolveResumeInvocation(
  nativeThread: OrchestrationV2ThreadShellNativeThread,
  instance: ProviderInstanceConfig | undefined,
): ResumeInvocation | null {
  if (nativeThread.driver === "claudeAgent") {
    // `--resume-session-at` is ignored by the interactive CLI, so a pending
    // rollback would come back with the discarded turns.
    if (nativeThread.conversationHeadId !== null) return null;
    const config = Option.getOrNull(decodeClaudeSettings(instance?.config ?? {}));
    return {
      binary: config?.binaryPath ?? "claude",
      args: ["--resume", nativeThread.nativeId],
      home: homeVariable(
        "CLAUDE_CONFIG_DIR",
        config?.homePath || instanceEnvironmentValue(instance, "CLAUDE_CONFIG_DIR"),
      ),
    };
  }
  if (nativeThread.driver === "codex") {
    const config = Option.getOrNull(decodeCodexSettings(instance?.config ?? {}));
    // A shadow home holds this account's auth and links the shared sessions,
    // so it is the home T3 ran the conversation in.
    return {
      binary: config?.binaryPath ?? "codex",
      args: ["resume", nativeThread.nativeId],
      home: homeVariable(
        "CODEX_HOME",
        config?.shadowHomePath ||
          config?.homePath ||
          instanceEnvironmentValue(instance, "CODEX_HOME"),
      ),
    };
  }
  return null;
}

/**
 * Shell command that continues a thread's native conversation in its provider's CLI on the
 * server host, or null when the provider or conversation state cannot be resumed there.
 */
export function buildProviderCliResumeCommand(input: {
  readonly nativeThread: OrchestrationV2ThreadShellNativeThread;
  readonly cwd: string;
  readonly platform: ExecutionEnvironmentPlatformOs;
  readonly instance: ProviderInstanceConfig | undefined;
}): string | null {
  const invocation = resolveResumeInvocation(input.nativeThread, input.instance);
  if (invocation === null) return null;
  const fallbackBinary = input.nativeThread.driver === "codex" ? "codex" : "claude";
  const command = [
    quoteProviderBinary(invocation.binary, fallbackBinary, input.platform),
    ...invocation.args.map((arg) => quoteShellWord(arg, input.platform)),
  ].join(" ");
  const cwd = quoteShellWord(input.cwd, input.platform);

  if (input.platform === "windows") {
    const home =
      invocation.home === null
        ? ""
        : `$env:${invocation.home.name} = ${quotePowerShell(invocation.home.value)}; `;
    return `cd ${cwd}; ${home}${command}`;
  }
  const home =
    invocation.home === null
      ? ""
      : `${invocation.home.name}=${quoteShellWord(invocation.home.value, input.platform)} `;
  return `cd ${cwd} && ${home}${command}`;
}
