import { describe, expect, it } from "@effect/vitest";
import type { DatabasePostgresAuth, DatabasePostgresTarget } from "@t3tools/contracts";

import { parseStoredLogin, resolvePostgresLogin, type AwsLoginSources } from "./postgresLogin.ts";

const target = (auth?: DatabasePostgresAuth): DatabasePostgresTarget => ({
  engine: "postgres",
  host: "db.example.internal",
  port: 5432,
  database: "app",
  user: "app_user",
  sslMode: "require",
  ...(auth ? { auth } : {}),
});

const unused = () => Promise.reject(new Error("unexpected AWS call"));
const sources = (overrides: Partial<AwsLoginSources>): AwsLoginSources => ({
  rdsAuthToken: unused,
  secretValue: unused,
  parameterValue: unused,
  ...overrides,
});

describe("parseStoredLogin", () => {
  it("reads RDS-style JSON and treats anything else as the password", () => {
    expect(
      parseStoredLogin(
        JSON.stringify({ username: "admin", password: "p", host: "h", port: "6432" }),
      ),
    ).toEqual({ user: "admin", password: "p", host: "h", port: 6432 });
    expect(parseStoredLogin("plain-secret")).toEqual({ password: "plain-secret" });
    expect(parseStoredLogin("12345")).toEqual({ password: "12345" });
    expect(() => parseStoredLogin(JSON.stringify({ username: "admin" }))).toThrow(/password/);
  });
});

describe("resolvePostgresLogin", () => {
  it("uses the stored password when no AWS method is configured", async () => {
    await expect(resolvePostgresLogin(target(), "stored", sources({}))).resolves.toEqual({
      host: "db.example.internal",
      port: 5432,
      user: "app_user",
      password: "stored",
    });
  });

  it("signs an IAM token for the target's host, port and user", async () => {
    const login = await resolvePostgresLogin(
      target({ kind: "aws-iam", profile: "prod", region: "ap-southeast-1" }),
      "ignored",
      sources({
        rdsAuthToken: async (input) => {
          expect(input).toEqual({
            profile: "prod",
            region: "ap-southeast-1",
            host: "db.example.internal",
            port: 5432,
            user: "app_user",
          });
          return "token";
        },
      }),
    );
    expect(login.password).toBe("token");
  });

  it("takes the user from a secret and its host only when asked", async () => {
    const secret = JSON.stringify({
      username: "rds_admin",
      password: "s3cret",
      host: "other.example",
      port: 6543,
    });
    const auth = { kind: "aws-secrets-manager", secretId: "rds!db-1" } as const;
    const fromSecret = sources({ secretValue: async () => secret });
    await expect(
      resolvePostgresLogin(target({ ...auth, useSecretHost: false }), null, fromSecret),
    ).resolves.toEqual({
      host: "db.example.internal",
      port: 5432,
      user: "rds_admin",
      password: "s3cret",
    });
    await expect(
      resolvePostgresLogin(target({ ...auth, useSecretHost: true }), null, fromSecret),
    ).resolves.toMatchObject({ host: "other.example", port: 6543 });
  });

  it("reads a plain password from Parameter Store", async () => {
    await expect(
      resolvePostgresLogin(
        target({ kind: "aws-parameter-store", parameterName: "/app/db/password" }),
        null,
        sources({ parameterValue: async ({ name }) => `value-of-${name}` }),
      ),
    ).resolves.toEqual({
      host: "db.example.internal",
      port: 5432,
      user: "app_user",
      password: "value-of-/app/db/password",
    });
  });

  it("names the credential source when AWS fails", async () => {
    await expect(
      resolvePostgresLogin(
        target({ kind: "aws-secrets-manager", secretId: "missing", useSecretHost: false }),
        null,
        sources({ secretValue: () => Promise.reject(new Error("AccessDeniedException")) }),
      ),
    ).rejects.toThrow("AWS Secrets Manager (missing): AccessDeniedException");
  });
});
