import { describe, expect, it } from "vite-plus/test";
import { defaultSandboxPaths } from "@t3tools/contracts";

import {
  addSandboxPath,
  effectiveSandboxPathList,
  withProjectSandbox,
} from "./SandboxSettings.logic";

describe("effectiveSandboxPathList", () => {
  it("shows the server platform's defaults for a null list and the list itself otherwise", () => {
    expect(effectiveSandboxPathList(null, "readOnlyPaths", "darwin")).toEqual({
      paths: defaultSandboxPaths("darwin").readOnlyPaths,
      usesDefaults: true,
    });
    expect(effectiveSandboxPathList([], "readWritePaths", "linux")).toEqual({
      paths: [],
      usesDefaults: false,
    });
  });
});

describe("addSandboxPath", () => {
  it("appends a trimmed path and refuses blanks and duplicates", () => {
    expect(addSandboxPath(["~/a"], "  ~/b ")).toEqual({ paths: ["~/a", "~/b"] });
    expect(addSandboxPath(["~/a"], "   ")).toEqual({ error: "Enter a path." });
    expect(addSandboxPath(["~/a"], "~/a")).toEqual({ error: "Already listed." });
  });
});

describe("withProjectSandbox", () => {
  it("keeps the project's other overrides and drops empty lists", () => {
    expect(
      withProjectSandbox(
        { defaultRuntimeMode: "auto", sandbox: { readWritePaths: ["~/old"] } },
        { readWritePaths: [], readOnlyPaths: ["~/docs"] },
      ),
    ).toEqual({ defaultRuntimeMode: "auto", sandbox: { readOnlyPaths: ["~/docs"] } });
  });

  it("clears the entry once nothing is left in it", () => {
    expect(withProjectSandbox({ sandbox: { readWritePaths: ["~/old"] } }, {})).toBeNull();
    expect(withProjectSandbox(undefined, { readWritePaths: ["~/x"] })).toEqual({
      sandbox: { readWritePaths: ["~/x"] },
    });
  });
});
