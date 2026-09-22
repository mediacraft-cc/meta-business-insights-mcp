import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { fail, text, type ToolDeps } from "./shared.js";

/** Escape hatch para o que as outras tools não cobrem. */
export function registerGraphApiTools(server: McpServer, { client, portfolio }: ToolDeps): void {
  server.registerTool(
    "graph_api_get",
    {
      title: "GET cru na Graph API",
      description:
        "Chamada GET direta a qualquer nó/edge da Graph API, com o token certo já resolvido. " +
        "Use quando a métrica ou campo desejado não estiver coberto pelas outras tools.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Caminho sem a versão. Ex.: '123456/insights' ou 'me/accounts'."),
        params: z
          .record(z.string(), z.string())
          .default({})
          .describe("Query params. Não inclua access_token."),
        usePageToken: z
          .string()
          .optional()
          .describe("ID ou nome da Página cujo Page Access Token deve ser usado."),
        paginate: z
          .boolean()
          .default(false)
          .describe("Segue a paginação e concatena todos os data[]."),
      }),
    },
    async ({ path, params, usePageToken, paginate }) => {
      try {
        let token: string | undefined;
        if (usePageToken) {
          const [page] = await portfolio.resolveTargets([usePageToken]);
          token = page?.accessToken;
        }
        const data = paginate
          ? await client.getAll(path, params, { token })
          : await client.get(path, params, { token });
        const json = JSON.stringify(data, null, 2);
        const truncated =
          json.length > 60_000 ? `${json.slice(0, 60_000)}\n… (truncado)` : json;
        return text("```json\n" + truncated + "\n```", { data } as Record<string, unknown>);
      } catch (err) {
        return fail(err, client);
      }
    },
  );
}
