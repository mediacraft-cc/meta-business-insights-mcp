/**
 * Peças comuns às tools: dependências injetadas, schemas de entrada repetidos
 * e o formato das respostas.
 */

import * as z from "zod/v4";

import type { Config } from "../config.js";
import { redactDeep, redactText } from "../redact.js";
import { GraphError, type GraphClient } from "../graph/client.js";
import type { PageAsset, PortfolioService } from "../graph/assets.js";
import type { SnapshotStore } from "../store.js";

/**
 * Criadas uma vez por processo em `server.ts`. O HTTP monta um servidor por
 * request, então o cache do portfólio só sobrevive se isto não for recriado.
 */
export interface ToolDeps {
  config: Config;
  client: GraphClient;
  portfolio: PortfolioService;
  store: SnapshotStore;
}

export const granularitySchema = z
  .enum(["day", "week", "month", "quarter", "year"])
  .default("month")
  .describe("Granularidade dos períodos retornados.");

export const assetsSchema = z
  .array(z.string())
  .optional()
  .describe(
    "IDs ou nomes de Páginas / contas do Instagram (@usuario). Vazio = portfólio inteiro.",
  );

export const sinceSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Data inicial YYYY-MM-DD (default: 180 dias atrás).");

export const untilSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Data final YYYY-MM-DD, inclusiva (default: hoje).");

/**
 * Único caminho de saída das tools — por isso a redação de segredos mora aqui:
 * nada sai do servidor sem passar por `text()` ou `fail()`.
 */
export function text(body: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: redactText(body) }],
    ...(structured ? { structuredContent: redactDeep(structured) } : {}),
  };
}

export function fail(err: unknown) {
  const message =
    err instanceof GraphError
      ? `${err.message}${err.fbtraceId ? ` [fbtrace_id: ${err.fbtraceId}]` : ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  // A Graph API às vezes ecoa a URL da chamada na mensagem de erro — e a URL
  // carrega o token.
  return {
    content: [{ type: "text" as const, text: redactText(`Erro: ${message}`) }],
    isError: true,
  };
}

export function assetLine(page: PageAsset): string {
  const ig = page.instagram;
  return ig
    ? `${ig.username ? `@${ig.username}` : ig.id} (${ig.followersCount?.toLocaleString("pt-BR") ?? "—"})`
    : "—";
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function labelOf(granularity: string): string {
  return (
    { day: "dia", week: "semana", month: "mês", quarter: "trimestre", year: "ano" }[
      granularity
    ] ?? granularity
  );
}
