import { createFileRoute } from "@tanstack/react-router";
import { DatabaseSettings } from "../components/settings/DatabaseSettings";

export const Route = createFileRoute("/settings/databases")({ component: DatabaseSettings });
