#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This is a build-time filesystem script.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  FORK_DISPLAY_NAME,
  FORK_MARK_BRANCH_PATH,
  FORK_MARK_STEM_PATH,
  FORK_MARK_VIEWBOX,
} from "@t3tools/shared/forkBrand";
import sharp from "sharp";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveWebIconOverrides,
} from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodePath.join(import.meta.dirname, "..");
const appleCanvas = 1024;
const macBodySize = 824;
const androidCanvas = 432;
const androidSplashCanvas = 1152;

const variants = [
  {
    brand: "development",
    name: "dev",
    project: BRAND_ASSET_PATHS.developmentIconComposerProject,
    ios: BRAND_ASSET_PATHS.developmentIosIconPng,
    mac: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
    ico: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    colors: { light: "#365D8F", dark: "#14243D", edge: "#AFD5FF" },
  },
  {
    brand: "nightly",
    name: "nightly",
    project: BRAND_ASSET_PATHS.nightlyIconComposerProject,
    ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
    mac: BRAND_ASSET_PATHS.nightlyMacIconPng,
    universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    ico: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    colors: { light: "#30274E", dark: "#151223", edge: "#B5A0D6" },
  },
  {
    brand: "production",
    name: "prod",
    project: BRAND_ASSET_PATHS.productionIconComposerProject,
    ios: BRAND_ASSET_PATHS.productionIosIconPng,
    mac: BRAND_ASSET_PATHS.productionMacIconPng,
    universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
    ico: BRAND_ASSET_PATHS.productionWindowsIconIco,
    colors: { light: "#3B291F", dark: "#201611", edge: "#D4A47E" },
  },
] as const;

type Variant = (typeof variants)[number];
type Outputs = Map<string, Buffer | string>;

const svg = (contents: string, viewBox = "0 0 128 128", size = 128) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">
${contents}
</svg>
`;

const colorMark = `  <g transform="translate(1 0)">
    <path fill="#F8E6BF" d="${FORK_MARK_STEM_PATH}"/>
    <path fill="#D99759" d="${FORK_MARK_BRANCH_PATH}"/>
  </g>`;
const monoMark = (color: string) =>
  `  <path fill="${color}" d="${FORK_MARK_STEM_PATH} ${FORK_MARK_BRANCH_PATH}"/>`;

function background(variant: Variant) {
  const { light, dark } = variant.colors;
  const grid =
    variant.name === "dev"
      ? `  <defs>
    <pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse">
      <path d="M0 16V0H16" fill="none" stroke="#DDF7FF" stroke-width=".65" opacity=".32"/>
    </pattern>
  </defs>
  <rect width="128" height="128" fill="url(#grid)"/>`
      : "";

  return `  <defs>
    <linearGradient id="background" x1="12" y1="4" x2="108" y2="128" gradientUnits="userSpaceOnUse">
      <stop stop-color="${light}"/>
      <stop offset="1" stop-color="${dark}"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" fill="url(#background)"/>${grid ? `\n${grid}` : ""}`;
}

function roundedIcon(variant: Variant, backdrop: string) {
  return svg(`  <title>${FORK_DISPLAY_NAME}</title>
  <defs>
    <clipPath id="corners">
      <rect width="128" height="128" rx="28"/>
    </clipPath>
  </defs>
  <g clip-path="url(#corners)">
${backdrop}
    <rect x=".5" y=".5" width="127" height="127" rx="27.5" fill="none" stroke="${variant.colors.edge}" stroke-opacity=".22"/>
  </g>
${colorMark}`);
}

function render(markup: string, size: number) {
  return sharp(Buffer.from(markup), { density: Math.max(72, (size / 128) * 72) }).resize(
    size,
    size,
  );
}

async function renderMacIcon(rounded: string) {
  const inset = (appleCanvas - macBodySize) / 2;
  const body = await render(rounded, macBodySize).png().toBuffer();
  const shadowShape = svg(
    `  <rect x="${inset}" y="${inset + 12}" width="${macBodySize}" height="${macBodySize}" rx="180.25" fill="black" fill-opacity=".32"/>`,
    `0 0 ${appleCanvas} ${appleCanvas}`,
    appleCanvas,
  );
  const shadow = await sharp(Buffer.from(shadowShape)).blur(17).png().toBuffer();
  return sharp(shadow)
    .composite([{ input: body, top: inset, left: inset }])
    .png()
    .toBuffer();
}

