// @effect-diagnostics nodeBuiltinImport:off - pure path math over already-resolved paths.
import type {
  OrchestrationV2RuntimeRequest,
  ProviderAdapterRuntimeMode,
  ProviderApprovalOption,
} from "@t3tools/contracts";
import { isHostReviewableRuntimeRequest } from "@t3tools/contracts";
import * as NodePath from "node:path";

/** What the rules see of a pending approval, with every path already made absolute and real. */
export interface ReviewSubject {
  readonly request: Pick<OrchestrationV2RuntimeRequest, "kind" | "responseCapability">;
  readonly command?: string | undefined;
  /** Each requested path, or undefined where it could not be resolved and must be distrusted. */
  readonly paths: ReadonlyArray<string | undefined>;
  readonly options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  readonly fullAccessOverride?: "ask_rule" | "provider_check" | undefined;
  /** The adapter cut the command or path list short, so the rules cannot see all of it. */
  readonly truncated?: boolean | undefined;
  /** The thread's checkout and its additional directories, resolved. */
  readonly roots: ReadonlyArray<string>;
  readonly homeDir: string;
  readonly baseMode: ProviderAdapterRuntimeMode;
}

export type RuleVerdict =
  | { readonly type: "allow"; readonly reason: string }
  | { readonly type: "escalate"; readonly reason: string }
  | { readonly type: "classify"; readonly outsideWorkspace: boolean };

const within = (path: string, root: string) => {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

const sensitiveHomeEntries = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".config/gh",
  ".config/gcloud",
  ".kinako/userdata",
  ".t3/userdata",
];

/** Credentials, app state, and system or hook paths no reviewer approves without the user. */
function isSensitivePath(path: string, homeDir: string): boolean {
  if (sensitiveHomeEntries.some((entry) => within(path, NodePath.join(homeDir, entry))))
    return true;
  if (within(path, "/etc") || within(path, "/private/etc")) return true;
  // Git config and hooks run code on the next git command, the app's own included.
  const segments = path.split(NodePath.sep);
  if (
    segments.some(
      (segment, index) =>
        segment === ".git" && (segments[index + 1] === "hooks" || segments[index + 1] === "config"),
    )
  ) {
    return true;
  }
  const base = NodePath.basename(path);
  return /^\.env(\..+)?$/.test(base) && !/^\.env\.(example|sample|template)$/.test(base);
}

// Each is a side effect outside the checkout, or a way around the reviewer.
const RED_LINE_COMMANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|[\s;&|(])(sudo|doas|su|pkexec)(\s|$)/, "Runs a command with elevated privileges."],
  [/\bgit\s+push\b/, "Pushes to a remote repository."],
  [/\bgh\s+(pr\s+merge|release\s+create|repo\s+delete|api\b)/, "Changes a GitHub repository."],
  [/\b(npm|pnpm|yarn|bun|cargo|twine|gem)\s+publish\b/, "Publishes a package."],
  [
    /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
    "Runs a script downloaded from the network.",
  ],
  [/\b(ssh|scp|rsync)\s/, "Connects to another machine."],
  [/\bchmod\s+-R\b|\bchown\b/, "Changes ownership or permissions recursively."],
  [/\b(dd|mkfs|diskutil|fdisk)\b/, "Writes to a disk device."],
];

