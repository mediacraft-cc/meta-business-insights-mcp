import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ResponseCache, cacheKey } from "../lib/cache.js";
import { GraphClient, GraphError } from "../meta/client.js";
import { ageLabel, fail, served, text } from "./shared.js";

const USAGE = JSON.stringify({
  "1122334455": [
    {
      type: "pages",
      call_count: 100,
      total_cputime: 30,
      total_time: 55,
      estimated_time_to_regain_access: 12,
    },
  ],
});

/** Nenhum teste toca a rede: o cliente só serve de porta para o rastreador. */
function clienteCom(usage?: string): GraphClient {
  const client = new GraphClient("token-de-teste", "v23.0");
  if (usage) client.usage.record(usage);
  return client;
}

describe("served", () => {
  it("chama a API uma vez e responde a segunda pergunta do cache", async () => {
    const cache = new ResponseCache();
    const key = cacheKey("t", { a: 1 });
    let chamadas = 0;
    const produce = async () => {
      chamadas += 1;
      return text("42 seguidores", { total: 42 });
    };

    const primeira = await served(cache, key, 60_000, produce);
    const segunda = await served(cache, key, 60_000, produce);

    assert.equal(chamadas, 1);
    assert.match(primeira.content[0]!.text, /42 seguidores/);
    assert.match(segunda.content[0]!.text, /42 seguidores/);
  });

  it("marca a procedência no texto e no structuredContent", async () => {
    const cache = new ResponseCache();
    const key = cacheKey("t", { a: 2 });
    await served(cache, key, 60_000, async () => text("corpo", { total: 1 }));
    const hit = await served(cache, key, 60_000, async () => text("outro", {}));

    // O texto é o que o modelo lê para avisar o usuário; o campo é o que dá
    // para conferir sem interpretar prosa.
    assert.match(hit.content[0]!.text, /Resposta do cache/);
    assert.equal((hit.structuredContent as { cache: { hit: boolean } }).cache.hit, true);
    assert.equal((hit.structuredContent as { total: number }).total, 1);
  });

  it("pergunta diferente não aproveita a resposta da anterior", async () => {
    const cache = new ResponseCache();
    let chamadas = 0;
    const produce = async () => {
      chamadas += 1;
      return text("x");
    };

    await served(cache, cacheKey("t", { asset: "a" }), 60_000, produce);
    await served(cache, cacheKey("t", { asset: "b" }), 60_000, produce);
    assert.equal(chamadas, 2);
  });

  it("não guarda erro: um limite de um minuto viraria minutos de erro repetido", async () => {
    const cache = new ResponseCache();
    const key = cacheKey("t", { a: 3 });
    await assert.rejects(
      served(cache, key, 60_000, async () => {
        throw new GraphError(400, "/1122334455/insights", { message: "estourou", code: 80001 });
      }),
    );
    assert.equal(cache.get(key), undefined);
  });
});

describe("fail", () => {
  it("anexa a cota do ativo que estourou", () => {
    const err = new GraphError(400, "/1122334455/insights", {
      message: "(#80001) limite",
      code: 80001,
    });
    const saida = fail(err, clienteCom(USAGE));

    assert.equal(saida.isError, true);
    assert.match(saida.content[0]!.text, /chamadas 100%/);
    assert.match(saida.content[0]!.text, /Libera em ~12 min/);
    assert.match(saida.content[0]!.text, /Repetir agora não ajuda/);
  });

  it("não fala de cota em erro que não é de limite", () => {
    const err = new GraphError(400, "/1122334455/insights", {
      message: "(#100) Invalid metric",
      code: 100,
    });
    assert.doesNotMatch(fail(err, clienteCom(USAGE)).content[0]!.text, /Cota do Meta/);
  });

  it("ainda responde quando não há leitura de cota guardada", () => {
    const err = new GraphError(400, "/999/insights", { message: "limite", code: 80005 });
    const texto = fail(err, clienteCom()).content[0]!.text;
    assert.match(texto, /Limite de uso do Meta/);
    assert.doesNotMatch(texto, /Cota do Meta/);
  });

  it("continua funcionando sem cliente nenhum", () => {
    assert.match(fail(new Error("boom")).content[0]!.text, /Erro: boom/);
  });
});

describe("ageLabel", () => {
  it("fala em minutos e horas, que é a precisão que importa", () => {
    assert.equal(ageLabel(20_000), "menos de 1 min");
    assert.equal(ageLabel(3 * 60_000), "3 min");
    assert.equal(ageLabel(90 * 60_000), "1.5 h");
  });
});
