import {
  type DecisionApiConfig,
  type ListDecisionApiModelsInput,
  type ListDecisionApiModelsResult,
  type ProviderInstanceId,
  TextGeneratorError,
  type TextGeneratorModel,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as SystemOne from "./systemOne.ts";

/** Decision model APIs configured in settings, used only to review approvals. */
export class DecisionApis extends Context.Service<
  DecisionApis,
  {
    /** Asks a saved decision API every question about `state` in one request. */
    readonly ask: (input: {
      readonly id: ProviderInstanceId;
      readonly model: string;
      readonly state: unknown;
      readonly questions: Readonly<Record<string, SystemOne.SystemOneQuestion>>;
    }) => Effect.Effect<
      Readonly<Record<string, SystemOne.SystemOneAnswer>>,
      SystemOne.SystemOneRequestError
    >;
    readonly listModels: (
      input: ListDecisionApiModelsInput,
    ) => Effect.Effect<ListDecisionApiModelsResult, TextGeneratorError>;
  }
>()("t3/autoReview/DecisionApis") {}

interface CachedModels {
  readonly config: DecisionApiConfig;
  readonly models: ReadonlyArray<TextGeneratorModel>;
}

const apiLabel = (config: DecisionApiConfig) => {
  if (config.label) return config.label;
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return "The decision API";
  }
};

/** @public */
export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const http = yield* HttpClient.HttpClient;
  const modelCache = yield* Ref.make(new Map<ProviderInstanceId, CachedModels>());
  // Settings already drop saved APIs under an allow-list; this stops unsaved ones too.
  const allowListed =
    settingsService.managedPolicy?.limits?.providers?.allowedDrivers !== undefined;

  const readConfig = Effect.fn("DecisionApis.readConfig")(function* (id: ProviderInstanceId) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new SystemOne.SystemOneRequestError({
            detail: "Couldn't read this environment's settings.",
          }),
      ),
    );
    return settings.decisionApis[id];
  });

  const connect = Effect.fn("DecisionApis.connect")(function* (config: DecisionApiConfig) {
    const apiKey = yield* requireSettingsSecret(secrets, config.apiKey).pipe(
      Effect.mapError(
        (cause) => new SystemOne.SystemOneRequestError({ detail: cause.message, cause }),
      ),
    );
    return {
      baseUrl: config.baseUrl,
      apiKey,
      label: apiLabel(config),
    } satisfies SystemOne.SystemOneConnection;
  });

  const ask: DecisionApis["Service"]["ask"] = Effect.fn("DecisionApis.ask")(function* (input) {
    const config = yield* readConfig(input.id);
    if (config === undefined || !config.enabled || allowListed) {
      return yield* new SystemOne.SystemOneRequestError({
        detail: "That decision API is off or no longer exists.",
      });
    }
    const connection = yield* connect(config);
    return yield* SystemOne.ask(
      connection,
      input.model,
      input.state,
      input.questions,
      "8 seconds",
    ).pipe(Effect.provideService(HttpClient.HttpClient, http));
  });

  const listModels: DecisionApis["Service"]["listModels"] = Effect.fn("DecisionApis.listModels")(
    function* (input) {
      if (allowListed) {
        return yield* new SystemOne.SystemOneRequestError({
          detail: "Your organization's provider policy turns off decision APIs.",
        });
      }
      const saved = yield* readConfig(input.id);
      const config =
        input.config === undefined
          ? saved
          : input.config.apiKey === SECRET_REDACTED
            ? // The saved key goes only to the endpoint it was saved for.
              {
                ...input.config,
                apiKey: saved?.baseUrl === input.config.baseUrl ? saved.apiKey : "",
              }
            : input.config;
      if (config === undefined) {
        return yield* new SystemOne.SystemOneRequestError({
          detail: "That decision API no longer exists.",
        });
      }
      const fresh = input.config !== undefined || input.test === true;
      const cached = (yield* Ref.get(modelCache)).get(input.id);
      if (
        !fresh &&
        input.refresh !== true &&
        cached !== undefined &&
        Equal.equals(cached.config, config)
      ) {
        return { models: cached.models };
      }
      const connection = yield* connect(config);
      const models = yield* SystemOne.listModels(connection).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      if (input.test === true) {
        const model = input.model ?? models[0]?.id;
        if (model === undefined) {
          return yield* new SystemOne.SystemOneRequestError({
            detail: `${connection.label} lists no models to test with.`,
          });
        }
        // Some APIs list models without checking the key; one question proves it.
        yield* SystemOne.ask(
          connection,
          model,
          "The sky is blue.",
          { check: { type: "noul", instructions: "Is this statement about the sky?" } },
          "25 seconds",
        ).pipe(Effect.provideService(HttpClient.HttpClient, http));
        return { models, testedModel: model };
      }
      yield* Ref.update(modelCache, (current) =>
        new Map(current).set(input.id, { config, models }),
      );
      return { models };
    },
    Effect.mapError((error) => new TextGeneratorError({ detail: error.detail })),
  );

  return DecisionApis.of({ ask, listModels });
});

export const layer = Layer.effect(DecisionApis, make).pipe(
  Layer.provide([SecretResolverLayer.layer, FetchHttpClient.layer]),
);
