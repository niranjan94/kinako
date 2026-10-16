import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  T3ProjectFile,
  T3_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_SCHEMA_URL,
} from "@t3tools/contracts";

import { FORK_PROJECT_FILE_NAME } from "./forkBrand.ts";
import { fromLenientJson } from "./schemaJson.ts";

/** Project file names in read order: the first one that exists is the project's file. */
export const PROJECT_FILE_NAMES = [FORK_PROJECT_FILE_NAME, T3_PROJECT_FILE_NAME] as const;

export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T3ProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: T3_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
