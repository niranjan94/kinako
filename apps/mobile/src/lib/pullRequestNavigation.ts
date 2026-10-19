import { parseChangeRequestUrl, parseIssueUrl } from "@t3tools/shared/changeRequestUrl";

export function nativePullRequestDestination(
  url: string,
  context: { environmentId: string; projectId: string } | null,
) {
  const pullRequest = parseChangeRequestUrl(url);
  const parsed = pullRequest ?? parseIssueUrl(url);
  if (!parsed || !context) return null;
  const params = {
    ...context,
    repository: parsed.repository,
    number: parsed.number,
    host: parsed.authority ?? parsed.host,
  };
  return pullRequest === null
    ? { name: "Issue" as const, params }
    : { name: "PullRequest" as const, params };
}
