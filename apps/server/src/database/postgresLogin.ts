import type { DatabasePostgresAuth, DatabasePostgresTarget } from "@t3tools/contracts";

export interface PostgresLogin {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string | null;
}

interface AwsLocation {
  readonly profile?: string;
  readonly region?: string;
}

/** The AWS calls a login may need. Swappable so tests run without AWS. */
export interface AwsLoginSources {
  readonly rdsAuthToken: (
    input: AwsLocation & { readonly host: string; readonly port: number; readonly user: string },
  ) => Promise<string>;
  readonly secretValue: (input: AwsLocation & { readonly secretId: string }) => Promise<string>;
  readonly parameterValue: (input: AwsLocation & { readonly name: string }) => Promise<string>;
}

const location = (auth: AwsLocation): AwsLocation => ({
  ...(auth.profile === undefined ? {} : { profile: auth.profile }),
  ...(auth.region === undefined ? {} : { region: auth.region }),
});

// Clients keep their resolved credentials, so reusing them avoids an SSO or STS round trip per
// connection. Drafts tested and never saved also land here, hence the bound.
const CLIENT_CACHE_MAX = 32;
const clients = new Map<string, Promise<unknown>>();
const cachedClient = <A>(key: string, make: () => Promise<A>): Promise<A> => {
  let client = clients.get(key);
  if (client) {
    clients.delete(key);
  } else {
    client = make().catch((cause) => {
      if (clients.get(key) === client) clients.delete(key);
      throw cause;
    });
  }
  clients.set(key, client);
  for (const oldest of clients.keys()) {
    if (clients.size <= CLIENT_CACHE_MAX) break;
    clients.delete(oldest);
  }
  return client as Promise<A>;
};
const cacheKey = (...parts: ReadonlyArray<string | number | undefined>) => JSON.stringify(parts);

// The SDK is loaded on first use; most environments never connect through AWS.
const awsLoginSources: AwsLoginSources = {
  rdsAuthToken: async (input) => {
    const signer = await cachedClient(
      cacheKey("rds", input.profile, input.region, input.host, input.port, input.user),
      async () => {
        const { Signer } = await import("@aws-sdk/rds-signer");
        return new Signer({
          ...location(input),
          hostname: input.host,
          port: input.port,
          username: input.user,
        });
      },
    );
    return signer.getAuthToken();
  },
  secretValue: async (input) => {
    const { GetSecretValueCommand, SecretsManagerClient } =
      await import("@aws-sdk/client-secrets-manager");
    const client = await cachedClient(
      cacheKey("secrets-manager", input.profile, input.region),
      async () => new SecretsManagerClient(location(input)),
    );
    const result = await client.send(new GetSecretValueCommand({ SecretId: input.secretId }));
    if (result.SecretString === undefined) {
      throw new Error(`Secret ${input.secretId} has no text value.`);
    }
    return result.SecretString;
  },
  parameterValue: async (input) => {
    const { GetParameterCommand, SSMClient } = await import("@aws-sdk/client-ssm");
    const client = await cachedClient(
      cacheKey("ssm", input.profile, input.region),
      async () => new SSMClient(location(input)),
    );
    const result = await client.send(
      new GetParameterCommand({ Name: input.name, WithDecryption: true }),
    );
    if (result.Parameter?.Value === undefined) {
      throw new Error(`Parameter ${input.name} has no value.`);
    }
    return result.Parameter.Value;
  },
};

interface StoredLogin {
  readonly password: string;
  readonly user?: string;
  readonly host?: string;
  readonly port?: number;
}

/**
 * Reads a stored credential. RDS and most tooling store JSON with `username` and `password`, and
 * sometimes `host` and `port`; any other value is taken as the password itself.
 */
export function parseStoredLogin(value: string): StoredLogin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { password: value };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { password: value };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.password !== "string") {
    throw new Error("The stored credential is JSON without a password field.");
  }
  const user = record.username ?? record.user;
  const port = typeof record.port === "string" ? Number(record.port) : record.port;
  return {
    password: record.password,
    ...(typeof user === "string" && user !== "" ? { user } : {}),
    ...(typeof record.host === "string" && record.host !== "" ? { host: record.host } : {}),
    ...(typeof port === "number" && Number.isInteger(port) && port > 0 ? { port } : {}),
  };
}

const describeSource = (auth: Exclude<DatabasePostgresAuth, { kind: "password" }>) => {
  switch (auth.kind) {
    case "aws-iam":
      return "AWS IAM";
    case "aws-secrets-manager":
      return `AWS Secrets Manager (${auth.secretId})`;
    case "aws-parameter-store":
      return `AWS Parameter Store (${auth.parameterName})`;
  }
};

/** Resolves the login for one connection attempt; IAM tokens expire, so nothing is reused. */
export async function resolvePostgresLogin(
  target: DatabasePostgresTarget,
  storedPassword: string | null,
  sources: AwsLoginSources = awsLoginSources,
): Promise<PostgresLogin> {
  const base = { host: target.host, port: target.port, user: target.user };
  const auth = target.auth ?? { kind: "password" };
  if (auth.kind === "password") return { ...base, password: storedPassword };
  try {
    switch (auth.kind) {
      case "aws-iam":
        return { ...base, password: await sources.rdsAuthToken({ ...location(auth), ...base }) };
      case "aws-secrets-manager": {
        const stored = parseStoredLogin(
          await sources.secretValue({ ...location(auth), secretId: auth.secretId }),
        );
        return {
          host: auth.useSecretHost ? (stored.host ?? base.host) : base.host,
          port: auth.useSecretHost ? (stored.port ?? base.port) : base.port,
          user: stored.user ?? base.user,
          password: stored.password,
        };
      }
      case "aws-parameter-store": {
        const stored = parseStoredLogin(
          await sources.parameterValue({ ...location(auth), name: auth.parameterName }),
        );
        return { ...base, user: stored.user ?? base.user, password: stored.password };
      }
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${describeSource(auth)}: ${reason}`, { cause });
  }
}
