import { createFileRoute, redirect } from "@tanstack/react-router";
import { AgentsPage } from "../components/agents/AgentsPage";

export const Route = createFileRoute("/agents")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: AgentsPage,
});
