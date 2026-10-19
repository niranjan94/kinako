/* oxlint-disable react/iframe-missing-sandbox -- This trusted package needs same-origin host messages and Canvas asset access. */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import { loadOfficeAssets } from "./officeAssets";
import { OfficeBridge, type OfficeAgent, type OfficeMessage } from "./officeBridge";

import {
  OfficeRecord,
  SavedOffice,
  INITIAL_OFFICE,
  isOfficeLayout,
  officeLayoutOrDefault,
} from "./officePersistence";

const CHANNEL = "kinako-pixel-office";
const isRecord = Schema.is(OfficeRecord);
const isSeats = Schema.is(SavedOffice.fields.seats);
const isAreas = Schema.is(SavedOffice.fields.areas);

interface OfficeFrameProps {
  agents: readonly OfficeAgent[];
  onOpen: (thread: EnvironmentThreadShell) => void;
}

export function OfficeFrame(props: OfficeFrameProps) {
  const [generation, setGeneration] = useState(0);
  return (
    <OfficeFrameSession
      key={generation}
      {...props}
      onRetry={() => setGeneration((value) => value + 1)}
    />
  );
}

function OfficeFrameSession({
  agents,
  onOpen,
  onRetry,
}: OfficeFrameProps & { onRetry: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<OfficeBridge | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useLocalStorage("kinako:pixel-office:v1", INITIAL_OFFICE, SavedOffice);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const send = useEffectEvent((message: OfficeMessage) => {
    frame.current?.contentWindow?.postMessage(
      { channel: CHANNEL, message },
      window.location.origin,
    );
  });
  const sync = useEffectEvent(() => bridge.current?.sync(agents, saved.seats));
  const initialize = useEffectEvent((assets: Awaited<ReturnType<typeof loadOfficeAssets>>) => {
    for (const message of assets.messages) send(message);
    send({ type: "providerCapabilities", readingTools: [], subagentToolNames: [] });
    const settings = {
      type: "settingsLoaded",
      soundEnabled: false,
      alwaysShowLabels: false,
      hooksEnabled: false,
      hooksInfoShown: true,
      lastSeenVersion: "1.5",
      extensionVersion: "1.5.0",
      ...saved.settings,
    };
    send({ ...settings, soundEnabled: false });
    send({ type: "areaMappingsLoaded", mappings: saved.areas });
    const layout = officeLayoutOrDefault(saved.layout, assets.layout);
    send({ type: "layoutLoaded", layout });
    setSaved((current) => (isOfficeLayout(current.layout) ? current : { ...current, layout }));
    sync();
    send(settings);
    setState("ready");
  });
  const handleCommand = useEffectEvent((message: OfficeMessage) => {
    if (message.type === "focusAgent" && typeof message.id === "number") {
      const agent = bridge.current?.agent(message.id);
      if (agent) onOpen(agent.thread);
    } else if (message.type === "saveLayout" && isOfficeLayout(message.layout)) {
      setSaved((current) => ({ ...current, layout: message.layout as typeof current.layout }));
    } else if (message.type === "saveAgentSeats" && isSeats(message.seats)) {
      const seats = bridge.current?.seatsByThread(message.seats) ?? {};
      setSaved((current) => ({ ...current, seats: { ...current.seats, ...seats } }));
    } else if (message.type === "saveAreaMappings" && isAreas(message.mappings)) {
      const areas = message.mappings;
      setSaved((current) => ({ ...current, areas }));
    } else if (message.type === "exportLayout") {
      if (!saved.layout) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(saved.layout, null, 2)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "office-layout.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } else if (message.type === "importLayout") {
      importInput.current?.click();
    } else {
      const settingKeys: Record<string, string> = {
        setSoundEnabled: "soundEnabled",
        setAlwaysShowLabels: "alwaysShowLabels",
        setGhostHeadlessAgents: "ghostHeadlessAgents",
        setShowAreas: "showAreas",
      };
      const key = settingKeys[message.type];
      if (key && typeof message.enabled === "boolean") {
        setSaved((current) => ({
          ...current,
          settings: { ...current.settings, [key]: message.enabled },
        }));
      }
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    bridge.current = new OfficeBridge((message) => send(message));
    const fail = (reason: unknown) => {
      if (controller.signal.aborted) return;
      clearTimeout(timeout);
      setError(reason instanceof Error ? reason.message : "Could not load the office.");
      setState("error");
    };
    const timeout = setTimeout(
      () => fail(new Error("The office did not respond. Try reloading it.")),
      30_000,
    );
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin)
        return;
      if (!isRecord(event.data) || event.data.channel !== CHANNEL) return;
      const message = event.data.message;
      if (!isRecord(message) || typeof message.type !== "string") return;
      if (message.type === "webviewReady") {
        if (started) return;
        started = true;
        void loadOfficeAssets(controller.signal)
          .then((assets) => {
            if (controller.signal.aborted) return;
            clearTimeout(timeout);
            initialize(assets);
          })
          .catch(fail);
      } else {
        handleCommand(message as OfficeMessage);
      }
    };
    window.addEventListener("message", receive);
    return () => {
      controller.abort();
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      bridge.current = null;
    };
  }, []);

  useEffect(() => {
    if (state === "ready") bridge.current?.sync(agents, saved.seats);
  }, [agents, state, saved.seats]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <iframe
        ref={frame}
        src="/pixel-office/index.html"
        title="Agent office"
        className="h-full min-h-0 w-full border-0"
      />
      {state !== "ready" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-6 text-center"
          role="status"
        >
          <p>{state === "error" ? error : "Opening the office…"}</p>
          {state === "error" && <Button onClick={onRetry}>Reload office</Button>}
        </div>
      )}
      <input
        ref={importInput}
        type="file"
        accept="application/json"
        className="hidden"
        aria-label="Import office layout"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          const result = await file
            .text()
            .then((text) => ({ value: JSON.parse(text) as unknown }))
            .catch(() => null);
          if (!result || !isOfficeLayout(result.value)) {
            setError("Choose a valid Pixel Agents office layout.");
            return;
          }
          const layout = result.value;
          setSaved((current) => ({ ...current, layout }));
          onRetry();
        }}
      />
      {state === "ready" && error && (
        <div className="absolute top-2 left-2 rounded bg-background p-3 text-sm" role="alert">
          {error}
          <Button size="sm" variant="ghost" onClick={() => setError("")}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
