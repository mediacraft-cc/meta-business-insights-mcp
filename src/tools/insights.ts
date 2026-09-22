import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  fetchInstagramInsights,
  fetchPageInsights,
  type FetchIssue,
  type MetricSeries,
} from "../meta/insights.js";
import { aggregate, withDeltas, type GroupDimension } from "../meta/aggregate.js";
import { resolveRange, type Granularity } from "../lib/dates.js";
import { IG_METRICS, PAGE_DEPRECATIONS, PAGE_METRICS, checkDeprecated } from "../meta/metrics.js";
import { formatPct, formatSigned, issuesBlock, markdownTable, section } from "../lib/format.js";
import {
  assetsSchema,
  fail,
  granularitySchema,
  labelOf,
  sinceSchema,
  text,
  untilSchema,
  type ToolDeps,
} from "./shared.js";

const insightsInput = z.object({
  metrics: z
    .array(z.string())
    .min(1)
    .describe("Métricas da Graph API. Use list_metrics para ver as válidas."),
  assets: assetsSchema,
  since: sinceSchema,
  until: untilSchema,
  granularity: granularitySchema,
  aggregation: z
    .enum(["sum", "avg", "max", "min", "last"])
    .default("sum")
    .describe("Como consolidar os dias dentro de cada período."),
  groupBy: z
    .array(z.enum(["period", "asset", "surface", "metric", "breakdown"]))
    .default(["period", "asset", "metric"])
    .describe("Dimensões da saída. Remova 'asset' para consolidar o portfólio."),
  includeDeltas: z
    .boolean()
    .default(false)
    .describe("Acrescenta variação vs. o período anterior."),
});

export function registerInsightTools(
  server: McpServer,
  { config, client, portfolio }: ToolDeps,
): void {
  server.registerTool(
    "page_insights",
    {
      title: "Insights de Páginas do Facebook",
      description:
        "Métricas orgânicas de Páginas do Facebook, agregadas do jeito que você pedir " +
        "(por mês, por conta, consolidado no portfólio). Ex.: page_follows, " +
        "page_daily_follows_unique, page_views_total, page_post_engagements.",
      inputSchema: insightsInput.extend({
        period: z
          .enum(["day", "week", "days_28"])
          .default("day")
          .describe("Janela nativa da métrica na Graph API."),
      }),
    },
    async (input) => {
      try {
        const pages = await portfolio.resolveTargets(input.assets);
        const range = resolveRange(input.since, input.until, 180);
        const notes = input.metrics
          .map((m) => checkDeprecated(m, "page"))
          .filter(Boolean) as string[];

        const result = await fetchPageInsights(
          client,
          pages,
          { metrics: input.metrics, ...range, period: input.period },
          config.accessToken,
        );

        return text(
          renderInsights(result.series, result.issues, input, range, notes),
          {
            range,
            rows: aggregate(result.series, {
              granularity: input.granularity as Granularity,
              groupBy: input.groupBy as GroupDimension[],
              aggregation: input.aggregation,
            }),
            issues: result.issues,
            deprecationNotes: notes,
          },
        );
      } catch (err) {
        return fail(err, client);
      }
    },
  );

  server.registerTool(
    "instagram_insights",
    {
      title: "Insights de contas do Instagram",
      description:
        "Métricas orgânicas de contas do Instagram do portfólio, agregadas por período/conta. " +
        "Ex.: reach, views, profile_views, accounts_engaged, total_interactions, follows_and_unfollows.",
      inputSchema: insightsInput.extend({
        breakdown: z
          .string()
          .optional()
          .describe(
            "Breakdown opcional: follow_type, media_product_type, contact_button_type, age, city, country, gender.",
          ),
        timeframe: z
          .string()
          .optional()
          .describe(
            "Obrigatório para métricas demográficas: this_week, this_month, last_14_days, last_30_days, last_90_days, prev_month.",
          ),
      }),
    },
    async (input) => {
      try {
        const pages = await portfolio.resolveTargets(input.assets);
        const range = resolveRange(input.since, input.until, 90);
        const notes = input.metrics
          .map((m) => checkDeprecated(m, "instagram"))
          .filter(Boolean) as string[];

        const result = await fetchInstagramInsights(
          client,
          pages,
          {
            metrics: input.metrics,
            ...range,
            granularity: input.granularity as Granularity,
            breakdown: input.breakdown,
            timeframe: input.timeframe,
          },
          config.accessToken,
        );

        return text(
          renderInsights(result.series, result.issues, input, range, notes),
          {
            range,
            rows: aggregate(result.series, {
              granularity: input.granularity as Granularity,
              groupBy: input.groupBy as GroupDimension[],
              aggregation: input.aggregation,
            }),
            issues: result.issues,
            deprecationNotes: notes,
          },
        );
      } catch (err) {
        return fail(err, client);
      }
    },
  );

  server.registerTool(
    "list_metrics",
    {
      title: "Métricas disponíveis",
      description:
        "Catálogo das métricas orgânicas de Page e Instagram Insights, com o mapa das " +
        "métricas descontinuadas pelo Meta e seus substitutos.",
      inputSchema: z.object({
        surface: z.enum(["all", "facebook", "instagram"]).default("all"),
      }),
    },
    async ({ surface }) => {
      const parts: string[] = [];
      if (surface !== "instagram") {
        parts.push(
          section(
            "Facebook Page Insights",
            markdownTable(
              ["Métrica", "Períodos", "Descrição"],
              PAGE_METRICS.map((m) => [m.name, m.periods.join(", "), m.description]),
            ),
          ),
        );
      }
      if (surface !== "facebook") {
        parts.push(
          section(
            "Instagram Insights",
            markdownTable(
              ["Métrica", "Períodos", "Descrição"],
              IG_METRICS.map((m) => [m.name, m.periods.join(", "), m.description]),
            ),
          ),
        );
      }
      parts.push(
        section(
          "Descontinuadas pelo Meta → substituto",
          markdownTable(
            ["Antiga", "Usar no lugar"],
            Object.entries(PAGE_DEPRECATIONS).map(([o, n]) => [o, n]),
          ),
        ),
      );
      return text(parts.join("\n\n"), {
        page: PAGE_METRICS,
        instagram: IG_METRICS,
        deprecations: PAGE_DEPRECATIONS,
      });
    },
  );
}

