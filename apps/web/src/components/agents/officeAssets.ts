const BASE = "/pixel-office/";

type Sprite = string[][];
interface CatalogEntry {
  id: string;
  furniturePath: string;
  width: number;
  height: number;
}
interface AssetIndex {
  characters: string[];
  floors: string[];
  walls: string[];
  defaultLayout: string;
}

async function json<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { signal });
  if (!response.ok) throw new Error(`Could not load office asset ${path} (${response.status}).`);
  return response.json();
}

async function sheet(path: string, signal: AbortSignal) {
  const response = await fetch(`${BASE}${path}`, { signal });
  if (!response.ok) throw new Error(`Could not load office sprite ${path}.`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("The office needs Canvas 2D support.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width } = context.getImageData(0, 0, canvas.width, canvas.height);
  return (x: number, y: number, w: number, h: number): Sprite =>
    Array.from({ length: h }, (_, row) =>
      Array.from({ length: w }, (_, col) => {
        const offset = ((y + row) * width + x + col) * 4;
        const alpha = data[offset + 3]!;
        if (alpha < 2) return "";
        const hex = (value: number) => value.toString(16).padStart(2, "0");
        return `#${hex(data[offset]!)}${hex(data[offset + 1]!)}${hex(data[offset + 2]!)}${alpha === 255 ? "" : hex(alpha)}`;
      }),
    );
}

export async function loadOfficeAssets(signal: AbortSignal) {
  const [index, catalog, extras] = await Promise.all([
    json<AssetIndex>("assets/asset-index.json", signal),
    json<CatalogEntry[]>("assets/furniture-catalog.json", signal),
    json<{ carpets: string[]; pets: string[] }>("extras.json", signal),
  ]);
  const [characters, floors, walls, carpets, furniture, pets, layout] = await Promise.all([
    Promise.all(
      index.characters.map(async (file) => {
        const sprite = await sheet(`assets/characters/${file}`, signal);
        const frames = (row: number) =>
          Array.from({ length: 7 }, (_, frame) => sprite(frame * 16, row * 32, 16, 32));
        return { down: frames(0), up: frames(1), right: frames(2) };
      }),
    ),
    Promise.all(
      index.floors.map(async (file) =>
        (await sheet(`assets/floors/${file}`, signal))(0, 0, 16, 16),
      ),
    ),
    Promise.all(
      index.walls.map(async (file) => {
        const sprite = await sheet(`assets/walls/${file}`, signal);
        return Array.from({ length: 16 }, (_, mask) =>
          sprite((mask % 4) * 16, Math.floor(mask / 4) * 32, 16, 32),
        );
      }),
    ),
    Promise.all(
      extras.carpets.map(async (file) => {
        const sprite = await sheet(file, signal);
        return Array.from({ length: 16 }, (_, mask) =>
          sprite((mask % 4) * 16, Math.floor(mask / 4) * 16, 16, 16),
        );
      }),
    ),
    Promise.all(
      catalog.map(
        async (entry) =>
          [
            entry.id,
            (await sheet(`assets/${entry.furniturePath}`, signal))(0, 0, entry.width, entry.height),
          ] as const,
      ),
    ),
    Promise.all(
      extras.pets.map(async (file) => {
        const manifest = await json<{ name: string }>(file, signal);
        const sprite = await sheet(file.replace("manifest.json", "pet.png"), signal);
        const frames = (y: number, x = 0, width = 16) =>
          Array.from({ length: 3 }, (_, frame) => sprite(x + frame * width, y, width, 32));
        return {
          name: manifest.name,
          frames: {
            walkDown: frames(0),
            idleDown: frames(0, 48),
            walkUp: frames(32),
            idleUp: frames(32, 48),
            walkRight: frames(64, 0, 32),
          },
        };
      }),
    ),
    json<Record<string, unknown>>(`assets/${index.defaultLayout}`, signal),
  ]);
  return {
    layout,
    messages: [
      { type: "characterSpritesLoaded", characters },
      { type: "floorTilesLoaded", sprites: floors },
      { type: "wallTilesLoaded", sets: walls },
      { type: "carpetTilesLoaded", sets: carpets },
      {
        type: "petSpritesLoaded",
        pets: pets.map((pet) => pet.frames),
        petNames: pets.map((pet) => pet.name),
      },
      { type: "furnitureAssetsLoaded", catalog, sprites: Object.fromEntries(furniture) },
    ],
  };
}
