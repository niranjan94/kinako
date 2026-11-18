import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderDriverKind,
  UsageLimitSourceSnapshot,
  UsageQuotaSample,
} from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { T, useGT, useLocale } from "gt-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { QuotaForecastChart } from "./QuotaForecastChart";
import { buildQuotaForecast, liveQuotaSample, quotaWindows } from "./usageQuotaForecast";
import { PROVIDER_PRESENTATION } from "./usageProviders";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const EMPTY_SAMPLES: readonly UsageQuotaSample[] = [];
const HUB_PROVIDERS = new Map<
  string,
  (typeof PROVIDER_PRESENTATION)[keyof typeof PROVIDER_PRESENTATION]
>([
  ["claude", PROVIDER_PRESENTATION.claude],
  ["codex", PROVIDER_PRESENTATION.codex],
  ["antigravity", PROVIDER_PRESENTATION.antigravity],
  ["xai", PROVIDER_PRESENTATION.grok],
]);
const OTHER_LABELS = new Map([
  ["kimi", "Kimi"],
  ["devin", "Devin"],
  ["muse", "Muse (Meta)"],
]);
const FORECAST_COLORS = new Map([
  ["claude", "#d97757"],
  ["codex", "#6c9df8"],
  ["antigravity", "#9b86ec"],
  ["xai", "#59ae9f"],
]);

export interface QuotaHub {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly source: UsageLimitSourceSnapshot;
}

interface Choice {
  readonly value: string;
  readonly label: string;
}

