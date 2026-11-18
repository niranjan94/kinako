import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { QuotaForecastChart } from "./QuotaForecastChart";

it("lets keyboard and pointer users tell recorded quota from projected quota", async () => {
  const from = Date.parse("2026-11-18T00:00:00Z");
  const hour = 3_600_000;
  const now = from + hour;
  const to = from + 2 * hour;
  await using screen = await render(
    <QuotaForecastChart
      from={from}
      to={to}
      now={now}
      capacity={100}
      recorded={[
        [
          { at: from, value: 90 },
          { at: now, value: 75 },
        ],
      ]}
      projected={[
        { at: now, value: 75 },
        { at: to, value: 60 },
      ]}
      resets={[]}
      emptyAt={null}
      drain={false}
      color="#6c9df8"
    />,
  );

  const chart = screen.getByRole("img", { name: "Recorded and projected quota remaining" });
  await chart.hover({ position: { x: 2, y: 20 } });
  await expect.element(screen.getByText("90% · Recorded", { exact: false })).toBeVisible();

  await userEvent.tab();
  await expect.element(screen.getByRole("slider", { name: "Explore quota chart" })).toHaveFocus();
  await expect.element(screen.getByText("60% · Projected", { exact: false })).toBeVisible();
  await userEvent.keyboard("{Home}");
  await expect.element(screen.getByText("90% · Recorded", { exact: false })).toBeVisible();
});
