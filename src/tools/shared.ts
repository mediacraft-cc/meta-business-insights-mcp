/**
 * Peças comuns às tools: dependências injetadas, schemas de entrada repetidos
 * e o formato das respostas.
 */

import * as z from "zod/v4";

import type { Config } from "../config.js";
import type { ResponseCache } from "../lib/cache.js";
import { redactDeep, redactText } from "../lib/redact.js";
import { GraphError, type GraphClient } from "../meta/client.js";
import { describeUsage } from "../meta/usage.js";
import type { PageAsset, PortfolioService } from "../meta/assets.js";
import type { SnapshotStore } from "../storage/store.js";

/**
 * Criadas uma vez por processo em `server.ts`. O HTTP monta um servidor por
 * request, então o cache do portfólio só sobrevive se isto não for recriado.
 */
export interface ToolDeps {
  config: Config;
  client: GraphClient;
  portfolio: PortfolioService;
  store: SnapshotStore;
  cache: ResponseCache;
}

/**
 * Formato de saída de toda tool. O índice aberto é o do `CallToolResult` do
 * SDK: sem ele, este tipo não é aceito no lugar do retorno esperado.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Responde do cache quando a mesma pergunta já foi feita.
 *
 * A chave tem que vir pronta de quem chama, e depois de resolver ativos e
 * intervalo — ver `cacheKey`. Erro nunca é guardado: um limite de um minuto
 * viraria dez minutos de erro repetido.
 */
export async function served(
  cache: ResponseCache,
  client: GraphClient,
  key: string,
  ttlMs: number,
  produce: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const hit = cache.get<ToolResult>(key);
  if (hit?.fresh) {
    return withCacheNote(
      hit.value,
      `_Resposta do cache, de ${ageLabel(Date.now() - hit.at)}. Os números do Meta só consolidam depois de ~2 dias, então repetir a consulta agora devolveria o mesmo._`,
      { hit: true, at: new Date(hit.at).toISOString(), stale: false },
    );
  }

  try {
    const result = await produce();
    cache.set(key, result, ttlMs);
    return result;
  } catch (err) {
    // Cota estourada com uma resposta velha na mão: um número datado vale mais
    // que um erro. O TTL vencido não apaga a entrada justamente para isto.
    if (hit && err instanceof GraphError && err.isRateLimit) {
      const usage = client.usage.forPath(err.path)[0] ?? client.usage.worst();
      const volta =
        usage && usage.regainAccessInMinutes > 0
          ? ` Libera em ~${Math.ceil(usage.regainAccessInMinutes)} min — peça de novo depois disso para o número fresco.`
          : " Peça de novo em alguns minutos para o número fresco.";

      return withCacheNote(
        hit.value,
        `_Dado de ${ageLabel(Date.now() - hit.at)} atrás, servido porque a cota do Meta para este ativo está estourada.${volta}_`,
        {
          hit: true,
          at: new Date(hit.at).toISOString(),
          stale: true,
          regainAccessInMinutes: usage?.regainAccessInMinutes ?? null,
        },
      );
    }
    throw err;
  }
}

/** "3 min" / "2 h" — precisão suficiente para decidir se vale repetir. */
export function ageLabel(ms: number): string {
  const minutos = Math.round(ms / 60_000);
  if (minutos < 1) return "menos de 1 min";
  if (minutos < 60) return `${minutos} min`;
  return `${Math.round(minutos / 6) / 10} h`;
}

/**
 * Acrescenta a procedência à resposta guardada. Vai no texto **e** no
 * `structuredContent`: o texto é o que o modelo lê para avisar o usuário, o
 * campo é o que dá para conferir sem interpretar prosa.
 */
function withCacheNote(
  result: ToolResult,
  note: string,
  meta: Record<string, unknown>,
): ToolResult {
  const content = result.content.map((block, i) =>
    i === result.content.length - 1
      ? { ...block, text: `${block.text}\n\n${note}` }
      : block,
  );
  return {
    ...result,
    content,
    ...(result.structuredContent
      ? { structuredContent: { ...result.structuredContent, cache: meta } }
      : {}),
  };
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

export function fail(err: unknown, client?: GraphClient) {
  const message =
    err instanceof GraphError
      ? `${err.message}${err.fbtraceId ? ` [fbtrace_id: ${err.fbtraceId}]` : ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  // A Graph API às vezes ecoa a URL da chamada na mensagem de erro — e a URL
  // carrega o token.
  return {
    content: [
      { type: "text" as const, text: redactText(`Erro: ${message}${quotaHint(err, client)}`) },
    ],
    isError: true,
  };
}

/**
 * Traduz "erro 80005" em algo acionável.
 *
 * Sem isto, o modelo do outro lado só sabe que falhou — e a reação natural é
 * tentar de novo, que é exatamente o que não ajuda. Com o medidor, ele sabe
 * quanto falta e pode pedir ao usuário que espere o tempo certo.
 */
function quotaHint(err: unknown, client?: GraphClient): string {
  if (!client || !(err instanceof GraphError) || !err.isRateLimit) return "";

  // O caminho começa pelo ID do nó, então dá para citar o ativo que estourou em
  // vez do pior do portfólio. Se a leitura daquele ativo estiver velha ou
  // faltando, o pior do portfólio ainda é uma pista melhor que nenhuma.
  const usage = client.usage.forPath(err.path)[0] ?? client.usage.worst();
  const medida = usage ? ` ${describeUsage(usage)}` : "";

  return (
    `\n\nLimite de uso do Meta.${medida}` +
    " O balde é por ativo e por caso de uso, e o token é um só: consultas de" +
    " várias pessoas ao mesmo ativo dividem a mesma cota. Repetir agora não" +
    " ajuda — espere os minutos indicados, ou consulte outro ativo enquanto isso."
  );
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
