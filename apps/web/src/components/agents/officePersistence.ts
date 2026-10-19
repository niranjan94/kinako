import * as Schema from "effect/Schema";

export const OfficeRecord = Schema.Record(Schema.String, Schema.Unknown);
const Color = Schema.Struct({
  h: Schema.Finite,
  s: Schema.Finite,
  b: Schema.Finite,
  c: Schema.Finite,
  colorize: Schema.optional(Schema.Boolean),
});
const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }));
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const LayoutShape = Schema.Struct({
  version: Schema.Literal(1),
  cols: Dimension,
  rows: Dimension,
  tiles: Schema.Array(Schema.Literals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255])),
  furniture: Schema.Array(
    Schema.Struct({
      uid: Schema.String,
      type: Schema.String,
      col: Schema.Int,
      row: Schema.Int,
      color: Schema.optional(Color),
    }),
  ),
  layoutRevision: Schema.optional(Schema.Finite),
  tileColors: Schema.optional(Schema.Array(Schema.NullOr(Color))),
  pets: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, petType: Index }))),
  carpetTiles: Schema.optional(
    Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          variant: Index,
          color: Schema.optional(Color),
          accentColor: Schema.optional(Color),
          order: Schema.optional(Schema.Finite),
        }),
      ),
    ),
  ),
  areas: Schema.optional(
    Schema.Array(Schema.Struct({ label: Schema.String, color: Schema.String })),
  ),
  areaTiles: Schema.optional(Schema.Array(Schema.NullOr(Schema.String))),
});
const isLayoutShape = Schema.is(LayoutShape);

export function isOfficeLayout(value: unknown): value is typeof LayoutShape.Type {
  if (!isLayoutShape(value)) return false;
  const size = value.cols * value.rows;
  return (
    value.tiles.length === size &&
    [value.tileColors, value.carpetTiles, value.areaTiles].every(
      (tiles) => tiles === undefined || tiles.length === size,
    )
  );
}

// Preserve the package's layout fields when encoding; validate without stripping them.
export function officeLayoutOrDefault(value: unknown, fallback: Record<string, unknown>) {
  return isOfficeLayout(value) ? value : fallback;
}

export const OfficeSeats = Schema.Record(
  Schema.String,
  Schema.Struct({
    palette: Schema.optional(Schema.Number),
    hueShift: Schema.optional(Schema.Number),
    seatId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
export const SavedOffice = Schema.Struct({
  layout: Schema.NullOr(OfficeRecord),
  seats: OfficeSeats,
  settings: OfficeRecord,
  areas: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export const INITIAL_OFFICE: typeof SavedOffice.Type = {
  layout: null,
  seats: {},
  settings: {},
  areas: {},
};
