import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { fetchFollowerSeries } from "../meta/followers.js";
import { resolveRange, today, type Granularity } from "../lib/dates.js";
import { formatPct, formatSigned, issuesBlock, markdownTable, section } from "../lib/format.js";
import {
  assetsSchema,
  fail,
  granularitySchema,
  labelOf,
  sinceSchema,
  sum,
  text,
  untilSchema,
  type ToolDeps,
} from "./shared.js";

export function registerFollowerTools(
  server: McpServer,
  { config, client, portfolio }: ToolDeps,
): void {
  server.registerTool(
    "followers_overview",
    {
      title: "Seguidores agora",
      description:
        "Foto do momento: total de seguidores por ativo e consolidado do portfólio " +
        "(Facebook + Instagram). Inclui crescimento orgânico e pago, pois usa o número real da conta.",
      inputSchema: z.object({
        assets: assetsSchema,
      }),
    },
    async ({ assets }) => {
      try {
        const pages = await portfolio.resolveTargets(assets);
        const rows: Array<[string, string, string, number | null]> = [];
        for (const page of pages) {
          rows.push(["Facebook", page.name, page.id, page.followersCount ?? null]);
          if (page.instagram) {
            rows.push([
              "Instagram",
              page.instagram.username ? `@${page.instagram.username}` : (page.instagram.name ?? page.instagram.id),
              page.instagram.id,
              page.instagram.followersCount ?? null,
            ]);
          }
        }

        const total = sum(rows.map((r) => r[3] ?? 0));
        const body = [
          markdownTable(["Rede", "Ativo", "ID", "Seguidores"], rows),
          "",
          `**Total do portfólio: ${total.toLocaleString("pt-BR")} seguidores** (${rows.length} ativos, em ${today()})`,
        ].join("\n");

        return text(body, {
          date: today(),
          assets: rows.map(([surface, name, id, followers]) => ({
            surface,
            name,
            id,
            followers,
          })),
          total,
        });
      } catch (err) {
        return fail(err, client);
      }
    },
  );

  server.registerTool(
    "followers_timeseries",
    {
      title: "Seguidores por período",
      description:
        "Evolução de seguidores por mês (ou dia/semana/trimestre/ano), com ganhos, perdas, " +
        "saldo e total acumulado ao fim de cada período — orgânico + pago juntos. " +
        "Cobre Facebook e Instagram, por ativo ou consolidado no portfólio.",
      inputSchema: z.object({
        assets: assetsSchema,
        since: sinceSchema,
        until: untilSchema,
        granularity: granularitySchema,
        surface: z
          .enum(["all", "facebook", "instagram"])
          .default("all")
          .describe("Filtra a rede."),
        consolidate: z
          .boolean()
          .default(false)
          .describe(
            "true soma todos os ativos em uma única linha por período (visão de portfólio).",
          ),
      }),
    },
    async ({ assets, since, until, granularity, surface, consolidate }) => {
      try {
        const pages = await portfolio.resolveTargets(assets);
        const range = resolveRange(since, until, 365);
        const result = await fetchFollowerSeries(
          client,
          pages,
          { ...range, granularity: granularity as Granularity },
          config.accessToken,
        );

        let rows = result.rows;
        if (surface !== "all") rows = rows.filter((r) => r.surface === surface);

        if (consolidate) {
          const byPeriod = new Map<
            string,
            { gained: number; lost: number; total: number; estimated: boolean; assets: number }
          >();
          for (const row of rows) {
            const slot =
              byPeriod.get(row.period) ??
              { gained: 0, lost: 0, total: 0, estimated: false, assets: 0 };
            byPeriod.set(row.period, slot);
            slot.gained += row.gained ?? 0;
            slot.lost += row.lost ?? 0;
            slot.total += row.total ?? 0;
            slot.estimated ||= row.totalIsEstimated;
            slot.assets += 1;
          }

          const consolidated = [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b));
          let prevTotal: number | undefined;
          const table = consolidated.map(([period, s]) => {
            const delta = prevTotal === undefined ? null : s.total - prevTotal;
            const pct = prevTotal ? ((s.total - prevTotal) / prevTotal) * 100 : null;
            prevTotal = s.total;
            return [
              period,
              s.assets,
              s.gained,
              -s.lost,
              formatSigned(s.gained - s.lost),
              s.total,
              formatPct(pct ?? undefined),
            ];
          });

          const body = [
            section(
              `Seguidores do portfólio por ${labelOf(granularity)}`,
              markdownTable(
                ["Período", "Ativos", "Ganhos", "Perdidos", "Saldo", "Total", "Var. total"],
                table,
              ),
            ),
            "",
            "_Totais do Instagram são reconstruídos a partir do número atual de seguidores (a API não expõe histórico acumulado)._",
          ].join("\n");

          return text(body + issuesBlock(result.issues), {
            granularity,
            range,
            consolidated: consolidated.map(([period, s]) => ({
              period,
              assets: s.assets,
              gained: s.gained,
              lost: s.lost,
              net: s.gained - s.lost,
              total: s.total,
              totalIsEstimated: s.estimated,
            })),
            issues: result.issues,
          });
        }

        const table = rows.map((r) => [
          r.period,
          r.surface === "facebook" ? "FB" : "IG",
          r.assetName,
          r.gained,
          r.lost === null ? null : -r.lost,
          formatSigned(r.net),
          r.total,
          r.totalIsEstimated ? "estimado" : "API",
        ]);

        const body = section(
          `Seguidores por ${labelOf(granularity)}`,
          markdownTable(
            ["Período", "Rede", "Ativo", "Ganhos", "Perdidos", "Saldo", "Total", "Fonte do total"],
            table,
          ),
        );

        return text(body + issuesBlock(result.issues), {
          granularity,
          range,
          rows,
          currentTotals: result.currentTotals,
          issues: result.issues,
        });
      } catch (err) {
        return fail(err, client);
      }
    },
  );
}
