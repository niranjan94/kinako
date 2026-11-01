import { PublicRouteHostname } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makePublicRouteHostname } from "./cloudflarePublicRoute.ts";

const isPublicRouteHostname = Schema.is(PublicRouteHostname);

describe("makePublicRouteHostname", () => {
  it("encodes 128 bits as one kn- label the contract accepts", () => {
    const hostname = makePublicRouteHostname("Example.COM", new Uint8Array(16).fill(255));
    expect(hostname).toBe(`kn-${"7".repeat(25)}4.example.com`);
    expect(isPublicRouteHostname(hostname)).toBe(true);
    expect(
      makePublicRouteHostname(
        "example.com",
        Uint8Array.from({ length: 16 }, (_, i) => i),
      ),
    ).toBe("kn-aaaqeayeaudaocajbifqydiob4.example.com");
  });
});