const HOME_OR_ABSOLUTE_TARGET = /(^|[\s='"])(~|\$\{?HOME\}?|\/)[^\s'"]*/g;

const expandHome = (target: string, homeDir: string) => {
  const home = /^(~|\$\{HOME\}|\$HOME)/.exec(target)?.[0];
  return home === undefined ? target : NodePath.join(homeDir, target.slice(home.length));
};

const targetOf = (match: RegExpMatchArray) => match[0].replace(/^[\s='"]/, "");

function escalatingCommand(command: string, subject: ReviewSubject): string | undefined {
  for (const [pattern, reason] of RED_LINE_COMMANDS) {
    if (pattern.test(command)) return reason;
  }
  for (const match of command.matchAll(HOME_OR_ABSOLUTE_TARGET)) {
    const expanded = expandHome(targetOf(match), subject.homeDir);
    if (isSensitivePath(NodePath.resolve(expanded), subject.homeDir)) {
      return "Touches credentials, app state, or system files.";
    }
  }
  if (/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)*-?[a-zA-Z]*[rRf]/.test(command)) {
    const outside = [...command.matchAll(HOME_OR_ABSOLUTE_TARGET)].some((match) => {
      const target = targetOf(match);
      if (target.startsWith("/dev/null")) return false;
      const resolved = expandHome(target, subject.homeDir);
      return !subject.roots.some((root) => within(NodePath.resolve(resolved), root));
    });
    if (outside || /\.\.(\/|\s|$)/.test(command)) {
      return "Deletes files outside the workspace.";
    }
  }
  return undefined;
}

// Read-only inspection and local build, test, and lint tools: they read the checkout and
// write only inside it. Flags that write a file or run another program are excluded.
const SAFE_COMMANDS: ReadonlyArray<RegExp> = [
  /^(ls|pwd|cat|head|tail|wc|stat|file|du|df|which|whoami|date|uname|echo|printf|true|diff|cut|tr|basename|dirname|realpath|grep|egrep|jq)(\s|$)/,
  /^sort(\s|$)(?!.*(?<!\S)(-[a-zA-Z]*o|--output)(\s|=|$))/,
  /^uniq(\s+-[a-zA-Z]+)*$/,
  /^tree(\s|$)(?!.*(?<!\S)-o(\s|$))/,
  /^rg(\s|$)(?!.*(?<!\S)--pre(\s|=))/,
  /^fd(\s|$)(?!.*(?<!\S)(-x|-X|--exec|--exec-batch)(\s|=|$))/,
  /^find(\s|$)(?!.*(?<!\S)-(exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls)\b)/,
  /^git\s+(status|diff|log|show|rev-parse|ls-files|blame|describe|stash\s+list|grep)(\s|$)(?!.*(?<!\S)(--output|-O|--open-files-in-pager|--ext-diff)(\s|=|$))/,
  /^git\s+branch(\s+(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose))*$/,
  /^git\s+remote(\s+-v)?$/,
  /^(node|bun|deno|python3?|ruby|go|rustc|cargo|java)\s+(-v|--version|version)$/,
  /^(vp|vpr)\s+(test|check|lint|fmt|typecheck|run\s+(test|typecheck|lint|fmt|check|check:changed|i18n:check))(\s|$)/,
  /^(pnpm|npm|yarn|bun)\s+(test|lint|typecheck|tsc|build|run\s+(test|lint|typecheck|build|check|format:check))(\s|$)/,
  /^pnpm\s+exec\s+(tsc|vitest|eslint|prettier|oxlint)(\s|$)/,
  /^(tsc|vitest|jest|eslint|oxlint|prettier\s+--check|pytest|ruff\s+check|mypy)(\s|$)/,
  /^cargo\s+(test|build|check|clippy|fmt\s+--check)(\s|$)/,
  /^go\s+(test|build|vet)(\s|$)/,
];

/** Splits a command at `&&`, `||`, `;` and `|`, or returns undefined when it can't parse it. */
export function splitSimpleCommand(command: string): ReadonlyArray<string> | undefined {
  // A backslash can escape a quote or separator, which this splitter does not follow.
  if (/\$\(|`|<\(|>\(|\beval\b|\\/.test(command)) return undefined;
  const segments: Array<string> = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    // `2>&1` and `&>` are redirects, not separators.
    if (char === "&" && (command[index - 1] === ">" || command[index + 1] === ">")) {
      current += char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      const next = command[index + 1];
      if (char === "&" && next !== "&") return undefined;
      if ((char === "|" && next === "|") || (char === "&" && next === "&")) index++;
      segments.push(current.trim());
      current = "";
      continue;
    }
    if (char === "\n") return undefined;
    current += char;
  }
  if (quote !== undefined) return undefined;
  segments.push(current.trim());
  return segments.some((segment) => segment.length === 0) ? undefined : segments;
}

// Variables such as GIT_EXTERNAL_DIFF or NODE_OPTIONS run other programs, so only these pass.
const SAFE_ENV_PREFIX =
  /^((CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|LANG|LC_\w+|DEBUG|RUST_BACKTRACE|RUST_LOG)=\S*\s+)+/;

function isSafeLocalCommand(command: string): boolean {
  const segments = splitSimpleCommand(command);
  if (segments === undefined) return false;
  return segments.every((segment) => {
    // Only discarded output may be redirected; anything else could write outside the checkout.
    const withoutDiscards = segment.replace(/\s*(\d?>>?\s*\/dev\/null|2>&1)/g, "");
    if (/[<>]/.test(withoutDiscards)) return false;
    // Expansions and parent paths can point anywhere, so their targets can't be checked here.
    if (/\$|(^|[\s/='"])\.\.(\/|\s|$)/.test(withoutDiscards)) return false;
    const bare = withoutDiscards.replace(SAFE_ENV_PREFIX, "");
    return SAFE_COMMANDS.some((pattern) => pattern.test(bare));
  });
}

/**
 * Tier 0 and Tier 1 of host review: rules that escalate or approve without a model, in that
 * order. Tier 1 runs only over raw requests; a provider's own Auto already passed on the rest.
 */
export function evaluateRules(subject: ReviewSubject): RuleVerdict {
  if (!isHostReviewableRuntimeRequest(subject.request)) {
    return { type: "escalate", reason: "Only you can answer this request." };
  }
  if (subject.fullAccessOverride === "ask_rule") {
    return { type: "escalate", reason: "One of your ask rules covers this action." };
  }
  if (
    subject.options !== undefined &&
    subject.options.length > 0 &&
    !subject.options.some((option) => option.decision === "accept")
  ) {
    return { type: "escalate", reason: "The provider offers only a standing approval." };
  }
  if (subject.truncated === true) {
    return { type: "escalate", reason: "The request is too large to review in full." };
  }
  if (subject.paths.some((path) => path === undefined)) {
    return { type: "escalate", reason: "A requested path could not be resolved." };
  }
  const paths = subject.paths as ReadonlyArray<string>;
  if (paths.some((path) => isSensitivePath(path, subject.homeDir))) {
    return { type: "escalate", reason: "Touches credentials, app state, or system files." };
  }
  const outsideWorkspace = paths.some((path) => !subject.roots.some((root) => within(path, root)));
  if (outsideWorkspace && subject.request.kind === "file-change") {
    return { type: "escalate", reason: "Changes files outside the workspace." };
  }
  const command = subject.command?.trim();
  if (command !== undefined && command.length > 0) {
    const reason = escalatingCommand(command, subject);
    if (reason !== undefined) return { type: "escalate", reason };
  }

  if (subject.baseMode === "auto" || outsideWorkspace)
    return { type: "classify", outsideWorkspace };
  if (
    (subject.request.kind === "file-read" || subject.request.kind === "file-change") &&
    paths.length > 0 &&
    command === undefined
  ) {
    return {
      type: "allow",
      reason:
        subject.request.kind === "file-read"
          ? "Reads files in the workspace."
          : "Edits files in the workspace.",
    };
  }
  if (subject.request.kind === "command" && command !== undefined && isSafeLocalCommand(command)) {
    return { type: "allow", reason: "Runs a local read-only, build, or test command." };
  }
  return { type: "classify", outsideWorkspace };
}
