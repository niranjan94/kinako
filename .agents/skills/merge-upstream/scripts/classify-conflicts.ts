// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Triage for an in-progress upstream merge. Rebuilds every conflicted file from
// its index stages (base, ours, theirs), resolves the hunks a rule can settle
// without judgement, and assigns the rest a model tier for delegation.
//
//   node .agents/skills/merge-upstream/scripts/classify-conflicts.ts [--apply] [--json]
//
// Without --apply it only reports. With --apply it rewrites each conflicted
// file that is still untouched since the merge: auto-resolved hunks become
// plain text, the rest stay as diff3 conflicts (with the base section), and
// files with nothing left are staged. Run it right after `git merge`, before
// anyone edits a conflicted file. Then run `vp fmt` on the rewritten files.
//
// Auto rules (code is never invented, only taken from one side):
//   comment-only  One side changed only comments or blank lines. Keep the other
//                 side's code and carry the comment edits over where the code
//                 they sit above is unchanged.
//   imports       Every line on every side is an import/export statement or a
//                 specifier inside one. Union of both sides, minus what
//                 upstream removed.
//
// Tiers for the rest: opus (control flow, Effect layers, schemas, server
// orchestration, persistence, contracts, large hunks), haiku (the sides differ
// only in string or number literals), sonnet (everything else).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

type Tier = "auto" | "haiku" | "sonnet" | "opus";
type Hunk = { ours: string[]; base: string[]; theirs: string[] };
type Segment = { kind: "text"; lines: string[] } | { kind: "conflict"; hunk: Hunk };
type HunkResult = {
  tier: Tier;
  reason: string;
  resolved?: string[];
  notes: string[];
};
type FileReport = {
  path: string;
  tier: Tier | "modify-delete" | "binary" | "lockfile";
  hunks: HunkResult[];
  detail?: string;
  applied?: "full" | "partial" | "skipped-edited";
};

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const asJson = args.has("--json");
const TIER_ORDER: Tier[] = ["auto", "haiku", "sonnet", "opus"];
const MARKER = "~".repeat(3) + "MERGE~SEGMENT~";

const git = (argv: string[], input?: string) =>
  NodeChildProcess.execFileSync("git", argv, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });

function unmergedEntries(): Map<string, Map<number, string>> {
  const files = new Map<string, Map<number, string>>();
  for (const record of git(["ls-files", "-u", "-z"]).split("\0")) {
    if (record === "") continue;
    const [meta, path] = record.split("\t");
    const [, oid, stage] = meta.split(" ");
    if (!files.has(path)) files.set(path, new Map());
    files.get(path)!.set(Number(stage), oid);
  }
  return files;
}

const blob = (oid: string | undefined) => (oid === undefined ? "" : git(["cat-file", "blob", oid]));

