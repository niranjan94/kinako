import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { serverEnvironment } from "../../state/server";

export function useKeepAwakeFooter(
  environmentIds: ReadonlyArray<EnvironmentId>,
  enabled: boolean,
): string | undefined {
  const environmentKey = enabled ? environmentIds.join("\n") : "";
  const statuses = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environmentKey === ""
            ? []
            : environmentKey.split("\n").flatMap((environmentId) => {
                const result = get(
                  serverEnvironment.keepAwakeStatus({
                    environmentId: EnvironmentId.make(environmentId),
                    input: {},
                  }),
                );
                return result._tag === "Success" ? [result.value] : [];
              }),
        ),
      [environmentKey],
    ),
  );
  const error = statuses.find((status) => status.error !== null)?.error;
  if (error) return error;
  const activeCount = statuses.filter((status) => status.active).length;
  if (activeCount === 0) return undefined;
  return environmentIds.length === 1
    ? "Keeping this computer awake now."
    : `Keeping ${activeCount} of ${environmentIds.length} computers awake now.`;
}
