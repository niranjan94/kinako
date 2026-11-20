import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SYSTEM_ONE_BASE_URL,
  type DecisionApiConfig,
  type EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  type TextGeneratorModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "./providerInstances";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./state/query";
import { serverEnvironment } from "./state/server";

export const SYSTEM_ONE_BASE_URL = DEFAULT_SYSTEM_ONE_BASE_URL;
export const SYSTEM_ONE_NAME = "System One";

export function decisionApiDisplayName(config: Pick<DecisionApiConfig, "label">): string {
  return config.label ?? SYSTEM_ONE_NAME;
}

type ModelsKey = readonly [
  environmentId: EnvironmentId,
  id: ProviderInstanceId,
  baseUrl: string,
  apiKey: DecisionApiConfig["apiKey"],
];

const refreshCountAtom = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`decision-api-refresh:${key}`)),
);

const decisionApiModelsAtom = Atom.family((key: string) => {
  const [environmentId, id] = JSON.parse(key) as ModelsKey;
  return Atom.make((get) => {
    get(refreshCountAtom(`${environmentId}:${id}`));
    return serverEnvironment.listDecisionApiModels
      .run(get.registry, { environmentId, input: { id } })
      .pipe(
        Effect.map((result) => result.models),
        Effect.catchCause((cause) => Effect.fail(formatEnvironmentQueryError(cause))),
      );
  }).pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(`decision-api-models:${key}`));
});

const decisionApiCatalogAtom = Atom.family((keys: string) =>
  Atom.make((get) =>
    (JSON.parse(keys) as ReadonlyArray<string>).map((key) => get(decisionApiModelsAtom(key))),
  ).pipe(Atom.withLabel(`decision-api-catalog:${keys}`)),
);

/** Has open pickers ask again; a changed key is invisible to the cache key behind its redaction. */
export function rereadDecisionApiModels(environmentId: EnvironmentId, id: ProviderInstanceId) {
  const atom = refreshCountAtom(`${environmentId}:${id}`);
  appAtomRegistry.set(atom, appAtomRegistry.get(atom) + 1);
}

/** Lists the models unsaved settings reach and has one answer a question, before saving. */
export async function checkDecisionApiConfig(
  environmentId: EnvironmentId,
  id: ProviderInstanceId,
  config: DecisionApiConfig,
): Promise<
  | {
      readonly models: ReadonlyArray<TextGeneratorModel>;
      readonly testedModel: string | undefined;
    }
  | { readonly error: string }
> {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.listDecisionApiModels,
    { environmentId, input: { id, config, test: true } },
    { reportFailure: false },
  );
  return result._tag === "Success"
    ? { models: result.value.models, testedModel: result.value.testedModel }
    : { error: formatEnvironmentQueryError(result.cause) };
}

function decisionApiSnapshot(
  id: ProviderInstanceId,
  config: DecisionApiConfig,
  result: AsyncResult.AsyncResult<ReadonlyArray<TextGeneratorModel>, string>,
  selectedModels: ReadonlyArray<string>,
): ServerProvider {
  const discovered = AsyncResult.isSuccess(result)
    ? result.value.map((model): ServerProviderModel => ({
        slug: model.id,
        name: model.name,
        isCustom: false,
        capabilities: null,
      }))
    : [];
  const missing = [...new Set(selectedModels)]
    .filter((slug) => !discovered.some((model) => model.slug === slug))
    .map((slug): ServerProviderModel => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    }));
  const failure = Option.getOrUndefined(AsyncResult.error(result));
  return {
    instanceId: id,
    driver: ProviderDriverKind.make(config.kind),
    displayName: decisionApiDisplayName(config),
    supportsTextGeneration: true,
    enabled: config.enabled,
    installed: true,
    version: null,
    status: failure === undefined ? "ready" : "error",
    ...(failure === undefined ? {} : { message: failure }),
    auth: { status: "unknown" },
    checkedAt: new Date(0).toISOString(),
    models: [...discovered, ...missing],
    slashCommands: [],
    skills: [],
  };
}

/**
 * Picker stand-ins for the environment's enabled decision APIs. They are only offered where a
 * decision is wanted, never where prose is written.
 */
export function useDecisionApiTargets(input: {
  readonly environmentId: EnvironmentId | null;
  readonly settings: Pick<ServerSettings, "decisionApis">;
  readonly selections: ReadonlyArray<ModelSelection | null | undefined>;
}): {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
} {
  const { environmentId } = input;
  const apis =
    environmentId === null
      ? []
      : (
          Object.entries(input.settings.decisionApis) as Array<
            [ProviderInstanceId, DecisionApiConfig]
          >
        )
          .filter(([, config]) => config.enabled)
          .map(([id, config]) => ({
            id,
            config,
            key: JSON.stringify([
              environmentId,
              id,
              config.baseUrl,
              config.apiKey,
            ] satisfies ModelsKey),
          }));
  const results = useAtomValue(decisionApiCatalogAtom(JSON.stringify(apis.map((api) => api.key))));
  const providers = apis.map(({ id, config }, index) =>
    decisionApiSnapshot(
      id,
      config,
      results[index] ?? AsyncResult.initial(),
      input.selections.flatMap((selection) =>
        selection?.instanceId === id && selection.model ? [selection.model] : [],
      ),
    ),
  );
  return { providers, entries: deriveProviderInstanceEntries(providers) };
}
