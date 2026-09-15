import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { captureSnapshot } from "../storage/snapshot.js";
import { markdownTable } from "../lib/format.js";
import { assetsSchema, fail, sinceSchema, text, untilSchema, type ToolDeps } from "./shared.js";

export function registerSnapshotTools(server: McpServer, { portfolio, store }: ToolDeps): void {
  server.registerTool(
    "save_followers_snapshot",
    {
      title: "Gravar snapshot de seguidores",
      description:
        "Grava o total de seguidores de todos os ativos em um histórico local. " +
        "Útil porque a Graph API só devolve 30 dias de histórico de seguidores do Instagram — " +
        "rodando isso periodicamente o portfólio constrói a própria série longa.",
      inputSchema: z.object({
        assets: assetsSchema,
        date: sinceSchema.describe("Data do snapshot (default: hoje)."),
      }),
    },
    async ({ assets, date }) => {
      try {
        const result = await captureSnapshot(portfolio, store, { assets, date });
        return text(
          `Gravados **${result.written}** snapshots de ${result.date} ` +
            `(${result.total} no histórico).\n\nArquivo: \`${result.file}\``,
          { ...result },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "snapshot_history",
    {
      title: "Histórico local de seguidores",
      description:
        "Lê a série de seguidores gravada localmente por save_followers_snapshot, " +
        "sem depender da janela curta da Graph API.",
      inputSchema: z.object({
        assets: assetsSchema,
        since: sinceSchema,
        until: untilSchema,
      }),
    },
    async ({ assets, since, until }) => {
      try {
        const assetIds = assets
          ? (await portfolio.resolveTargets(assets)).flatMap((p) =>
              p.instagram ? [p.id, p.instagram.id] : [p.id],
            )
          : undefined;
        const snapshots = store.query({ since, until, assetIds });
        const table = snapshots.map((s) => [
          s.date,
          s.surface === "facebook" ? "FB" : "IG",
          s.assetName,
          s.followers,
        ]);
        return text(
          markdownTable(["Data", "Rede", "Ativo", "Seguidores"], table, {
            emptyMessage:
              "_Histórico vazio. Rode save_followers_snapshot para começar a acumular._",
          }),
          { snapshots, file: store.path },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
