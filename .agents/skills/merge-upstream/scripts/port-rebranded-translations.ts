// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Carries upstream translations over to strings the fork rebranded during a merge.
//
//   node .agents/skills/merge-upstream/scripts/port-rebranded-translations.ts
//
// Run after `vp run i18n:generate` in each app, while MERGE_HEAD exists. A
// resolution that turns upstream's `gt("Open T3 Code")` into
// `gt("Open {app}", { app: APP_BASE_NAME })` makes a new catalog key whose
// locales hold English. For every such key whose English, with each variable
// below put back as upstream's literal, matches an upstream key, this copies
// that key's translations with the literal swapped back for the variable.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const LITERALS: Record<string, ReadonlyArray<string>> = {
  app: ["T3 Code", "T3"],
  appName: ["T3 Code"],
  product: ["T3 Code"],
  cli: ["t3"],
  npmPackage: ["t3"],
};

type Catalog = Record<string, unknown>;

const root = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const upstream = (file: string): Catalog | null => {
  try {
    return JSON.parse(
      NodeChildProcess.execFileSync("git", ["show", `MERGE_HEAD:${file}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
};

const substitutions = (text: string) => {
  let candidates: Array<{ text: string; used: Array<[string, string]> }> = [{ text, used: [] }];
  for (const [name, literals] of Object.entries(LITERALS)) {
    if (!text.includes(`{${name}}`)) continue;
    candidates = candidates.flatMap((candidate) =>
      literals.map((literal) => ({
        text: candidate.text.replaceAll(`{${name}}`, literal),
        used: [...candidate.used, [name, literal] as [string, string]],
      })),
    );
  }
  return candidates.filter((candidate) => candidate.used.length > 0);
};

for (const app of ["web", "mobile", "desktop"]) {
  const dir = `apps/${app}/src/i18n/translations`;
  const upstreamEnglish = upstream(`${dir}/en.json`);
  if (upstreamEnglish === null) continue;
  const keyByText = new Map<string, string>();
  for (const [key, value] of Object.entries(upstreamEnglish)) {
    if (typeof value === "string" && !keyByText.has(value)) keyByText.set(value, key);
  }
  const english: Catalog = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, dir, "en.json"), "utf8"),
  );
  const locales = NodeFS.readdirSync(NodePath.join(root, dir))
    .filter((file) => file.endsWith(".json") && file !== "en.json")
    .map((file) => file.slice(0, -".json".length));
  const upstreamLocales = new Map(
    locales.map((locale) => [locale, upstream(`${dir}/${locale}.json`) ?? {}]),
  );
  const ownLocales = new Map(
    locales.map((locale): [string, Catalog] => [
      locale,
      JSON.parse(NodeFS.readFileSync(NodePath.join(root, dir, `${locale}.json`), "utf8")),
    ]),
  );
  let ported = 0;
  for (const [key, text] of Object.entries(english)) {
    if (typeof text !== "string" || Object.hasOwn(upstreamEnglish, key)) continue;
    for (const candidate of substitutions(text)) {
      const source = keyByText.get(candidate.text);
      if (source === undefined) continue;
      const translated = new Map<string, string>();
      for (const locale of locales) {
        const value = upstreamLocales.get(locale)![source];
        // Only fill keys still holding the English that generate wrote.
        if (typeof value !== "string" || ownLocales.get(locale)![key] !== text) break;
        let next = value;
        for (const [name, literal] of candidate.used) {
          if (!next.includes(literal)) break;
          next = next.replaceAll(literal, `{${name}}`);
        }
        if (candidate.used.some(([name]) => !next.includes(`{${name}}`))) break;
        translated.set(locale, next);
      }
      if (translated.size === locales.length) {
        for (const [locale, value] of translated) ownLocales.get(locale)![key] = value;
        ported += 1;
      }
      break;
    }
  }
  for (const [locale, catalog] of ownLocales) {
    NodeFS.writeFileSync(
      NodePath.join(root, dir, `${locale}.json`),
      `${JSON.stringify(catalog, null, 2)}\n`,
    );
  }
  console.log(`${app}: ported ${ported}`);
}