// Same algorithm as merge-ort, so hunks line up with the markers git wrote.
function mergeSegments(ours: string, base: string, theirs: string): Segment[] {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kinako-classify-"));
  try {
    const paths = { ours: "", base: "", theirs: "" };
    for (const [name, content] of Object.entries({ ours, base, theirs })) {
      const path = NodePath.join(dir, name);
      NodeFS.writeFileSync(path, content);
      paths[name as keyof typeof paths] = path;
    }
    const result = NodeChildProcess.spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        "--diff3",
        "--diff-algorithm=histogram",
        `--marker-size=${MARKER.length}`,
        paths.ours,
        paths.base,
        paths.theirs,
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    if (result.status === null || result.status < 0) throw new Error(result.stderr);
    return parseSegments(result.stdout);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

function parseSegments(output: string): Segment[] {
  const open = "<".repeat(MARKER.length);
  const mid = "|".repeat(MARKER.length);
  const sep = "=".repeat(MARKER.length);
  const close = ">".repeat(MARKER.length);
  const segments: Segment[] = [];
  let text: string[] = [];
  let hunk: Hunk | null = null;
  let side: keyof Hunk = "ours";
  for (const line of output.split("\n")) {
    if (line.startsWith(open)) {
      segments.push({ kind: "text", lines: text });
      text = [];
      hunk = { ours: [], base: [], theirs: [] };
      side = "ours";
    } else if (hunk !== null && line.startsWith(mid)) side = "base";
    else if (hunk !== null && line === sep) side = "theirs";
    else if (hunk !== null && line.startsWith(close)) {
      segments.push({ kind: "conflict", hunk });
      hunk = null;
    } else if (hunk !== null) hunk[side].push(line);
    else text.push(line);
  }
  segments.push({ kind: "text", lines: text });
  return segments;
}

const isScript = (path: string) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path);
const isTrivia = (line: string) => {
  const t = line.trim();
  return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
};
const code = (lines: string[]) => lines.filter((line) => !isTrivia(line));
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// Splits lines into code lines, each with the comment/blank run directly above it.
function anchored(lines: string[]) {
  const anchors: { run: string[]; line: string | null }[] = [];
  let run: string[] = [];
  for (const line of lines) {
    if (isTrivia(line)) run.push(line);
    else {
      anchors.push({ run, line });
      run = [];
    }
  }
  anchors.push({ run, line: null });
  return anchors;
}

// `codeSide` keeps its code; comment runs it shares with `before` take `after`'s version.
function overlayComments(codeSide: string[], before: string[], after: string[]) {
  const from = anchored(before);
  const to = anchored(after);
  const notes: string[] = [];
  const out: string[] = [];
  let carried = 0;
  for (const { run, line } of anchored(codeSide)) {
    const matches = from
      .map((anchor, index) => ({ anchor, index }))
      .filter(({ anchor }) => anchor.line === line && same(anchor.run, run));
    if (matches.length === 1 && !same(from[matches[0].index].run, to[matches[0].index].run)) {
      out.push(...to[matches[0].index].run);
      carried++;
    } else out.push(...run);
    if (line !== null) out.push(line);
  }
  const edits = from.filter((anchor, index) => !same(anchor.run, to[index].run)).length;
  if (carried < edits)
    notes.push(`${edits - carried} comment edit(s) not carried over; check lint`);
  return { lines: out, notes };
}

const IMPORT_STATEMENT =
  /^\s*(import|export)\b[^;]*?\bfrom\s*["'][^"']+["'];?\s*$|^\s*import\s*["'][^"']+["'];?\s*$/;
const SPECIFIER = /^\s*(type\s+)?[A-Za-z_$][\w$]*(\s+as\s+[A-Za-z_$][\w$]*)?,?\s*$/;
const NAMED_IMPORT = /^\s*(import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*(["'][^"']+["']);?\s*$/;

function insideImportBraces(before: string[]) {
  for (let i = before.length - 1; i >= 0; i--) {
    const line = before[i];
    if (/^\s*(import|export)\s+(type\s+)?\{\s*$/.test(line)) return true;
    if (/;\s*$/.test(line) || /\bfrom\s*["']/.test(line) || /^\s*\}/.test(line)) return false;
    if (!SPECIFIER.test(line) && !isTrivia(line)) return false;
  }
  return false;
}

function mergeImports(hunk: Hunk, specifiers: boolean): string[] | null {
  const sides = [hunk.ours, hunk.base, hunk.theirs].map(code);
  const pattern = specifiers ? SPECIFIER : IMPORT_STATEMENT;
  if (!sides.every((lines) => lines.every((line) => pattern.test(line)))) return null;
  const [ours, base, theirs] = sides;
  const key = (line: string) => line.trim().replace(/,$/, "").replace(/\s+/g, " ");
  const removed = new Set(base.map(key).filter((k) => !theirs.map(key).includes(k)));
  const result = new Map<string, string>();
  for (const line of [...ours, ...theirs]) {
    const k = key(line);
    if (removed.has(k)) continue;
    if (!result.has(k)) result.set(k, specifiers ? line.replace(/,?\s*$/, ",") : line);
  }
  if (specifiers) return [...result.values()];
  // Same module imported on both sides with different names: one statement, names unioned.
  const byModule = new Map<string, { head: string; names: string[]; module: string }>();
  const out: string[] = [];
  for (const line of result.values()) {
    const named = NAMED_IMPORT.exec(line);
    if (named === null) {
      out.push(line);
      continue;
    }
    const [, verb, type = "", list, module] = named;
    const id = `${verb} ${type}${module}`;
    const names = list
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const existing = byModule.get(id);
    if (existing === undefined) {
      const entry = { head: `${verb} ${type}`, names, module };
      byModule.set(id, entry);
      out.push(id);
    } else for (const name of names) if (!existing.names.includes(name)) existing.names.push(name);
  }
  return out.map((line) => {
    const entry = byModule.get(line);
    return entry === undefined
      ? line
      : `${entry.head}{ ${entry.names.join(", ")} } from ${entry.module};`;
  });
}

const HIGH_RISK_PATH =
  /^(apps\/server\/src\/(orchestration-v2|persistence|mcp|ws\.ts|provider\/)|packages\/contracts\/|packages\/provider-)/;
const HIGH_RISK_CODE = /\b(case|switch|break|continue|Layer\.|Schema\.|Effect\.(fn|gen)|yield\*)/;
const stripLiterals = (lines: string[]) =>
  code(lines).map((line) =>
    line
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
      .replace(/\b\d+(\.\d+)?\b/g, "0"),
  );

function classifyHunk(path: string, hunk: Hunk, before: string[]): HunkResult {
  if (isScript(path)) {
    const oursCode = code(hunk.ours);
    const baseCode = code(hunk.base);
    const theirsCode = code(hunk.theirs);
    if (same(theirsCode, baseCode)) {
      const { lines, notes } = overlayComments(hunk.ours, hunk.base, hunk.theirs);
      return { tier: "auto", reason: "upstream changed only comments", resolved: lines, notes };
    }
    if (same(oursCode, baseCode)) {
      const { lines, notes } = overlayComments(hunk.theirs, hunk.base, hunk.ours);
      return { tier: "auto", reason: "fork changed only comments", resolved: lines, notes };
    }
    const imports = mergeImports(hunk, insideImportBraces(before));
    if (imports !== null)
      return { tier: "auto", reason: "import union", resolved: imports, notes: [] };
  }
  const all = [...hunk.ours, ...hunk.base, ...hunk.theirs];
  const size = Math.max(hunk.ours.length, hunk.theirs.length);
  if (HIGH_RISK_PATH.test(path))
    return { tier: "opus", reason: "server core or contracts", notes: [] };
  if (all.some((line) => HIGH_RISK_CODE.test(line)))
    return { tier: "opus", reason: "control flow, layers or schemas", notes: [] };
  if (size > 40) return { tier: "opus", reason: `large hunk (${size} lines)`, notes: [] };
  if (same(stripLiterals(hunk.ours), stripLiterals(hunk.theirs)))
    return { tier: "haiku", reason: "sides differ only in literals", notes: [] };
  return { tier: "sonnet", reason: "independent edits to the same lines", notes: [] };
}

function render(segments: Segment[], results: HunkResult[]) {
  const out: string[] = [];
  let index = 0;
  for (const segment of segments) {
    if (segment.kind === "text") {
      out.push(...segment.lines);
      continue;
    }
    const result = results[index++];
    if (result.resolved !== undefined) out.push(...result.resolved);
    else
      out.push(
        "<<<<<<< HEAD",
        ...segment.hunk.ours,
        "||||||| base",
        ...segment.hunk.base,
        "=======",
        ...segment.hunk.theirs,
        ">>>>>>> upstream/main",
      );
  }
  return out.join("\n");
}

const reports: FileReport[] = [];
const toStage: string[] = [];
for (const [path, stages] of unmergedEntries()) {
  if (path === "pnpm-lock.yaml") {
    reports.push({
      path,
      tier: "lockfile",
      hunks: [],
      detail: "take theirs, pnpm install at the end",
    });
    continue;
  }
  if (!stages.has(2) || !stages.has(3)) {
    const detail = stages.has(2)
      ? "deleted upstream, changed in the fork: follow upstream and re-home the fork's change"
      : "deleted in the fork, changed upstream: usually keep it deleted (check why the fork removed it)";
    reports.push({ path, tier: "modify-delete", hunks: [], detail });
    continue;
  }
  const [ours, base, theirs] = [2, 1, 3].map((stage) => blob(stages.get(stage)));
  if ([ours, base, theirs].some((content) => content.includes("\0"))) {
    reports.push({ path, tier: "binary", hunks: [] });
    continue;
  }
  const segments = mergeSegments(ours, base, theirs);
  const results: HunkResult[] = [];
  const before: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") before.push(...segment.lines);
    else {
      results.push(classifyHunk(path, segment.hunk, before));
      before.push(...segment.hunk.ours);
    }
  }
  const tier = results.reduce<Tier>(
    (max, r) => (TIER_ORDER.indexOf(r.tier) > TIER_ORDER.indexOf(max) ? r.tier : max),
    "auto",
  );
  const report: FileReport = { path, tier, hunks: results };
  if (apply && results.some((r) => r.tier === "auto")) {
    const working = NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : "";
    const markers = working.split("\n").filter((line) => line.startsWith("<<<<<<< ")).length;
    if (markers !== results.length) report.applied = "skipped-edited";
    else {
      NodeFS.writeFileSync(path, render(segments, results));
      report.applied = tier === "auto" ? "full" : "partial";
      if (tier === "auto") toStage.push(path);
    }
  }
  reports.push(report);
}
if (toStage.length > 0) git(["add", "--", ...toStage]);

if (asJson) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  const groups: FileReport["tier"][] = [
    "modify-delete",
    "lockfile",
    "binary",
    "opus",
    "sonnet",
    "haiku",
    "auto",
  ];
  const hunkCount = reports.reduce((n, r) => n + r.hunks.length, 0);
  const autoCount = reports.reduce(
    (n, r) => n + r.hunks.filter((h) => h.tier === "auto").length,
    0,
  );
  console.log(
    `${reports.length} conflicted files, ${hunkCount} hunks, ${autoCount} resolvable by rule\n`,
  );
  for (const group of groups) {
    const members = reports.filter((r) => r.tier === group);
    if (members.length === 0) continue;
    console.log(`== ${group} (${members.length})`);
    for (const r of members) {
      const open = r.hunks.filter((h) => h.tier !== "auto");
      const reasons = [...new Set(open.map((h) => h.reason))].join("; ");
      const autoN = r.hunks.length - open.length;
      const parts = [
        r.detail,
        r.hunks.length > 0 ? `${open.length}/${r.hunks.length} open` : undefined,
        autoN > 0 && open.length > 0 ? `${autoN} auto` : undefined,
        reasons || undefined,
        r.applied,
        ...new Set(r.hunks.flatMap((h) => h.notes)),
      ].filter(Boolean);
      console.log(`  ${r.path}  ${parts.join(" | ")}`);
    }
    console.log("");
  }
  if (apply)
    console.log(
      `Staged ${toStage.length} fully resolved files. Run vp fmt on every rewritten file.`,
    );
}
