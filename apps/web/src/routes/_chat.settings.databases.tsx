import { createFileRoute } from "@tanstack/react-router";
import { DatabaseSettings } from "../components/settings/DatabaseSettings";

export const Route = createFileRoute("/_chat/settings/databases")({ component: DatabaseSettings });
