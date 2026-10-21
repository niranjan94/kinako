// Host adapter for the pinned pixel-agents frontend; upstream files stay untouched.
(() => {
  const channel = "kinako-pixel-office";
  const origin = location.origin;
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      parent.postMessage({ channel, message }, origin);
    },
  });
  const agentStates = new Map();
  let fitted = false;
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== origin || event.data?.channel !== channel)
      return;
    const message = event.data.message;
    if (message.type === "kinakoAgentState") {
      agentStates.set(message.id, message);
      adaptControls();
      return;
    }
    if (message.type === "agentClosed") agentStates.delete(message.id);
    window.dispatchEvent(new MessageEvent("message", { data: message }));
    if (!fitted && event.data.message.type === "layoutLoaded") {
      fitted = true;
      const layout = event.data.message.layout;
      const dpr = devicePixelRatio || 1;
      const zoom = Math.max(
        1,
        Math.floor(
          Math.min(innerWidth / (layout.cols * 16), innerHeight / (layout.rows * 16)) * dpr,
        ),
      );
      let steps = Math.max(1, Math.round(2 * dpr)) - zoom;
      const fit = () => {
        if (steps-- <= 0) return;
        document.querySelector('button[title="Zoom out (Ctrl+Scroll)"]')?.click();
        requestFrame(fit);
      };
      requestFrame(fit);
    }
  });

  // Pixel art only needs 24fps; stop the upstream game loop while the page is hidden.
  const requestFrame = window.requestAnimationFrame.bind(window);
  const cancelFrame = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  let nextId = 0;
  window.requestAnimationFrame = (callback) => {
    const id = ++nextId;
    const entry = { callback, timer: null, frame: null };
    pending.set(id, entry);
    const schedule = () => {
      entry.timer = null;
      if (document.hidden || !pending.has(id)) return;
      entry.frame = requestFrame((time) => {
        pending.delete(id);
        callback(time);
      });
    };
    entry.schedule = schedule;
    if (!document.hidden) entry.timer = setTimeout(schedule, 1000 / 24);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.frame !== null) cancelFrame(entry.frame);
    pending.delete(id);
  };
  document.addEventListener("visibilitychange", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      if (entry.frame !== null) cancelFrame(entry.frame);
      entry.frame = null;
      if (!document.hidden) entry.timer = setTimeout(entry.schedule, 1000 / 24);
    }
  });

  // These controls belong to the standalone Claude host, not the embedded office.
  // Text selectors are intentionally tied to pixel-agents@1.5.0.
  const unsupported = [
    "+ Agent",
    "Add Asset Directory",
    "Open Sessions Folder",
    "Watch All Sessions",
    "Instant Detection (Hooks)",
    "Display Headless as Ghosts",
    "Skip Permissions",
    "Show Workspace Folders",
  ];
  const adaptControls = () => {
    // The upstream card only distinguishes working, idle, and attention.
    // Keep host lifecycle states visible without changing the pinned frontend.
    for (const card of document.querySelectorAll('[title^="Agent "]')) {
      const id = Number(/^Agent (\d+)/.exec(card.title)?.[1]);
      const activity = agentStates.get(id);
      if (!activity) continue;
      const stateLabel =
        activity.state === "working"
          ? "Working"
          : activity.state === "error"
            ? "Error"
            : activity.state === "offline"
              ? "Environment disconnected"
              : activity.state === "waiting"
                ? activity.approval
                  ? "Needs approval"
                  : "Waiting for input"
                : activity.state === "snoozed"
                  ? `Snoozed until ${new Date(activity.snoozedUntil).toLocaleString()}`
                  : "Idle";
      const label = `${stateLabel}${activity.subagentCount > 0 ? ` · ${activity.subagentCount} subagent${activity.subagentCount === 1 ? "" : "s"}` : ""}`;
      card.title = `Agent ${id}: ${activity.title} — ${label}`;
      card.setAttribute("aria-label", card.title);
      card.dataset.kinakoState = activity.state;
      const dot = card.querySelector("span.size-6");
      if (dot)
        dot.style.backgroundColor =
          activity.state === "error" || activity.state === "offline"
            ? "var(--color-status-error)"
            : activity.state === "waiting"
              ? "var(--color-status-permission)"
              : activity.state === "working"
                ? "var(--color-accent-bright)"
                : activity.state === "snoozed"
                  ? "var(--color-text-muted)"
                  : "var(--color-status-success)";
      let snoozeBadge = card.querySelector("[data-kinako-snooze]");
      if (activity.state === "snoozed" && !snoozeBadge) {
        card.style.position = "relative";
        snoozeBadge = document.createElement("span");
        snoozeBadge.dataset.kinakoSnooze = "";
        snoozeBadge.className = "absolute bottom-0 right-0 text-xs bg-bg text-text px-2";
        snoozeBadge.textContent = "Zzz";
        card.append(snoozeBadge);
      } else if (activity.state !== "snoozed") {
        snoozeBadge?.remove();
      }
      const overlay = document.querySelector(
        `[data-testid="agent-overlay"][data-agent-id="${id}"]`,
      );
      const activityLabel = overlay?.querySelector(".pixel-panel > div")?.children[1];
      if (activityLabel && activityLabel.textContent !== label) activityLabel.textContent = label;
    }
    for (const button of document.querySelectorAll("button")) {
      const label = button.firstElementChild?.textContent?.trim() ?? button.textContent?.trim();
      if (unsupported.some((text) => label?.startsWith(text)) || button.title === "Close agent") {
        button.hidden = true;
        button.style.display = "none";
      }
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(adaptControls).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    adaptControls();
  });
})();
