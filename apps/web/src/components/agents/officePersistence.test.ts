import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import bundledLayout from "pixel-agents/dist/webview/assets/default-layout-1.json";
import {
  INITIAL_OFFICE,
  SavedOffice,
  isOfficeLayout,
  officeLayoutOrDefault,
} from "./officePersistence";

const layout = {
  version: 1,
  cols: 1,
  rows: 1,
  tiles: [1],
  furniture: [],
  pets: [{ id: "cat", petType: 0 }],
  tileColors: [{ h: 0, s: 0, b: 0, c: 0 }],
  carpetTiles: [{ variant: 0, color: { h: 0, s: 0, b: 0, c: 0 } }],
  areas: [{ label: "Work", color: "#112233" }],
  areaTiles: ["Work"],
};

describe("office persistence", () => {
  it("round trips a seating snapshot containing unseated characters", () => {
    const value = {
      ...INITIAL_OFFICE,
      layout,
      seats: {
        seated: { palette: 0, hueShift: 0, seatId: "chair" },
        unseated: { palette: 1, hueShift: 0, seatId: null },
      },
    };
    const codec = Schema.fromJsonString(SavedOffice);
    const restored = Schema.decodeSync(codec)(Schema.encodeSync(codec)(value));
    expect(restored).toEqual(value);
    expect(isOfficeLayout(restored.layout)).toBe(true);
  });

  it("accepts the package's default and layouts with all supported optional fields", () => {
    expect(isOfficeLayout(bundledLayout)).toBe(true);
    expect(isOfficeLayout(layout)).toBe(true);
    expect(isOfficeLayout({ version: 1, cols: 1, rows: 1, tiles: [1], furniture: [] })).toBe(true);
  });

  it.each([
    { pets: {} },
    { pets: [null] },
    { pets: [{ id: "cat", petType: -1 }] },
    { tileColors: "x" },
    { tileColors: [{ h: "red", s: 0, b: 0, c: 0 }] },
    { carpetTiles: {} },
    { carpetTiles: [{ variant: "bad" }] },
    { areas: [{}] },
    { areaTiles: [42] },
    { areaTiles: [] },
    { furniture: [{ uid: "desk", type: "desk", col: 0, row: 0, color: "red" }] },
    { tiles: [] },
    { rows: 65 },
  ])("rejects malformed imported fields: %j", (fields) => {
    expect(isOfficeLayout({ ...layout, ...fields })).toBe(false);
  });

  it("recovers from a previously persisted malformed layout without losing the fallback", () => {
    const poisoned = { ...layout, pets: {} };
    expect(officeLayoutOrDefault(poisoned, bundledLayout)).toBe(bundledLayout);
    expect(officeLayoutOrDefault(layout, bundledLayout)).toBe(layout);
  });
});
