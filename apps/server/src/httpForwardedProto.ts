import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";

const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

const forwardedProto = (request: HttpServerRequest.HttpServerRequest): string | undefined =>
  request.headers["x-forwarded-proto"]?.split(",")[0]?.trim().toLowerCase() || undefined;

/** True when a TLS-terminating proxy, such as a Cloudflare tunnel or Tailscale Serve, forwarded the request. */
export const isForwardedHttps = (request: HttpServerRequest.HttpServerRequest): boolean =>
  forwardedProto(request) === "https";

const httpsLocation = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const host = request.headers["x-forwarded-host"]?.split(",")[0]?.trim() || request.headers.host;
  if (!host) return undefined;
  try {
    return new URL(request.url, `https://${host}`).href;
  } catch {
    return undefined;
  }
};

// HSTS and the upgrade redirect are sent per response so the user's other sites on the zone are untouched.
export const layerForwardedHttps = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const proto = forwardedProto(request);
      if (proto === "http") {
        const location = httpsLocation(request);
        if (location) return HttpServerResponse.redirect(location, { status: 308 });
      }
      if (proto === "https") {
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(
            HttpServerResponse.setHeader(
              response,
              "strict-transport-security",
              STRICT_TRANSPORT_SECURITY,
            ),
          ),
        );
      }
      return yield* httpEffect;
    }),
  { global: true },
);
