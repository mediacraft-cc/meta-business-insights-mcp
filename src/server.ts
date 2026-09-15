/**
 * MCP server: Meta Business Insights (orgânico + pago).
 *
 * Complementa o MCP de Meta Ads, que só enxerga o que veio de campanha. Aqui a
 * fonte é o Business Manager inteiro: todas as Páginas e contas do Instagram do
 * portfólio, com os números reais das contas.
 *
 * Este módulo só monta o servidor; cada grupo de tools vive em `tools/`. Quem
 * o serve são os entrypoints: `index.ts` (stdio, execução local) e `http.ts`
 * (remoto, atrás de bearer).
 */

import { McpServer } from "@modelcontextprotocol/server";

import { loadConfig } from "./config.js";
import { GraphClient } from "./graph/client.js";
import { PortfolioService } from "./graph/assets.js";
import { SnapshotStore } from "./store.js";
import type { ToolDeps } from "./tools/shared.js";
import { registerPortfolioTools } from "./tools/portfolio.js";
import { registerFollowerTools } from "./tools/followers.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerContentTools } from "./tools/content.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerSnapshotTools } from "./tools/snapshots.js";
import { registerGraphApiTools } from "./tools/graph-api.js";

// No nível do módulo de propósito: o HTTP chama `createServer` a cada request,
// e o cache de 10 minutos do portfólio precisa sobreviver entre elas.
const config = loadConfig();
const client = new GraphClient(config.accessToken, config.apiVersion);
const deps: ToolDeps = {
  config,
  client,
  portfolio: new PortfolioService(client, config.businessId, config.pageIdFilter),
  store: new SnapshotStore(config.dataDir),
};

export interface ServerOptions {
  /**
   * Registra as tools que publicam. Falso por padrão: quem não recebeu o
   * direito de escrita não vê essas tools no `tools/list`, em vez de vê-las e
   * tomar um erro ao usar.
   */
  canWrite?: boolean;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "meta-business-insights",
    version: "0.1.2",
  });

  registerPortfolioTools(server, deps);
  registerFollowerTools(server, deps);
  registerInsightTools(server, deps);
  registerContentTools(server, deps);
  registerCommentTools(server, deps, { canWrite: options.canWrite ?? false });
  registerSnapshotTools(server, deps);
  registerGraphApiTools(server, deps);

  return server;
}
