import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { isElectron } from "../../env";
import { SidebarInset } from "../ui/sidebar";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { OfficeFrame } from "./OfficeFrame";
import { officeAgentState, officeThreadKey, type OfficeAgent } from "./officeBridge";

export function AgentsPage() {
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [environment, setEnvironment] = useState("all");
  const [scope, setScope] = useState("active");
  const [project, setProject] = useState("all");
  const query = search.trim().toLowerCase();
  const candidates = threads.filter(
    (thread) =>
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      thread.isSideChat !== true &&
      (environment === "all" || thread.environmentId === environment) &&
      (project === "all" || `${thread.environmentId}:${thread.projectId}` === project),
  );
  const roster: OfficeAgent[] = candidates
    .map((thread) => ({
      key: officeThreadKey(thread),
      thread,
      projectName:
        projects.find(
          (item) => item.environmentId === thread.environmentId && item.id === thread.projectId,
        )?.title ?? "Project",
      state: officeAgentState(
        thread,
        environments.some(
          (item) =>
            item.environmentId === thread.environmentId && item.connection.phase === "connected",
        ),
      ),
    }))
    .sort((a, b) => {
      const priority = { waiting: 0, working: 1, error: 2, idle: 3, offline: 4 };
      return (
        priority[a.state] - priority[b.state] ||
        b.thread.updatedAt.localeCompare(a.thread.updatedAt)
      );
    })
    .filter(
      (agent) =>
        !query ||
        `${agent.thread.title} ${agent.projectName} ${agent.thread.modelSelection.model}`
          .toLowerCase()
          .includes(query),
    );
  const agents =
    scope === "active"
      ? roster.filter((agent) => agent.state === "working" || agent.state === "waiting")
      : scope === "all"
        ? roster
        : roster.filter(
            (agent, index) => (agent.state !== "idle" && agent.state !== "offline") || index < 20,
          );
  const openThread = (thread: EnvironmentThreadShell) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId: thread.environmentId, threadId: thread.id }),
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Agent office</h1>
        <span className="text-xs text-muted-foreground">{agents.length} threads</span>
      </WorkspacePageHeader>
      <div className="grid grid-cols-2 items-center gap-2 border-b px-4 py-2 sm:flex sm:flex-wrap">
        <div className="min-w-0 sm:w-48">
          <Input
            aria-label="Search threads"
            placeholder="Find a thread…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="min-w-0 sm:w-44">
          <Select
            value={environment}
            onValueChange={(value) => {
              setEnvironment(value ?? "all");
              setProject("all");
            }}
          >
            <SelectTrigger size="sm" aria-label="Environment">
              <SelectValue>
                {environment === "all"
                  ? "All environments"
                  : (environments.find((item) => item.environmentId === environment)?.label ??
                    "Environment")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All environments</SelectItem>
              {environments.map((item) => (
                <SelectItem key={item.environmentId} value={item.environmentId}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="min-w-0 sm:w-44">
          <Select value={project} onValueChange={(value) => setProject(value ?? "all")}>
            <SelectTrigger size="sm" aria-label="Project">
              <SelectValue>
                {project === "all"
                  ? "All projects"
                  : (projects.find((item) => `${item.environmentId}:${item.id}` === project)
                      ?.title ?? "Project")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All projects</SelectItem>
              {projects
                .filter((item) => environment === "all" || item.environmentId === environment)
                .map((item) => (
                  <SelectItem
                    key={`${item.environmentId}:${item.id}`}
                    value={`${item.environmentId}:${item.id}`}
                  >
                    {item.title}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="min-w-0 sm:w-44">
          <Select value={scope} onValueChange={(value) => setScope(value ?? "active")}>
            <SelectTrigger size="sm" aria-label="Threads to show">
              <SelectValue>
                {scope === "active"
                  ? "Active threads"
                  : scope === "all"
                    ? "All threads"
                    : "Active + recent"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="active">Active threads</SelectItem>
              <SelectItem value="recent">Active + recent</SelectItem>
              <SelectItem value="all">All threads</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <OfficeFrame agents={agents} onOpen={openThread} />
      </div>
    </SidebarInset>
  );
}
