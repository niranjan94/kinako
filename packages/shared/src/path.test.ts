import { describe, expect, it } from "vite-plus/test";
import {
  fileBasename,
  workspaceRelativeFilePath,
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  newProjectFolderName,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  relocatePathUnderRoot,
  resolveWorkspaceFilePath,
} from "./path.ts";

describe("path helpers", () => {
  it.each([
    ["report:123", "/workspace", "/workspace/report:123"],
    ["/workspace/report:12:3", "/other", "/workspace/report:12:3"],
    ["src/file", "C:\\Workspace\\", "C:\\Workspace\\src\\file"],
    ["C:/Workspace/file", "/other", "C:/Workspace/file"],
    ["file", "\\\\host\\share\\", "\\\\host\\share\\file"],
    ["file", "/", "/file"],
    ["~/report:123", "/workspace", "~/report:123"],
  ])("resolves literal path %s within %s", (path, root, expected) => {
    expect(resolveWorkspaceFilePath(path, root)).toBe(expected);
  });

  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
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

describe("fileBasename", () => {
  it.each([
    ["/tmp/favicons/", "favicons"],
    ["C:\\Users\\kelchm\\.claude\\", ".claude"],
    ["/tmp/", "tmp"],
    ["AGENTS.md", "AGENTS.md"],
    ["/", "/"],
  ])("labels %s as %s", (path, basename) => {
    expect(fileBasename(path)).toBe(basename);
  });
});

describe("workspaceRelativeFilePath", () => {
  it.each([
    ["/repo/project/src/main.ts", "/repo/project", "src/main.ts"],
    ["/repo/project/src/main.ts", "/repo/project/", "src/main.ts"],
    ["C:\\Users\\mike\\t3code\\apps\\web\\a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/C:/Users/mike/t3code/apps/web/a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["/tmp/case/project/probe.txt", "/tmp/case/Project", null],
    ["//tmp/case/project/probe.txt", "//tmp/case/Project", null],
    ["/tmp/case/Project/probe.txt", "/tmp/case/Project", "probe.txt"],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/C:/USERS/mike/t3code/main.ts", "/c:/users/MIKE/t3code", "main.ts"],
    ["\\\\server\\share\\PROJECT\\main.ts", "\\\\Server\\Share\\Project", "main.ts"],
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/main.ts", "c:/", "Users/MIKE/main.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts ", "/tmp/repo", "file.ts "],
    ["/tmp/report.ts", "/repo/project", null],
    ["/repo/project-two/a.ts", "/repo/project", null],
    ["/repo/project/a.ts", undefined, null],
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