function QuotaSelect({
  label,
  value,
  options,
  onChange,
  compact = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly Choice[];
  readonly onChange: (value: string) => void;
  readonly compact?: boolean;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(selected) => selected !== null && onChange(selected)}
    >
      <SelectTrigger
        size={compact ? "compact" : "sm"}
        className={compact ? "w-auto min-w-0" : undefined}
        aria-label={label}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={!compact}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function UsageQuotaForecast({
  hubs,
  hiddenDrivers,
  now,
}: {
  readonly hubs: readonly QuotaHub[];
  readonly hiddenDrivers: ReadonlySet<ProviderDriverKind>;
  readonly now: number;
}) {
  const gt = useGT();
  const [hubKey, setHubKey] = useState<string | null>(null);
  const hub = hubs.find(({ key }) => key === hubKey) ?? hubs[0];
  if (!hub) return null;

  return (
    <section className="space-y-4" aria-label={gt("Quota forecast")}>
      {hubs.length > 1 && (
        <div className="w-fit max-w-full">
          <QuotaSelect
            label={gt("Usage hub")}
            value={hub.key}
            onChange={setHubKey}
            options={hubs.map(({ key, label }) => ({ value: key, label }))}
          />
        </div>
      )}
      <QuotaDashboard
        key={hub.key}
        hub={hub}
        hiddenDrivers={hiddenDrivers}
        now={Math.max(now, Date.parse(hub.source.checkedAt))}
      />
    </section>
  );
}

function QuotaDashboard({
  hub,
  hiddenDrivers,
  now,
}: {
  readonly hub: QuotaHub;
  readonly hiddenDrivers: ReadonlySet<ProviderDriverKind>;
  readonly now: number;
}) {
  const gt = useGT();
  const locale = useLocale();
  const { source, environmentId } = hub;
  const [provider, setProvider] = useState("");
  const [metric, setMetric] = useState<"remaining" | "drain">("remaining");
  const [hours, setHours] = useState(3);
  const [multiplier, setMultiplier] = useState(1);
  const [showAccounts, setShowAccounts] = useState(false);
  const [showEmails, setShowEmails] = useState(false);
  const [weeksAgo, setWeeksAgo] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useAtomCommand(serverEnvironment.refreshProviders);
  const canRefresh = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  const through = day + DAY_MS - weeksAgo * WEEK_MS;
  const from = through - WEEK_MS;
  const history = useAtomValue(
    serverEnvironment.usageQuotaHistory({
      environmentId,
      input: {
        sourceId: source.id,
        from: new Date(from).toISOString(),
        to: new Date(through).toISOString(),
      },
    }),
  );
  const historical = AsyncResult.getOrElse(history, () => EMPTY_SAMPLES);
  const live =
    weeksAgo === 0 && (source.error || source.accounts.some(({ historyKey }) => historyKey))
      ? liveQuotaSample(source)
      : null;
  const samples = live
    ? [
        ...historical.filter((sample) => Date.parse(sample.checkedAt) < Date.parse(live.checkedAt)),
        live,
      ]
    : historical;
  const credentials = new Map(source.credentials?.map((entry) => [entry.provider, entry]));
  for (const entry of HUB_PROVIDERS) {
    const [id, { driverKind }] = entry;
    if (hiddenDrivers.has(driverKind)) {
      credentials.delete(id);
      continue;
    }
    if (credentials.has(id)) continue;
    const count = source.accounts.filter(({ driver }) => driver === driverKind).length;
    if (
      count > 0 ||
      samples.some(({ accounts }) => accounts.some(({ driver }) => driver === driverKind))
    ) {
      credentials.set(id, { provider: id, total: count, enabled: count });
    }
  }
  const providers = [...credentials.values()].sort(
    (left, right) =>
      Number(HUB_PROVIDERS.has(right.provider)) - Number(HUB_PROVIDERS.has(left.provider)),
  );
  const selected = credentials.has(provider) ? provider : "";
  const visibleAccounts = source.accounts.filter(({ driver }) => !hiddenDrivers.has(driver));
  const loaded = visibleAccounts.filter(
    ({ usageLimits }) =>
      !usageLimits.unavailable &&
      usageLimits.windows.length > 0 &&
      Date.parse(usageLimits.checkedAt) >= Date.parse(source.checkedAt),
  ).length;
  const total = providers.reduce((sum, entry) => sum + entry.total, 0);
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  const number = new Intl.NumberFormat(locale);

  const refreshCredentials = () => {
    setRefreshing(true);
    void refresh({ environmentId, input: { usageSourceId: source.id } }).finally(() => {
      setRefreshing(false);
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            <T>Quota management</T>
          </h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {gt("{total} credentials · {loaded} loaded", {
              total: number.format(total),
              loaded: number.format(loaded),
            })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={showEmails}
            disabled={!visibleAccounts.some(({ email }) => email !== undefined)}
            onClick={() => setShowEmails(!showEmails)}
          >
            {showEmails ? <EyeOffIcon /> : <EyeIcon />}
            {showEmails ? <T>Hide emails</T> : <T>Show emails</T>}
          </Button>
          <Button
            size="sm"
            disabled={!canRefresh || refreshing}
            aria-busy={refreshing}
            onClick={refreshCredentials}
          >
            <RefreshCwIcon />
            <T>Refresh credentials</T>
          </Button>
        </div>
      </div>

      {providers.length > 0 && (
        <ToggleGroup
          variant="default"
          size="sm"
          className="max-w-full flex-wrap"
          aria-label={gt("Filter quota by provider")}
          value={[selected]}
          onValueChange={([value]) => setProvider(value ?? "")}
        >
          <ToggleGroupItem value="">
            <T>All</T> <span className="text-muted-foreground">{number.format(total)}</span>
          </ToggleGroupItem>
          {providers.map(({ provider: id, total: count }) => {
            const presentation = HUB_PROVIDERS.get(id);
            return (
              <ToggleGroupItem key={id} value={id}>
                {presentation && (
                  <ProviderInstanceIcon
                    driverKind={presentation.driverKind}
                    displayName={presentation.label}
                    className="size-4"
                  />
                )}
                {presentation?.label ?? OTHER_LABELS.get(id) ?? id}
                <span className="text-muted-foreground">{number.format(count)}</span>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ToggleGroup
          className="shrink-0"
          aria-label={gt("Quota chart metric")}
          value={[metric]}
          onValueChange={([value]) => setMetric(value === "drain" ? "drain" : "remaining")}
        >
          <ToggleGroupItem value="remaining">
            <T>Remaining</T>
          </ToggleGroupItem>
          <ToggleGroupItem value="drain">
            <T>Drain rate</T>
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            <T>Lookback</T>
          </span>
          <ToggleGroup
            aria-label={gt("Burn rate lookback")}
            value={[String(hours)]}
            onValueChange={([value]) => {
              if (value) setHours(Number(value));
            }}
          >
            {[1, 3, 6].map((hour) => (
              <ToggleGroupItem key={hour} value={String(hour)}>
                {gt("{hours}h", { hours: hour })}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            <T>Future usage</T>
          </span>
          <QuotaSelect
            compact
            label={gt("Future usage")}
            value={String(multiplier)}
            onChange={(value) => setMultiplier(Number(value))}
            options={[
              { value: "0", label: gt("Paused") },
              { value: "0.5", label: gt("Half as much") },
              { value: "1", label: gt("Same as now") },
              { value: "1.5", label: gt("50% more") },
              { value: "2", label: gt("Twice as much") },
            ]}
          />
        </div>
        <Button
          variant="secondary"
          size="compact"
          aria-pressed={showAccounts}
          onClick={() => setShowAccounts(!showAccounts)}
        >
          <UsersIcon />
          <T>Accounts</T>
        </Button>
        <div className="ms-auto flex shrink-0 items-center gap-1">
          <span className="pe-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {date.formatRange(from, weeksAgo === 0 ? now + WEEK_MS : through - 1)}
          </span>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={gt("Previous quota period")}
            disabled={weeksAgo >= 4}
            onClick={() => setWeeksAgo((current) => current + 1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button variant="secondary" size="compact" onClick={() => setWeeksAgo(0)}>
            <T>Today</T>
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={gt("Next quota period")}
            disabled={weeksAgo === 0}
            onClick={() => setWeeksAgo((current) => Math.max(0, current - 1))}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      {source.error && (
        <p role="status" className="text-sm text-muted-foreground">
          {source.error}
        </p>
      )}
      {history._tag === "Failure" && (
        <p role="status" className="text-sm text-muted-foreground">
          <T>Quota history is unavailable for this environment.</T>
        </p>
      )}
      {providers.length === 0 && (
        <p className="text-sm text-muted-foreground">
          <T>No quota credentials are available for this hub.</T>
        </p>
      )}
      <div className="space-y-4">
        {providers
          .filter(({ provider: id }) => selected === "" || selected === id)
          .map(({ provider: id, enabled, total: credentialCount }) => {
            const presentation = HUB_PROVIDERS.get(id);
            if (!presentation && selected === "") return null;
            return (
              <QuotaCard
                key={id}
                label={presentation?.label ?? OTHER_LABELS.get(id) ?? id}
                driver={presentation?.driverKind}
                color={FORECAST_COLORS.get(id) ?? "var(--foreground)"}
                source={source}
                samples={samples}
                from={from}
                end={weeksAgo === 0 ? now + WEEK_MS : through}
                now={now}
                live={weeksAgo === 0}
                hours={hours}
                multiplier={multiplier}
                drain={metric === "drain"}
                showAccounts={showAccounts}
                showEmails={showEmails}
                enabled={enabled}
                credentialCount={credentialCount}
              />
            );
          })}
      </div>
      {selected === "" &&
        providers.length > 0 &&
        providers.every(({ provider: id }) => !HUB_PROVIDERS.has(id)) && (
          <p className="text-sm text-muted-foreground">
            <T>This hub has no credentials with supported quota readings.</T>
          </p>
        )}
    </>
  );
}

function QuotaCard({
  label,
  driver,
  color,
  source,
  samples,
  from,
  end,
  now,
  live,
  hours,
  multiplier,
  drain,
  showAccounts,
  showEmails,
  enabled,
  credentialCount,
}: {
  readonly label: string;
  readonly driver: ProviderDriverKind | undefined;
  readonly color: string;
  readonly source: UsageLimitSourceSnapshot;
  readonly samples: readonly UsageQuotaSample[];
  readonly from: number;
  readonly end: number;
  readonly now: number;
  readonly live: boolean;
  readonly hours: number;
  readonly multiplier: number;
  readonly drain: boolean;
  readonly showAccounts: boolean;
  readonly showEmails: boolean;
  readonly enabled: number;
  readonly credentialCount: number;
}) {
  const gt = useGT();
  const locale = useLocale();
  const [windowKey, setWindowKey] = useState("");
  const windows = driver ? quotaWindows(samples, driver) : [];
  const window = windows.find(({ key }) => key === windowKey) ?? windows[0];
  const forecast =
    driver && window
      ? buildQuotaForecast({ samples, driver, window, hours, multiplier, drain, now, end })
      : null;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const percent = (value: number) => gt("{value}%", { value: number.format(value) });
  const rate = (value: number) =>
    gt("{value}%/h", {
      value: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value),
    });
  const moment = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const accounts = source.accounts.filter((account) => account.driver === driver);
  const accountLabel = (key: string) => {
    const index = accounts.findIndex((account) => account.historyKey === key);
    if (index === -1) return gt("Account");
    return (
      (showEmails ? accounts[index]?.email : null) ?? gt("Account {number}", { number: index + 1 })
    );
  };
  const projection = forecast?.projection;
  const refill = projection?.refills[0];
  const firstEmpty = forecast?.firstEmpty;
  const nextReportedRefill = forecast?.accounts
    ? [...forecast.accounts.values()]
        .flatMap(({ effective, weight }) => {
          const at = Date.parse(effective.window.resetsAt ?? "");
          return at > now ? [{ at, restores: effective.refillPercent * weight }] : [];
        })
        .sort((left, right) => left.at - right.at)[0]
    : undefined;
  const nextReset = refill ?? nextReportedRefill;

  return (
    <article className="min-w-0 rounded-xl border border-border/70 bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {driver && (
            <ProviderInstanceIcon
              driverKind={driver}
              displayName={label}
              className="size-4 shrink-0"
            />
          )}
          <h3 className="text-sm font-semibold">{label}</h3>
          <span className="text-xs text-muted-foreground">
            {gt("{count} accounts", { count: number.format(enabled) })}
            {credentialCount > enabled && (
              <> · {gt("{count} disabled", { count: number.format(credentialCount - enabled) })}</>
            )}
          </span>
        </div>
        {window && windows.length > 1 && (
          <div className="max-w-full">
            <QuotaSelect
              label={gt("{provider} quota window", { provider: label })}
              value={window.key}
              options={windows.map(({ key, label }) => ({ value: key, label }))}
              onChange={setWindowKey}
            />
          </div>
        )}
      </div>
      {forecast && window ? (
        <>
          <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
            <div className="flex items-baseline gap-2 tabular-nums">
              {forecast.remaining === undefined ? (
                <span className="text-muted-foreground">
                  <T>Quota unavailable</T>
                </span>
              ) : (
                <>
                  <span className="text-4xl font-semibold tracking-tight">
                    {percent(forecast.remaining)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {gt("of {total}", { total: percent(forecast.capacity ?? 0) })}
                  </span>
                </>
              )}
            </div>
            {live && (
              <dl className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-4">
                <QuotaStat
                  label={gt("Pool empty")}
                  value={
                    forecast.poolEmpty !== null
                      ? moment.format(forecast.poolEmpty)
                      : projection
                        ? gt("Beyond chart range")
                        : gt("Unavailable")
                  }
                />
                <QuotaStat
                  label={gt("First empty")}
                  value={
                    firstEmpty
                      ? `${moment.format(firstEmpty.at)} · ${accountLabel(firstEmpty.key)}`
                      : projection
                        ? gt("Beyond chart range")
                        : gt("Unavailable")
                  }
                />
                <QuotaStat
                  label={gt("Next reset")}
                  value={
                    nextReset
                      ? `+${percent(nextReset.restores)} · ${moment.format(nextReset.at)}`
                      : gt("Unavailable")
                  }
                />
                <QuotaStat
                  label={gt("Burn, last {hours}h", { hours })}
                  value={
                    forecast.hourlyBurn === null ? gt("Unavailable") : rate(forecast.hourlyBurn)
                  }
                />
              </dl>
            )}
          </div>
          <QuotaForecastChart
            from={from}
            to={end}
            now={live ? now : null}
            capacity={forecast.chartCapacity}
            recorded={forecast.recorded}
            projected={drain ? [] : (projection?.points ?? [])}
            resets={[...forecast.observedResets, ...(!drain ? (projection?.refills ?? []) : [])]}
            emptyAt={drain ? null : forecast.poolEmpty}
            drain={drain}
            color={color}
          />
          {live && forecast.stale && (
            <p className="mt-2 text-xs text-muted-foreground">
              <T>Waiting for a current quota reading.</T>
            </p>
          )}
          {live && !forecast.stale && forecast.hourlyBurn === null && (
            <p className="mt-2 text-xs text-muted-foreground">
              <T>Collecting quota history to estimate burn rate.</T>
            </p>
          )}
          {!live && forecast.recorded.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              <T>No quota history for this period.</T>
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {driver ? (
            live ? (
              <T>Waiting for a current quota reading.</T>
            ) : (
              <T>No quota history for this period.</T>
            )
          ) : (
            <T>This provider’s quota is not available from this hub.</T>
          )}
        </p>
      )}
      {showAccounts && accounts.length > 0 && (
        <ul className="mt-4 divide-y divide-border border-t border-border text-xs">
          {accounts.map((account, index) => {
            const key = account.historyKey ?? account.id;
            const member = forecast?.accounts?.get(key);
            const reset = Date.parse(member?.effective.window.resetsAt ?? "");
            const hourly = forecast?.rates.get(key);
            const title =
              (showEmails ? account.email : null) ?? gt("Account {number}", { number: index + 1 });
            return (
              <li
                key={account.id}
                className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 py-2.5"
              >
                <div className="min-w-0">
                  <span className="font-medium break-all">{title}</span>
                  {account.plan && (
                    <span className="ms-2 text-muted-foreground">
                      {account.plan}
                      {member && member.weight !== 1 ? ` · ${number.format(member.weight)}×` : null}
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground tabular-nums">
                  {member
                    ? [
                        percent(100 - member.effective.window.usedPercent),
                        reset > now ? moment.format(reset) : null,
                        hourly === undefined ? null : rate(hourly),
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : gt("Quota unavailable")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

function QuotaStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="max-w-40 font-medium break-words tabular-nums">{value}</dd>
    </div>
  );
}
