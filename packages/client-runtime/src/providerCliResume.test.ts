import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ThreadShellNativeThread,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderCliResumeCommand } from "./providerCliResume.ts";

function nativeThread(
  driver: string,
  overrides: Partial<OrchestrationV2ThreadShellNativeThread> = {},
): OrchestrationV2ThreadShellNativeThread {
  return {
    providerInstanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    nativeId: "313e3168-da32-4d75-b890-d27f8afa84fc",
    conversationHeadId: null,
    ...overrides,
  };
}

function instance(driver: string, input: Partial<ProviderInstanceConfig>): ProviderInstanceConfig {
  return { driver: ProviderDriverKind.make(driver), ...input };
}

describe("buildProviderCliResumeCommand", () => {
  it("resumes a Claude session from its working directory", () => {
    expect(
      buildProviderCliResumeCommand({
        nativeThread: nativeThread("claudeAgent"),
        cwd: "/Users/me/my project",
        platform: "darwin",
        instance: undefined,
      }),
    ).toBe("cd '/Users/me/my project' && claude --resume 313e3168-da32-4d75-b890-d27f8afa84fc");
  });

  it("uses the instance's binary and Claude config directory", () => {
    expect(
      buildProviderCliResumeCommand({
        nativeThread: nativeThread("claudeAgent"),
        cwd: "/srv/app",
        platform: "linux",
        instance: instance("claudeAgent", {
          config: { binaryPath: "/opt/claude/bin/claude", homePath: "~/.claude-work" },
        }),
      }),
    ).toBe(
      "cd /srv/app && CLAUDE_CONFIG_DIR=~/'.claude-work' /opt/claude/bin/claude --resume 313e3168-da32-4d75-b890-d27f8afa84fc",
    );
  });

  it("falls back to a CLAUDE_CONFIG_DIR set in the instance environment", () => {
    expect(
      buildProviderCliResumeCommand({
        nativeThread: nativeThread("claudeAgent"),
        cwd: "/srv/app",
        platform: "linux",
        instance: instance("claudeAgent", {
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/data/claude", sensitive: false }],
        }),
      }),
    ).toBe(
      "cd /srv/app && CLAUDE_CONFIG_DIR=/data/claude claude --resume 313e3168-da32-4d75-b890-d27f8afa84fc",
    );
  });

  it("does not offer a Claude session that has a pending rollback", () => {
    expect(
      buildProviderCliResumeCommand({
        nativeThread: nativeThread("claudeAgent", { conversationHeadId: "message-1" }),
        cwd: "/srv/app",
        platform: "linux",
        instance: undefined,
      }),
    ).toBeNull();
  });

  it("resumes Codex in the shadow home the thread ran in", () => {
    expect(
      buildProviderCliResumeCommand({
        nativeThread: nativeThread("codex", { nativeId: "019a2b3c-codex" }),
        cwd: "/srv/app",
        platform: "darwin",
        instance: instance("codex", {
          config: { homePath: "~/.codex", shadowHomePath: "~/.codex-t3/personal" },
        }),
      }),
    ).toBe("cd /srv/app && CODEX_HOME=~/'.codex-t3/personal' codex resume 019a2b3c-codex");
  });

  it("uses PowerShell syntax on Windows hosts", () => {
    expect(
      buildProviderCliResumeCommand({
        nativeThread: nativeThread("codex", { nativeId: "019a2b3c-codex" }),
        cwd: "C:\\Users\\me\\it's here",
        platform: "windows",
        instance: instance("codex", { config: { homePath: "D:\\codex" } }),
      }),
    ).toBe(
      "cd 'C:\\Users\\me\\it''s here'; $env:CODEX_HOME = 'D:\\codex'; codex resume 019a2b3c-codex",
    );
  });

  it("has no command for providers without a CLI resume", () => {
    expect(
      buildProviderCliResumeCommand({
        nativeThread: nativeThread("opencode"),
        cwd: "/srv/app",
        platform: "linux",
        instance: undefined,
      }),
    ).toBeNull();
  });
});
