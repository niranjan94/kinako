import {
  DecisionApiConfig,
  type EnvironmentId,
  isSecretReference,
  type ProviderInstanceId,
  type SecretReference,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MoreVertical, PlusIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, Var } from "gt-react";

import { APP_BASE_NAME } from "../../branding";
import {
  checkDecisionApiConfig,
  decisionApiDisplayName,
  rereadDecisionApiModels,
  SYSTEM_ONE_BASE_URL,
  SYSTEM_ONE_NAME,
} from "../../decisionApis";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { nextTextGeneratorId } from "../../textGenerators";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const decodeDecisionApi = Schema.decodeUnknownOption(DecisionApiConfig);

type Saved = { readonly id: ProviderInstanceId; readonly config: DecisionApiConfig };
type Editing = Saved | "new";

/** Rows that list, add, edit, and remove one environment's decision APIs. */
export function DecisionApisSettings({
  environmentId,
  environmentLabel,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<ProviderInstanceId | null>(null);
  const apis = Object.entries(settings.decisionApis) as Array<
    [ProviderInstanceId, DecisionApiConfig]
  >;
  const removingConfig = removing === null ? undefined : settings.decisionApis[removing];

  return (
    <>
      <SettingsSection
        {...setting("decision-apis")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add decision API</T>
            </Button>
          ) : null
        }
      >
        {apis.length === 0 ? (
          <SettingsRow
            title={gt("No decision APIs yet")}
            description={gt(
              "Connect System One to review {app} Auto requests with a model built for yes or no decisions.",
              { app: APP_BASE_NAME },
            )}
          />
        ) : null}
        {apis.map(([id, config]) => {
          const name = decisionApiDisplayName(config);
          return (
            <SettingsRow
              key={id}
              title={name}
              description={
                <span className="block truncate">
                  {config.enabled ? "" : gt("Off · ")}
                  {config.baseUrl.replace(/^https?:\/\//, "")}
                </span>
              }
              control={
                readOnly ? null : (
                  <div className="flex items-center gap-2">
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost-muted"
                            aria-label={gt("More actions for {name}", { name })}
                          />
                        }
                      >
                        <MoreVertical />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => setEditing({ id, config })}>
                          <T>Edit</T>
                        </MenuItem>
                        <MenuItem variant="destructive" onClick={() => setRemoving(id)}>
                          <T>Remove</T>
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                    <Switch
                      checked={config.enabled}
                      onCheckedChange={(enabled) =>
                        updateSettings({ decisionApis: { [id]: { ...config, enabled } } })
                      }
                      aria-label={gt("Enable {name}", { name })}
                    />
                  </div>
                )
              }
            />
          );
        })}
      </SettingsSection>
      {editing !== null ? (
        <DecisionApiDialog
          environmentId={environmentId}
          editing={editing}
          onClose={() => setEditing(null)}
          onSave={(id, config) =>
            updateSettings(
              { decisionApis: { [id]: config } },
              { onSaved: () => rereadDecisionApiModels(environmentId, id) },
            )
          }
          onUse={(id, model) =>
            updateSettings({
              autoReviewModelSelection: createModelSelection(id, model),
              autoReviewRulesOnly: false,
            })
          }
          newId={() => nextTextGeneratorId("system-one", settings, providers)}
        />
      ) : null}
      <AlertDialog
        open={removingConfig !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{removingConfig ? decisionApiDisplayName(removingConfig) : ""}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This deletes the API key stored on <Var>{environmentLabel}</Var>. Reviews set to use
                it fall back to the text generation model.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) updateSettings({ decisionApis: { [removing]: null } });
                setRemoving(null);
              }}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * Connect lists the API's models and has one answer a question, so a saved entry is known to work.
 * The key goes once to the environment's secret storage; settings keep only a redaction marker.
 */
