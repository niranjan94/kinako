import { it } from "@effect/vitest";
import { type DecisionApiConfig, ProviderInstanceId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as DecisionApis from "./DecisionApis.ts";

const ID = ProviderInstanceId.make("jev");

const layer = (api: Partial<DecisionApiConfig>) =>
  Layer.effect(DecisionApis.DecisionApis, DecisionApis.make).pipe(
    Layer.provideMerge(
      ServerSettings.layerTest({
        decisionApis: { [ID]: { kind: "systemOne", baseUrl: "https://api.test", ...api } },
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
  );

const questions = { safe: { type: "noul" as const, instructions: "Is this safe?" } };

it.effect("asks every question in one System One request and reads the typed answers", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/v1/systemone");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "jev-latest",
        state: { command: "ls" },
        questions,
      });
      return Response.json({
        model: "jev-2026-09-15",
        answers: { safe: { type: "noul", noul: 0.97 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    });
    const apis = yield* DecisionApis.DecisionApis.pipe(Effect.provide(layer({ apiKey: "secret" })));
    const ask = apis
      .ask({ id: ID, model: "jev-latest", state: { command: "ls" }, questions })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(yield* ask).toEqual({ safe: { type: "noul", noul: 0.97 } });

    upstream.mockResolvedValueOnce(Response.json({ detail: "Invalid API key" }, { status: 401 }));
    expect((yield* Effect.flip(ask)).detail).toMatch(/rejected the API key: Invalid API key$/);
  }),
);

it.effect("a turned-off decision API fails instead of calling it", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>();
    const apis = yield* DecisionApis.DecisionApis.pipe(Effect.provide(layer({ enabled: false })));
    const failure = yield* Effect.flip(
      apis
        .ask({ id: ID, model: "jev-latest", state: "", questions })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.detail).toBe("That decision API is off or no longer exists.");
    expect(upstream).not.toHaveBeenCalled();
  }),
);

it.effect("a test lists models and proves the key with one question", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url) =>
      new URL(String(url)).pathname === "/v1/models"
        ? Response.json({
            models: [{ name: "jev-latest", description: "General", release_date: "2026-09-15" }],
          })
        : Response.json({
            model: "jev-latest",
            answers: { check: { type: "noul", noul: 0.9 } },
            usage: { input_tokens: 5, output_tokens: 1 },
          }),
    );
    const apis = yield* DecisionApis.DecisionApis.pipe(Effect.provide(layer({ apiKey: "secret" })));
    const result = yield* apis
      .listModels({ id: ID, test: true })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(result).toEqual({
      models: [{ id: "jev-latest", name: "jev-latest" }],
      testedModel: "jev-latest",
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  }),
);
