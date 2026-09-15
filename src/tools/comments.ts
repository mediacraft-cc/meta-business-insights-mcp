import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { fetchComments } from "../comments.js";
import { resolveRange } from "../dates.js";
import { issuesBlock, markdownTable } from "../format.js";
import {
  assetLine,
  assetsSchema,
  fail,
  sinceSchema,
  text,
  untilSchema,
  type ToolDeps,
} from "./shared.js";

export function registerCommentTools(
  server: McpServer,
  { client, portfolio }: ToolDeps,
  { canWrite }: { canWrite: boolean },
): void {
  server.registerTool(
    "content_comments",
    {
      title: "Comentários das publicações",
      description:
        "Lê os comentários das publicações do período, das duas redes. Serve para diagnóstico " +
        "de reclamações, dúvidas recorrentes e sentimento. O Facebook geralmente não informa " +
        "o autor (só perfis que consentiram); o Instagram informa o @usuario. " +
        "Use `contains` para filtrar por palavra.",
      inputSchema: z.object({
        assets: assetsSchema,
        since: sinceSchema,
        until: untilSchema,
        surfaces: z
          .array(z.enum(["facebook", "instagram"]))
          .default(["facebook", "instagram"]),
        contains: z
          .string()
          .optional()
          .describe("Filtra comentários que contenham este texto (sem diferenciar maiúsculas)."),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    },
    async ({ assets, since, until, surfaces, contains, limit }) => {
      try {
        const pages = await portfolio.resolveTargets(assets);
        const range = resolveRange(since, until, 30);
        const { rows, issues } = await fetchComments(client, pages, range, surfaces);

        const needle = contains?.toLowerCase();
        const filtered = needle
          ? rows.filter((r) => r.text.toLowerCase().includes(needle))
          : rows;
        const shown = filtered.slice(0, limit);

        const table = shown.map((r) => [
          r.date,
          r.surface === "facebook" ? "FB" : "IG",
          r.assetName,
          r.author ?? "—",
          r.text,
          r.postCaption,
        ]);

        const head =
          `**Comentários** · ${range.since} → ${range.until} · ` +
          `${filtered.length} encontrados` +
          (needle ? ` contendo "${contains}"` : "") +
          (shown.length < filtered.length ? ` (exibindo ${shown.length})` : "");

        return text(
          `${head}\n\n` +
            markdownTable(
              ["Data", "Rede", "Ativo", "Autor", "Comentário", "Publicação"],
              table,
              { emptyMessage: "_Nenhum comentário no período._" },
            ) +
            issuesBlock(
              issues.map((i) => ({
                assetName: i.asset,
                surface: "comentários",
                message: i.detail,
              })),
            ),
          { since: range.since, until: range.until, count: filtered.length, comments: shown },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* -------------------------------- escrita ------------------------------- */

  if (!canWrite) return;

  server.registerTool(
    "reply_comment",
    {
      title: "Responder comentário",
      description:
        "Publica uma resposta a um comentário, em nome da conta. A resposta é pública e " +
        "imediata. Sem `confirm: true` a tool apenas devolve a prévia do que seria " +
        "publicado, sem chamar a API — use isso para revisar o texto antes. " +
        "Pegue o `commentId` e o `surface` na saída de content_comments.",
      inputSchema: z.object({
        asset: z
          .string()
          .describe("Página ou conta do Instagram dona da publicação (ID, nome ou @usuario)."),
        surface: z.enum(["facebook", "instagram"]),
        commentId: z.string().describe("ID do comentário a responder."),
        message: z.string().min(1).describe("Texto da resposta."),
        confirm: z
          .boolean()
          .default(false)
          .describe("Falso devolve a prévia; verdadeiro publica de fato."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ asset, surface, commentId, message, confirm }) => {
      try {
        const [page] = await portfolio.resolveTargets([asset]);
        if (!page) return fail(new Error(`Ativo não encontrado: ${asset}`));

        if (!confirm) {
          return text(
            `**Prévia — nada foi publicado.**\n\n` +
              `- Conta: ${surface === "facebook" ? page.name : assetLine(page)}\n` +
              `- Comentário: \`${commentId}\`\n` +
              `- Resposta:\n\n> ${message.replace(/\n/g, "\n> ")}\n\n` +
              `Para publicar, repita com \`confirm: true\`.`,
            { preview: true, asset: page.name, surface, commentId, message },
          );
        }

        // Os dois endpoints diferem: no Facebook a resposta é um comentário
        // do comentário; no Instagram existe uma edge própria.
        const path =
          surface === "facebook"
            ? `/${commentId}/comments`
            : `/${commentId}/replies`;
        const result = await client.post<{ id?: string }>(
          path,
          { message },
          { token: page.accessToken },
        );
        auditWrite("reply_comment", {
          asset: page.name,
          surface,
          commentId,
          replyId: result.id,
          chars: message.length,
        });

        return text(
          `Resposta publicada em ${surface === "facebook" ? page.name : assetLine(page)}.\n\n` +
            `- Comentário respondido: \`${commentId}\`\n` +
            `- ID da resposta: \`${result.id ?? "?"}\``,
          { published: true, surface, commentId, replyId: result.id, message },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "hide_comment",
    {
      title: "Ocultar ou reexibir comentário",
      description:
        "Oculta um comentário da publicação (ou o reexibe com `hidden: false`). " +
        "Ocultar não notifica o autor e mantém o comentário visível para ele — " +
        "é o caminho usual para spam e golpe, menos abrasivo que excluir.",
      inputSchema: z.object({
        asset: z.string(),
        surface: z.enum(["facebook", "instagram"]),
        commentId: z.string(),
        hidden: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ asset, surface, commentId, hidden }) => {
      try {
        const [page] = await portfolio.resolveTargets([asset]);
        if (!page) return fail(new Error(`Ativo não encontrado: ${asset}`));

        const body =
          surface === "facebook" ? { is_hidden: hidden } : { hide: hidden };
        await client.post(`/${commentId}`, body, { token: page.accessToken });
        auditWrite("hide_comment", { asset: page.name, surface, commentId, hidden });

        return text(
          `Comentário \`${commentId}\` ${hidden ? "ocultado" : "reexibido"}.`,
          { commentId, hidden, surface },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * Registra escritas em stderr — no modo HTTP isso cai no journal do systemd,
 * ao lado da linha de request que já identifica quem chamou. Publicar em nome
 * de um cliente sem deixar rastro não é aceitável.
 */
function auditWrite(action: string, detail: Record<string, unknown>): void {
  process.stderr.write(
    `[${new Date().toISOString()}] ESCRITA ${action} ${JSON.stringify(detail)}\n`,
  );
}