async function exportApplicationIcons(outputs: Outputs, variant: Variant) {
  const backdrop = background(variant);
  const rounded = roundedIcon(variant, backdrop);
  const ios = svg(`${backdrop}\n${colorMark}`);
  const pngSizes = [...WINDOWS_ICON_SIZES, 192, 512, appleCanvas] as const;
  const png = new Map(
    await Promise.all(
      pngSizes.map(async (size) => [size, await render(rounded, size).png().toBuffer()] as const),
    ),
  );
  const ico = encodePngIco(WINDOWS_ICON_SIZES.map((size) => ({ size, contents: png.get(size)! })));
  const mac = await renderMacIcon(rounded);
  const iosImage = await render(ios, appleCanvas).removeAlpha().png().toBuffer();

  outputs.set(variant.ios, iosImage);
  outputs.set(variant.mac, mac);
  outputs.set(variant.universal, png.get(appleCanvas)!);
  outputs.set(variant.ico, ico);
  outputs.set(`${variant.project}/Assets/text.svg`, svg(colorMark));
  outputs.set(`${variant.project}/Assets/background.svg`, svg(backdrop));

  const webRenditions = {
    "favicon.ico": ico,
    "favicon-16x16.png": png.get(16)!,
    "favicon-32x32.png": png.get(32)!,
    "apple-touch-icon.png": await render(ios, 180).removeAlpha().png().toBuffer(),
    "icon-192x192.png": png.get(192)!,
    "icon-512x512.png": png.get(512)!,
  };

  for (const { sourceRelativePath, targetRelativePath } of resolveWebIconOverrides(
    variant.brand,
    "",
  )) {
    const name = NodePath.basename(targetRelativePath) as keyof typeof webRenditions;
    outputs.set(sourceRelativePath, webRenditions[name]);
  }

  if (variant.brand === "production") {
    outputs.set("assets/prod/logo.svg", rounded);
    for (const name of [
      "favicon.ico",
      "favicon-16x16.png",
      "favicon-32x32.png",
      "apple-touch-icon.png",
    ] as const) {
      outputs.set(`apps/marketing/public/${name}`, webRenditions[name]);
    }
    outputs.set(
      "apps/marketing/src/assets/icon.webp",
      await sharp(mac).webp({ lossless: true }).toBuffer(),
    );
  }
  if (variant.brand === "nightly") {
    outputs.set(
      "apps/marketing/src/assets/icon-nightly.webp",
      await sharp(mac).webp({ lossless: true }).toBuffer(),
    );
  }
}

async function exportAndroidIcons(outputs: Outputs) {
  const directory = "apps/mobile/assets";
  // Android masks the center 72dp of the 108dp canvas. Keep the mark in that area.
  const adaptiveViewBox = "-16 -16 160 160";
  const foreground = svg(colorMark, adaptiveViewBox);
  const splashMark = await render(foreground, androidSplashCanvas).png().toBuffer();
  outputs.set(
    `${directory}/android-icon-foreground.png`,
    await render(foreground, androidCanvas).png().toBuffer(),
  );
  outputs.set(
    `${directory}/android-icon-mark.png`,
    await render(svg(monoMark("white"), adaptiveViewBox), androidCanvas)
      .png()
      .toBuffer(),
  );
  outputs.set(
    `${directory}/android-notification-icon.png`,
    await render(svg(monoMark("white"), FORK_MARK_VIEWBOX), 96)
      .png()
      .toBuffer(),
  );

  for (const variant of variants) {
    const backdrop = svg(background(variant));
    outputs.set(
      `${directory}/android-icon-background-${variant.name}.png`,
      await render(backdrop, androidCanvas).png().toBuffer(),
    );
    outputs.set(
      `${directory}/android-splash-icon-${variant.name}.png`,
      await render(backdrop, androidSplashCanvas)
        .composite([{ input: splashMark }])
        .png()
        .toBuffer(),
    );
  }
}

async function exportBrandIcons(check: boolean, androidOnly: boolean) {
  const outputs: Outputs = new Map();
  if (!androidOnly) {
    for (const variant of variants) {
      await exportApplicationIcons(outputs, variant);
    }
    for (const { sourceRelativePath, targetRelativePath } of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
      outputs.set(targetRelativePath, outputs.get(sourceRelativePath)!);
    }
    outputs.set(
      "apps/mobile/assets/widget/T3Mark.svg",
      svg(monoMark("black"), FORK_MARK_VIEWBOX, 80),
    );
  }
  await exportAndroidIcons(outputs);

  if (check) {
    const stale: string[] = [];
    for (const [relativePath, contents] of outputs) {
      const generated = typeof contents === "string" ? Buffer.from(contents) : contents;
      const current = await NodeFSP.readFile(NodePath.join(root, relativePath)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (!current?.equals(generated)) stale.push(relativePath);
    }
    if (stale.length > 0) {
      throw new Error(`Generated brand assets are stale:\n${stale.join("\n")}`);
    }
    process.stdout.write(`Verified ${outputs.size} brand assets.\n`);
    return;
  }

  const temporaryDirectory = await NodeFSP.mkdtemp(NodePath.join(root, ".kinako-icon-export-"));
  try {
    const staged = [...outputs.entries()].map(([relativePath, contents], index) => ({
      path: NodePath.join(temporaryDirectory, String(index)),
      destination: NodePath.join(root, relativePath),
      contents,
    }));
    await Promise.all(staged.map(({ path, contents }) => NodeFSP.writeFile(path, contents)));
    for (const { path, destination } of staged) {
      await NodeFSP.rename(path, destination);
    }
  } finally {
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
  }
  process.stdout.write(`Wrote ${outputs.size} brand assets.\n`);
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      check: { type: "boolean" },
      "android-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write("Usage: node scripts/export-brand-icons.ts [--check] [--android-only]\n");
  } else {
    await exportBrandIcons(values.check ?? false, values["android-only"] ?? false);
  }
}
