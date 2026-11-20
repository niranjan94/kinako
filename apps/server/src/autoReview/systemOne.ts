import type { TextGeneratorModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

/** Where a System One API is reached, with its key already read from wherever settings keep it. */
export interface SystemOneConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Names the API in errors, such as its label or host. */
  readonly label: string;
}

/** Why a System One call failed, worded for the person who configured it. */
export class SystemOneRequestError extends Schema.TaggedError<SystemOneRequestError>()(
  "SystemOneRequestError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export type SystemOneQuestion =
  | { readonly type: "noul"; readonly instructions: unknown; readonly criteria?: unknown }
  | {
      readonly type: "choice";
      readonly instructions: unknown;
      readonly criteria: Readonly<Record<string, unknown>>;
    };

const SystemOneAnswer = Schema.Struct({
  type: Schema.String,
  noul: Schema.optional(Schema.Number),
  choice: Schema.optional(Schema.String),
  confidence: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type SystemOneAnswer = typeof SystemOneAnswer.Type;

const SystemOneResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, SystemOneAnswer),
});

const ModelList = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) }),
  ),
});

const ErrorBody = Schema.Struct({ detail: Schema.Unknown });
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

const describeStatus = (label: string, status: number, detail: unknown) => {
  const reason =
    status === 401 || status === 403
      ? "rejected the API key"
      : status === 404
        ? "couldn't find that model or endpoint"
        : status === 429
          ? "is rate-limiting requests"
          : `returned HTTP ${status}`;
  const message = (typeof detail === "string" ? detail : "").trim().slice(0, 300);
  return `${label} ${reason}${message ? `: ${message}` : "."}`;
};

const endpoint = (connection: SystemOneConnection, path: string) =>
  `${connection.baseUrl.replace(/\/+$/, "")}${path}`;

const sendJson = Effect.fn("SystemOne.sendJson")(function* <S extends Schema.Top>(
  label: string,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) {
  const http = yield* HttpClient.HttpClient;
  const response: HttpClientResponse.HttpClientResponse = yield* http.execute(request).pipe(
    // A redirect could carry the key to another origin.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.mapError(
      (cause) =>
        new SystemOneRequestError({
          detail: `Couldn't reach ${label}. Check the base URL and your connection.`,
          cause,
        }),
    ),
  );
  const body = yield* response.json.pipe(Effect.orElseSucceed((): unknown => undefined));
  if (response.status < 200 || response.status >= 300) {
    const detail = decodeErrorBody(body).pipe((option) =>
      option._tag === "Some" ? option.value.detail : undefined,
    );
    return yield* new SystemOneRequestError({
      detail: describeStatus(label, response.status, detail),
    });
  }
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (cause) =>
        new SystemOneRequestError({
          detail: `${label} returned a reply that couldn't be read.`,
          cause,
        }),
    ),
  );
});

/** Asks every question about `state` in one request; answers come back under the same names. */
export const ask = Effect.fn("SystemOne.ask")(function* (
  connection: SystemOneConnection,
  model: string,
  state: unknown,
  questions: Readonly<Record<string, SystemOneQuestion>>,
  timeout: "8 seconds" | "25 seconds",
) {
  const request = HttpClientRequest.post(endpoint(connection, "/v1/systemone")).pipe(
    HttpClientRequest.bearerToken(connection.apiKey),
    HttpClientRequest.bodyJsonUnsafe({ model, state, questions }),
  );
  const response = yield* sendJson(connection.label, request, SystemOneResponse).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new SystemOneRequestError({ detail: `${connection.label} took too long to respond.` }),
        ),
    }),
  );
  return response.answers;
});

export const listModels = Effect.fn("SystemOne.listModels")(function* (
  connection: SystemOneConnection,
) {
  const request = HttpClientRequest.get(endpoint(connection, "/v1/models")).pipe(
    HttpClientRequest.bearerToken(connection.apiKey),
  );
  const response = yield* sendJson(connection.label, request, ModelList).pipe(
    Effect.timeoutOrElse({
      duration: "25 seconds",
      orElse: () =>
        Effect.fail(
          new SystemOneRequestError({ detail: `${connection.label} took too long to respond.` }),
        ),
    }),
  );
  const models: Array<TextGeneratorModel> = [];
  for (const entry of response.models) {
    const id = entry.name.trim();
    if (id) models.push({ id, name: id });
  }
  return models.toSorted((left, right) => left.id.localeCompare(right.id));
});
