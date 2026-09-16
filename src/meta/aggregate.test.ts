import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregate, withDeltas } from "./aggregate.js";
import type { MetricSeries } from "./insights.js";

function serie(
  assetId: string,
  assetName: string,
  metric: string,
  points: Array<[string, number]>,
  surface: "facebook" | "instagram" = "facebook",
): MetricSeries {
  return {
    assetId,
    assetName,
    surface,
    metric,
    period: "day",
    points: points.map(([date, value]) => ({ date, value })),
  };
}

const series = [
  serie("1", "Loja A", "page_views_total", [
    ["2026-01-05", 10],
    ["2026-01-20", 5],
    ["2026-02-10", 7],
  ]),
  serie("2", "Loja B", "page_views_total", [
    ["2026-01-05", 100],
    ["2026-02-10", 1],
  ]),
];

describe("aggregate", () => {
  it("soma os dias dentro do período, por ativo", () => {
    const rows = aggregate(series, {
      granularity: "month",
      groupBy: ["period", "asset", "metric"],
      aggregation: "sum",
    });
    assert.deepEqual(
      rows.map((r) => [r.period, r.asset, r.value, r.samples]),
      [
        ["2026-01", "Loja A", 15, 2],
        ["2026-01", "Loja B", 100, 1],
        ["2026-02", "Loja A", 7, 1],
        ["2026-02", "Loja B", 1, 1],
      ],
    );
  });

  it("consolida o portfólio quando 'asset' sai do groupBy", () => {
    const rows = aggregate(series, {
      granularity: "month",
      groupBy: ["period", "metric"],
      aggregation: "sum",
    });
    assert.deepEqual(
      rows.map((r) => [r.period, r.value, r.samples]),
      [
        ["2026-01", 115, 3],
        ["2026-02", 8, 2],
      ],
    );
    assert.equal(rows[0]!.asset, undefined);
  });

  it("aplica avg, max, min e last", () => {
    const opts = { granularity: "year", groupBy: ["period"] } as const;
    const um = [serie("1", "Loja A", "m", [["2026-01-01", 2], ["2026-06-01", 8]])];
    const valor = (aggregation: "avg" | "max" | "min" | "last") =>
      aggregate(um, { ...opts, groupBy: [...opts.groupBy], aggregation })[0]!.value;

    assert.equal(valor("avg"), 5);
    assert.equal(valor("max"), 8);
    assert.equal(valor("min"), 2);
    assert.equal(valor("last"), 8);
  });

  it("'last' usa a data, não a ordem de chegada da API", () => {
    const foraDeOrdem = [
      serie("1", "Loja A", "page_follows", [
        ["2026-06-01", 8],
        ["2026-01-01", 2],
      ]),
    ];
    const [row] = aggregate(foraDeOrdem, {
      granularity: "year",
      groupBy: ["period"],
      aggregation: "last",
    });
    assert.equal(row!.value, 8);
  });

  it("separa séries de métricas diferentes", () => {
    const rows = aggregate(
      [
        serie("1", "Loja A", "views", [["2026-01-05", 10]]),
        serie("1", "Loja A", "reach", [["2026-01-05", 3]]),
      ],
      { granularity: "month", groupBy: ["period", "metric"], aggregation: "sum" },
    );
    assert.deepEqual(
      rows.map((r) => [r.metric, r.value]),
      [
        ["reach", 3],
        ["views", 10],
      ],
    );
  });
});

describe("withDeltas", () => {
  it("compara com o período anterior da mesma série", () => {
    const rows = withDeltas(
      aggregate(series, {
        granularity: "month",
        groupBy: ["period", "asset", "metric"],
        aggregation: "sum",
      }),
    );
    const lojaA = rows.filter((r) => r.asset === "Loja A");
    assert.equal(lojaA[0]!.delta, undefined);
    assert.equal(lojaA[1]!.delta, -8);
    assert.equal(Math.round(lojaA[1]!.deltaPct!), -53);
  });

  it("não divide por zero quando o período anterior foi zero", () => {
    const rows = withDeltas([
      { period: "2026-01", metric: "m", value: 0, samples: 1 },
      { period: "2026-02", metric: "m", value: 5, samples: 1 },
    ]);
    assert.equal(rows[1]!.delta, 5);
    assert.equal(rows[1]!.deltaPct, undefined);
  });
});
