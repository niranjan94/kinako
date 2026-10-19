import { THREAD_GROUP_MAX_LENGTH } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Request = {
  readonly initialName: string;
  readonly resolve: (name: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Resolves with the trimmed group name, or null when the dialog is dismissed. */
export function requestThreadGroupName(initialName = ""): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { initialName, resolve } }));
}

/** The group a "Move to group" menu choice resolves to, or undefined when cancelled. */
export async function resolveThreadGroupChoice(action: string): Promise<string | null | undefined> {
  if (action === "group:remove") return null;
  if (action === "group:new") return (await requestThreadGroupName()) ?? undefined;
  return action.startsWith("group:set:") ? action.slice("group:set:".length) : undefined;
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function ThreadGroupDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <ThreadGroupDialog initialName={request.initialName} /> : null;
}

function ThreadGroupDialog(props: { readonly initialName: string }) {
  const id = useId();
  const renaming = props.initialName !== "";
  const [name, setName] = useState(props.initialName);
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "") finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{renaming ? "Rename group" : "New group"}</DialogTitle>
            <DialogDescription>
              Threads with the same group name are listed together in the sidebar.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                autoFocus
                value={name}
                maxLength={THREAD_GROUP_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed === "" || trimmed === props.initialName}>
              {renaming ? "Rename" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