function DecisionApiDialog({
  environmentId,
  editing,
  onClose,
  onSave,
  onUse,
  newId,
}: {
  readonly environmentId: EnvironmentId;
  readonly editing: Editing;
  readonly onClose: () => void;
  readonly onSave: (id: ProviderInstanceId, config: DecisionApiConfig) => void;
  readonly onUse: (id: ProviderInstanceId, model: string) => void;
  readonly newId: () => ProviderInstanceId;
}) {
  const gt = useGT();
  const existing = editing === "new" ? null : editing.config;
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? SYSTEM_ONE_BASE_URL);
  const [label, setLabel] = useState(existing?.label ?? "");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>(
    isSecretReference(existing?.apiKey) ? existing.apiKey : "",
  );
  const [keyValid, setKeyValid] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [connected, setConnected] = useState<{
    readonly id: ProviderInstanceId;
    readonly modelCount: number;
    readonly testedModel: string | undefined;
  } | null>(null);
  const [used, setUsed] = useState(false);

  // A saved literal key arrives redacted; sending the marker back keeps it.
  const storedKey = typeof existing?.apiKey === "string" ? existing.apiKey : "";
  const apiKey = typeof keyDraft === "string" ? keyDraft.trim() || storedKey : keyDraft;
  const config = decodeDecisionApi({
    kind: existing?.kind ?? "systemOne",
    ...(label.trim() ? { label: label.trim() } : {}),
    baseUrl: baseUrl.trim(),
    apiKey,
    enabled: existing?.enabled ?? true,
  });
  const canConnect = keyValid && Option.isSome(config) && apiKey !== "";
  const name = Option.isSome(config) ? decisionApiDisplayName(config.value) : SYSTEM_ONE_NAME;

  const connect = async () => {
    if (!canConnect || checking) return;
    const id = editing === "new" ? (connected?.id ?? newId()) : editing.id;
    setChecking(true);
    setCheckError(null);
    // The form is disabled while this runs, so the checked config is the one saved below.
    const result = await checkDecisionApiConfig(environmentId, id, config.value);
    setChecking(false);
    if ("error" in result) {
      setCheckError(result.error);
      return;
    }
    onSave(id, config.value);
    setConnected({ id, modelCount: result.models.length, testedModel: result.testedModel });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? gt("Edit {name}", { name: decisionApiDisplayName(existing) })
              : gt("Add a decision API")}
          </DialogTitle>
          <DialogDescription>
            {gt(
              "System One answers whether a request looks safe, with how sure it is. {app} Auto uses it to decide which requests to approve. Your API key is stored on this environment.",
              { app: APP_BASE_NAME },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {connected === null ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <fieldset disabled={checking} className="contents">
                <div className="grid gap-1.5">
                  <Label htmlFor="decision-api-key">
                    <T>API key</T>
                  </Label>
                  <SecretSourceInput
                    id="decision-api-key"
                    aria-label={gt("API key")}
                    value={keyDraft}
                    configured={storedKey !== ""}
                    sources={secretSources}
                    onChange={(event) => {
                      setKeyDraft(event.target.value);
                      setCheckError(null);
                    }}
                    onSecretChange={(secret) => setKeyDraft(secret ?? "")}
                    autoFocus
                    onValidityChange={setKeyValid}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="decision-api-url">
                    <T>Base URL</T>
                  </Label>
                  <Input
                    id="decision-api-url"
                    placeholder={SYSTEM_ONE_BASE_URL}
                    value={baseUrl}
                    onChange={(event) => {
                      setBaseUrl(event.target.value);
                      setCheckError(null);
                    }}
                    spellCheck={false}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="decision-api-label">
                    <T>Name (optional)</T>
                  </Label>
                  <Input
                    id="decision-api-label"
                    placeholder={SYSTEM_ONE_NAME}
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </div>
                {checkError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {checkError}
                  </p>
                ) : null}
              </fieldset>
            </form>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {connected.testedModel
                ? gt(
                    "{count, plural, one {{name} is connected and lists {count} model. {model} answered a test question.} other {{name} is connected and lists {count} models. {model} answered a test question.}}",
                    { name, count: connected.modelCount, model: connected.testedModel },
                  )
                : gt(
                    "{count, plural, one {{name} is connected and lists {count} model.} other {{name} is connected and lists {count} models.}}",
                    { name, count: connected.modelCount },
                  )}
            </p>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          {connected === null ? (
            <>
              <Button variant="outline" onClick={onClose}>
                <T>Cancel</T>
              </Button>
              <Button onClick={() => void connect()} disabled={!canConnect || checking}>
                {checking ? <Spinner /> : null}
                {checking ? gt("Connecting") : existing ? gt("Save and test") : gt("Connect")}
              </Button>
            </>
          ) : (
            <>
              {connected.testedModel ? (
                <Button
                  variant="outline"
                  disabled={used}
                  onClick={() => {
                    if (!connected.testedModel) return;
                    onUse(connected.id, connected.testedModel);
                    setUsed(true);
                  }}
                >
                  {used
                    ? gt("Reviewing {app} Auto requests", { app: APP_BASE_NAME })
                    : gt("Use for {app} Auto", { app: APP_BASE_NAME })}
                </Button>
              ) : null}
              <Button autoFocus onClick={onClose}>
                <T>Done</T>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
