import { describe, expect, it } from "vite-plus/test";
import {
  workspaceRelativeFilePath,
  newProjectFolderName,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  relocatePathUnderRoot,
  resolveWorkspaceFilePath,
} from "./path.ts";

describe("path helpers", () => {
  // regression: #17923 literal colons in names are kept, not parsed as positions
  it.each([
    ["report:123", "/workspace", "/workspace/report:123"],
    ["src/file", "C:\\Workspace\\", "C:\\Workspace\\src\\file"],
    ["~/report:123", "/workspace", "~/report:123"],
  ])("resolves literal path %s within %s", (path, root, expected) => {
    expect(resolveWorkspaceFilePath(path, root)).toBe(expected);
  });

  it("normalizes a bare Windows drive root the same as one with a trailing separator", () => {
    expect(normalizeProjectPathForDispatch("C:")).toBe("C:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe("c:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:\\"));
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:/"));
    expect(normalizeProjectPathForDispatch("C:\\repo\\")).toBe("C:\\repo");
  });

  it("names a new project's folder from any typed name", () => {
    expect(newProjectFolderName("Pinball Stats")).toBe("pinball-stats");
    expect(newProjectFolderName("  Café & Crème!  ")).toBe("cafe-creme");
    expect(newProjectFolderName("../../etc")).toBe("etc");
    expect(newProjectFolderName("🎱🎱")).toBe("project");
    expect(newProjectFolderName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    expect(newProjectFolderName("Con")).toBe("con-project");
    expect(newProjectFolderName("LPT1")).toBe("lpt1-project");
    expect(newProjectFolderName("console")).toBe("console");
  });
});

describe("workspaceRelativeFilePath", () => {
  // regression: #9309 POSIX paths compare case-sensitively, Windows paths do not
  it.each([
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/repo/project-two/a.ts", "/repo/project", null],
    // regression: #16354 a `..` that leaves the root is a host path, not a workspace path
    ["/repo/project/../other/notes.md", "/repo/project", null],
    ["C:\\repo\\project\\src\\..\\..\\notes.md", "C:\\repo\\project", null],
    ["/repo/project/docs/a/../b.md", "/repo/project", "docs/a/../b.md"],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});

describe("relocatePathUnderRoot", () => {
  it.each([
    ["/a/proj", "/a/proj", "/b/moved", "/b/moved"],
    ["/a/proj/", "/a/proj", "/b/moved/", "/b/moved"],
    ["/a/proj/.wt/feature", "/a/proj", "/b/moved", "/b/moved/.wt/feature"],
    ["/a/proj-2/src", "/a/proj", "/b/moved", null],
    ["/a/project", "/a/proj", "/b/moved", null],
    ["/a/other", "/a/proj", "/b/moved", null],
    ["/A/Proj/src", "/a/proj", "/b/moved", null],
    ["/x/file", "/", "/root", "/root/x/file"],
    ["/a/proj/x", "/a/proj", "/", "/x"],
    ["C:\\Repos\\Proj\\wt", "c:\\repos\\proj", "D:\\New", "D:\\New\\wt"],
    ["C:/Repos/Proj/a/b", "C:\\Repos\\Proj", "D:\\New\\", "D:\\New\\a\\b"],
    ["C:\\Repos\\Proj-2", "C:\\Repos\\Proj", "D:\\New", null],
    ["\\\\Server\\Share\\Proj\\wt", "\\\\server\\share\\proj", "E:\\Proj", "E:\\Proj\\wt"],
  ])("relocates %s from %s to %s", (path, fromRoot, toRoot, expected) => {
    expect(relocatePathUnderRoot(path, fromRoot, toRoot)).toBe(expected);
  });

  it("folds case on case-insensitive filesystems only when asked", () => {
    expect(
      relocatePathUnderRoot("/Users/Me/Proj/wt", "/users/me/proj", "/b", {
        caseInsensitive: true,
      }),
    ).toBe("/b/wt");
    expect(
      relocatePathUnderRoot("/Users/Me/Proj-2", "/users/me/proj", "/b", {
        caseInsensitive: true,
      }),
    ).toBeNull();
  });
});
