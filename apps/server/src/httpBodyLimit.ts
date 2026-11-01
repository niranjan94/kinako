import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

// Body readers buffer the whole request, and unauthenticated routes decode before any credential check.
export const UNAUTHENTICATED_MAX_BODY_SIZE = ByteSize.mebibytes(1);

export const layerUnauthenticatedBodyLimit = HttpRouter.middleware(
  (httpEffect) =>
    Effect.provideService(
      httpEffect,
      HttpIncomingMessage.MaxBodySize,
      UNAUTHENTICATED_MAX_BODY_SIZE,
    ),
  { global: true },
);

/** Lifts the unauthenticated body cap for a request that has already authenticated. */
export const withAuthenticatedBodyLimit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, HttpIncomingMessage.MaxBodySize, undefined);
