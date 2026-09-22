import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { issuesBlock, markdownTable } from "../lib/format.js";
import { assetLine, fail, sum, text, type ToolDeps } from "./shared.js";

export function registerPortfolioTools(server: McpServer, { client, portfolio }: ToolDeps): void {
  server.registerTool(
    "list_portfolio",
    {
      title: "Listar portfólio",
      description:
        "Lista todas as Páginas do Facebook e contas do Instagram do portfólio (Business Manager), " +
        "com IDs e total de seguidores atual. Use antes das outras tools para descobrir os IDs.",
      inputSchema: z.object({
        refresh: z
          .boolean()
          .default(false)
          .describe("Ignora o cache de 10 minutos e redescobre os ativos."),
      }),
    },
    async ({ refresh }) => {
      try {
        const result = await portfolio.get(refresh);
        const rows = result.pages.map((p) => [
          p.name,
          p.id,
          p.followersCount ?? null,
          assetLine(p),
          p.accessToken ? "ok" : "faltando",
        ]);

        const header = result.businessName
          ? `**Portfólio:** ${result.businessName} (${result.businessId})`
          : "**Portfólio:** descoberto via /me/accounts";

        const totalFb = sum(result.pages.map((p) => p.followersCount ?? 0));
        const totalIg = sum(result.pages.map((p) => p.instagram?.followersCount ?? 0));

        const body = [
          header,
          "",
          markdownTable(
            ["Página", "Page ID", "Seguidores FB", "Instagram (seguidores)", "Page token"],
            rows,
          ),
          "",
          `**${result.pages.length} páginas** · Facebook: ${totalFb.toLocaleString("pt-BR")} seguidores · Instagram: ${totalIg.toLocaleString("pt-BR")} seguidores`,
        ].join("\n");

        return text(body + issuesBlock(
          result.warnings.map((w) => ({ assetName: "portfólio", surface: "geral", message: w })),
        ), {
          businessId: result.businessId,
          businessName: result.businessName,
          pages: result.pages.map((p) => ({
            id: p.id,
            name: p.name,
            followersCount: p.followersCount ?? null,
            hasPageToken: Boolean(p.accessToken),
            instagram: p.instagram ?? null,
            source: p.source,
          })),
          totals: { facebook: totalFb, instagram: totalIg },
          warnings: result.warnings,
        });
      } catch (err) {
        return fail(err, client);
      }
    },
  );
}