function renderInsights(
  series: MetricSeries[],
  issues: FetchIssue[],
  input: {
    granularity: string;
    groupBy: string[];
    aggregation: "sum" | "avg" | "max" | "min" | "last";
    includeDeltas: boolean;
    metrics: string[];
  },
  range: { since: string; until: string },
  notes: string[],
): string {
  const rows = aggregate(series, {
    granularity: input.granularity as Granularity,
    groupBy: input.groupBy as GroupDimension[],
    aggregation: input.aggregation,
  });
  const enriched = input.includeDeltas ? withDeltas(rows) : rows;

  const headers: string[] = [];
  if (input.groupBy.includes("period")) headers.push("Período");
  if (input.groupBy.includes("surface")) headers.push("Rede");
  if (input.groupBy.includes("asset")) headers.push("Ativo");
  if (input.groupBy.includes("metric")) headers.push("Métrica");
  if (input.groupBy.includes("breakdown")) headers.push("Breakdown");
  headers.push("Valor");
  if (input.includeDeltas) headers.push("Δ", "Δ%");

  const table = enriched.map((row) => {
    const cells: Array<string | number | null> = [];
    if (input.groupBy.includes("period")) cells.push(row.period ?? "—");
    if (input.groupBy.includes("surface")) cells.push(row.surface ?? "—");
    if (input.groupBy.includes("asset")) cells.push(row.asset ?? "—");
    if (input.groupBy.includes("metric")) cells.push(row.metric ?? "—");
    if (input.groupBy.includes("breakdown")) cells.push(row.breakdown || "—");
    cells.push(row.value);
    if (input.includeDeltas) {
      const e = row as { delta?: number; deltaPct?: number };
      cells.push(formatSigned(e.delta), formatPct(e.deltaPct));
    }
    return cells;
  });

  const head = `**${input.metrics.join(", ")}** · ${range.since} → ${range.until} · ${input.aggregation} por ${labelOf(input.granularity)}`;
  const notesBlock = notes.length > 0 ? `\n\n> ${notes.join("\n> ")}` : "";

  return (
    `${head}${notesBlock}\n\n${markdownTable(headers, table)}` +
    issuesBlock(issues)
  );
}
