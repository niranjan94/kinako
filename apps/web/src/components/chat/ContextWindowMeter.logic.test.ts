import { describe, expect, it } from "vite-plus/test";
import { shouldReserveContextWindowMeter } from "./ContextWindowMeter.logic";

describe("shouldReserveContextWindowMeter", () => {
  const loadingStartedThread = {
    meterEnabled: true,
    detailLoading: true,
    providerReportsContextWindow: true,
  };

  it("holds the meter's slot while a started thread's detail loads", () => {
    expect(shouldReserveContextWindowMeter(loadingStartedThread)).toBe(true);
  });

  it("reserves while the thread's provider is not in the catalog yet", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: null,
      }),
    ).toBe(true);
  });
});
