import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerResponse,
} from "effect/http";

import { layerForwardedHttps } from "./httpForwardedProto.ts";

const layerApp = Layer.merge(
  HttpRouter.add("POST", "/api/auth/browser-session", HttpServerResponse.text("ok")),
  layerForwardedHttps,
);

it.layer(
  HttpRouter.serve(layerApp, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
  ),
)("forwarded HTTPS", (it) => {
  it.effect("upgrades proxied plain HTTP and pins proxied HTTPS", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const post = (headers: Record<string, string>) =>
        client
          .execute(
            HttpClientRequest.post("/api/auth/browser-session?next=1").pipe(
              HttpClientRequest.setHeaders(headers),
            ),
          )
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

      const insecure = yield* post({
        "x-forwarded-proto": "http",
        "x-forwarded-host": "kn-example.example.com",
      });
      expect(insecure.status).toBe(308);
      expect(insecure.headers.location).toBe(
        "https://kn-example.example.com/api/auth/browser-session?next=1",
      );

      const secure = yield* post({ "x-forwarded-proto": "https" });
      expect(secure.status).toBe(200);
      expect(secure.headers["strict-transport-security"]).toBe("max-age=31536000");

      const direct = yield* post({});
      expect(direct.status).toBe(200);
      expect(direct.headers["strict-transport-security"]).toBeUndefined();
    }),
  );
});
