import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest } from "effect/http";
import { HttpServerResponse } from "effect/http";

import {
  layerUnauthenticatedBodyLimit,
  UNAUTHENTICATED_MAX_BODY_SIZE,
  withAuthenticatedBodyLimit,
} from "./httpBodyLimit.ts";

const readBodyLength = (
  read: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap((request) => read(request.text)),
    Effect.map((text) => HttpServerResponse.text(String(text.length))),
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 413 })),
  );

const layerApp = Layer.mergeAll(
  HttpRouter.add(
    "POST",
    "/open",
    readBodyLength((effect) => effect),
  ),
  HttpRouter.add("POST", "/authenticated", readBodyLength(withAuthenticatedBodyLimit)),
  layerUnauthenticatedBodyLimit,
);

it.layer(
  HttpRouter.serve(layerApp, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
  ),
)("request body limit", (it) => {
  it.effect("caps unauthenticated bodies and lifts the cap after authentication", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const limit = ByteSize.toNumberUnsafe(UNAUTHENTICATED_MAX_BODY_SIZE);
      const post = (path: string, length: number) =>
        client.execute(
          HttpClientRequest.post(path).pipe(HttpClientRequest.bodyText("a".repeat(length))),
        );

      expect((yield* post("/open", limit)).status).toBe(200);
      // Node stops reading at the cap, so the client may see a closed socket instead of the 413.
      const rejected = yield* post("/open", limit + 1).pipe(
        Effect.map((response) => response.status),
        Effect.orElseSucceed(() => "closed"),
      );
      expect([413, "closed"]).toContain(rejected);
      const authenticated = yield* post("/authenticated", limit + 1);
      expect(authenticated.status).toBe(200);
      expect(yield* authenticated.text).toBe(String(limit + 1));
    }),
  );
});
