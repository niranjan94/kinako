// @effect-diagnostics nodeBuiltinImport:off - Vite packages dependency assets before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { Plugin } from "vite-plus";

const require = NodeModule.createRequire(import.meta.url);
const packageRoot = NodePath.dirname(require.resolve("pixel-agents/package.json"));
const prefix = "/pixel-office/";

export function pixelOfficePlugin(): Plugin {
  const root = NodePath.join(packageRoot, "dist/webview");
  const files = new Map<string, Buffer>();
  for (const entry of NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = NodePath.join(entry.parentPath, entry.name);
    files.set(path.slice(root.length + 1).replaceAll("\\", "/"), NodeFS.readFileSync(path));
  }
  const html = files.get("index.html");
  if (!html) throw new Error("Pixel Agents package is missing its office frontend.");
  files.set(
    "index.html",
    Buffer.from(
      html.toString().replace("<head>", '<head><script src="./kinako-host.js"></script>'),
    ),
  );
  // The bundled office has ten empty rows above the rooms. Trim that padding
  // so its initial camera centers the furniture inside an embedded viewport.
  const index = JSON.parse(files.get("assets/asset-index.json")!.toString()) as {
    defaultLayout: string;
  };
  const layoutPath = `assets/${index.defaultLayout}`;
  const layout = JSON.parse(files.get(layoutPath)!.toString()) as {
    cols: number;
    rows: number;
    tiles: number[];
    tileColors: unknown[];
    furniture: { row: number; [key: string]: unknown }[];
  };
  const firstOccupiedRow = Math.floor(layout.tiles.findIndex((tile) => tile !== 255) / layout.cols);
  const trim = Math.max(0, firstOccupiedRow - 1);
  if (trim > 0) {
    files.set(
      layoutPath,
      Buffer.from(
        JSON.stringify({
          ...layout,
          rows: layout.rows - trim,
          tiles: layout.tiles.slice(trim * layout.cols),
          tileColors: layout.tileColors.slice(trim * layout.cols),
          furniture: layout.furniture.map((item) => ({ ...item, row: item.row - trim })),
        }),
      ),
    );
  }
  files.set("LICENSE", NodeFS.readFileSync(NodePath.join(packageRoot, "LICENSE")));
  files.set(
    "extras.json",
    Buffer.from(
      JSON.stringify({
        carpets: [...files.keys()]
          .filter((path) => /^assets\/carpets\/carpet_\d+\.png$/.test(path))
          .sort(),
        pets: [...files.keys()]
          .filter((path) => /^assets\/pets\/[^/]+\/manifest.json$/.test(path))
          .sort(),
      }),
    ),
  );
  const contentType = (path: string) => {
    if (path.endsWith(".html")) return "text/html";
    if (path.endsWith(".js")) return "text/javascript";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".woff2")) return "font/woff2";
    return "application/octet-stream";
  };
  return {
    name: "kinako:pixel-office",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        if (!path?.startsWith(prefix)) return next();
        const file = files.get(path.slice(prefix.length));
        if (!file) return next();
        res.setHeader("Content-Type", contentType(path));
        res.end(file);
      });
    },
    generateBundle() {
      for (const [path, source] of files) {
        this.emitFile({ type: "asset", fileName: `pixel-office/${path}`, source });
      }
    },
  };
}
