import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { fetchContent } from "../content.js";
import { resolveRange } from "../dates.js";
import { MS_METRICS } from "../metrics.js";
import { issuesBlock, markdownTable } from "../format.js";
import { assetsSchema, fail, sinceSchema, text, untilSchema, type ToolDeps } from "./shared.js";

/**
 * Colunas comparáveis entre Facebook e Instagram. A ordem aqui é a ordem da
 * tabela; `saved` fica vazio no Facebook, que não tem o conceito.
 */
const NORMALIZED_COLUMNS: Record<string, string> = {
  views: "Views",
  likes: "Curtidas",
  comments: "Comentários",
  shares: "Compart.",
  saved: "Salvos",
  interactions: "Interações",
};

export function registerContentTools(server: McpServer, { client, portfolio }: ToolDeps): void {
  server.registerTool(
    "content_insights",
    {
      title: "Desempenho por publicação",
      description:
        "Desempenho de cada publicação no período — o equivalente à aba Conteúdo do " +
        "Business Suite. Responde 'quais posts tiveram mais curtidas/salvamentos/comentários', " +
        "'reels versus carrossel', 'os 10 melhores do trimestre'. Uma linha por publicação, " +
        "ordenada pela métrica escolhida. Atenção: no Facebook 'likes' é o total de reações " +
        "(curtida + amei + haha…), e 'saved' só existe no Instagram.",
      inputSchema: z.object({
        assets: assetsSchema,
        since: sinceSchema,
        until: untilSchema,
        surfaces: z
          .array(z.enum(["facebook", "instagram"]))
          .default(["facebook", "instagram"])
          .describe("Redes a incluir."),
        sortBy: z
          .string()
          .default("interactions")
          .describe(
            "Ordena por: interactions, views, likes, comments, shares, saved — ou o nome cru " +
              "de uma métrica da API (reach, ig_reels_avg_watch_time, post_clicks…).",
          ),
        limit: z.number().int().min(1).max(200).default(20),
      }),
    },
    async ({ assets, since, until, surfaces, sortBy, limit }) => {
      try {
        const pages = await portfolio.resolveTargets(assets);
        const range = resolveRange(since, until, 90);
        const { rows, issues } = await fetchContent(client, pages, range, surfaces);

        const valueOf = (row: (typeof rows)[number]) =>
          row.normalized[sortBy] ?? row.raw[sortBy] ?? -1;
        const top = [...rows].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, limit);

        const extra = sortBy in NORMALIZED_COLUMNS ? [] : [sortBy];
        const headers = [
          "Data",
          "Rede",
          "Ativo",
          "Tipo",
          "Publicação",
          ...Object.values(NORMALIZED_COLUMNS),
          ...extra.map(metricLabel),
        ];

        const table = top.map((row) => [
          row.date,
          row.surface === "facebook" ? "FB" : "IG",
          row.assetName,
          row.type,
          snippet(row.caption),
          ...Object.keys(NORMALIZED_COLUMNS).map((k) => row.normalized[k] ?? null),
          ...extra.map((k) => formatMetric(k, row.raw[k])),
        ]);

        const head =
          `**Publicações** · ${range.since} → ${range.until} · ordenado por ${sortBy} · ` +
          `${rows.length} no período (exibindo ${top.length})`;

        return text(
          `${head}\n\n${markdownTable(headers, table)}` +
            issuesBlock(
              issues.map((i) => ({
                assetName: i.asset,
                surface: "conteúdo",
                message: i.detail,
              })),
            ),
          { since: range.since, until: range.until, sortBy, count: rows.length, posts: top },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** Trecho da legenda que cabe numa célula sem quebrar a tabela. */
function snippet(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text || "—";
}

function metricLabel(metric: string): string {
  return MS_METRICS.has(metric) ? `${metric} (s)` : metric;
}

/**
 * A Graph API devolve tempo de visualização em milissegundos, enquanto o
 * Business Suite mostra segundos. Converter aqui evita relatório errado por um
 * fator de mil.
 */
function formatMetric(metric: string, value: number | undefined): number | null {
  if (value === undefined) return null;
  return MS_METRICS.has(metric) ? Math.round(value / 100) / 10 : value;
}
