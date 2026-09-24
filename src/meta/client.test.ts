import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GraphClient, GraphError } from "./client.js";

function graphError(code: number, message = "limite atingido"): GraphError {
  return new GraphError(400, "/me/insights", { message, code });
}

describe("GraphError.isRateLimit", () => {
  it("reconhece os dois baldes que este servidor usa", () => {
    // 80001 (Pages) e 80005 (Instagram) são os casos de uso das duas
    // superfícies consultadas. Sem eles, o throttle sobe como erro permanente
    // e a requisição morre sem nenhuma espera.
    assert.equal(graphError(80001).isRateLimit, true);
    assert.equal(graphError(80005).isRateLimit, true);
  });

  it("reconhece os limites de plataforma", () => {
    for (const code of [4, 17, 32, 613]) {
      assert.equal(graphError(code).isRateLimit, true, `código ${code}`);
    }
  });

  it("não confunde erro permanente com limite", () => {
    // O (#100) de métrica inválida repete igual para sempre: esperar e tentar
    // de novo só gasta a cota que o backoff existe para poupar.
    assert.equal(graphError(100, "(#100) Invalid metric").isRateLimit, false);
    assert.equal(graphError(190, "token expirado").isRateLimit, false);
  });

  it("não chama de limite um erro sem código", () => {
    const semCodigo = new GraphError(500, "/me", { message: "boom" });
    assert.equal(semCodigo.isRateLimit, false);
  });
});

/**
 * Respostas enfileiradas no lugar da rede. A espera do backoff é substituída
 * por uma contagem: o teste confere a política, não o relógio.
 */
function comRespostas(...respostas: Array<() => Response | Promise<never>>) {
  const original = globalThis.fetch;
  const esperas: number[] = [];
  let chamadas = 0;

  globalThis.fetch = (async () => {
    const proxima = respostas[Math.min(chamadas, respostas.length - 1)]!;
    chamadas += 1;
    return proxima();
  }) as typeof fetch;

  const client = new GraphClient("token", "v23.0", "https://graph.test", async (ms) => {
    esperas.push(ms);
  });

  return {
    client,
    esperas,
    get chamadas() {
      return chamadas;
    },
    restaurar: () => {
      globalThis.fetch = original;
    },
  };
}

const ok = (corpo: unknown) => () =>
  new Response(JSON.stringify(corpo), { status: 200 });

const erro = (status: number, corpo: unknown) => () =>
  new Response(JSON.stringify(corpo), { status });

const limite = (code: number) =>
  erro(400, { error: { message: `(#${code}) limite`, code } });

/** Uma operação bem-sucedida dentro do envelope do batch. */
const itemOk = (corpo: unknown) => ({ code: 200, body: JSON.stringify(corpo) });

describe("batchGet", () => {
  it("retenta o envelope em 5xx — são 50 operações de uma vez", async (t) => {
    const rede = comRespostas(
      erro(503, { error: { message: "indisponível" } }),
      ok([itemOk({ data: [1] })]),
    );
    t.after(rede.restaurar);

    const resultado = await rede.client.batchGet([{ path: "/1/insights" }]);

    assert.equal(rede.chamadas, 2);
    assert.deepEqual(rede.esperas, [700]);
    assert.equal(resultado[0]!.ok, true);
  });

  it("retenta o envelope em rate limit, com a espera longa", async (t) => {
    const rede = comRespostas(limite(80005), limite(80005), ok([itemOk({ data: [] })]));
    t.after(rede.restaurar);

    await rede.client.batchGet([{ path: "/1/insights" }]);

    // 5s, depois 10s: o dobro a cada tentativa.
    assert.deepEqual(rede.esperas, [5_000, 10_000]);
  });

  it("não retenta o envelope em erro permanente", async (t) => {
    const rede = comRespostas(erro(400, { error: { message: "token expirado", code: 190 } }));
    t.after(rede.restaurar);

    await assert.rejects(rede.client.batchGet([{ path: "/1/insights" }]), /token expirado/);
    assert.equal(rede.chamadas, 1);
    assert.deepEqual(rede.esperas, []);
  });

  it("desiste depois de 4 tentativas em vez de insistir para sempre", async (t) => {
    const rede = comRespostas(erro(503, { error: { message: "indisponível" } }));
    t.after(rede.restaurar);

    await assert.rejects(rede.client.batchGet([{ path: "/1/insights" }]));
    assert.equal(rede.chamadas, 4);
  });

  it("erro de uma operação não derruba as outras do mesmo batch", async (t) => {
    const rede = comRespostas(
      ok([
        itemOk({ data: [1] }),
        { code: 400, body: JSON.stringify({ error: { message: "(#100) métrica inválida" } }) },
        null, // operação que estourou o tempo
      ]),
    );
    t.after(rede.restaurar);

    const [primeiro, segundo, terceiro] = await rede.client.batchGet([
      { path: "/1/insights" },
      { path: "/2/insights" },
      { path: "/3/insights" },
    ]);

    assert.equal(primeiro!.ok, true);
    assert.equal(segundo!.ok, false);
    // A operação que expira volta como `null`, não como erro — vira 504
    // sintético para não sumir silenciosamente.
    assert.equal(terceiro!.ok, false);
    assert.equal((terceiro as { error: GraphError }).error.status, 504);
  });
});

describe("post", () => {
  it("não retenta em 5xx: um comentário publicado duas vezes é pior", async (t) => {
    const rede = comRespostas(erro(502, { error: { message: "bad gateway" } }));
    t.after(rede.restaurar);

    await assert.rejects(rede.client.post("/1/comments", { message: "oi" }));
    // A falha é ambígua — o Meta pode ter processado antes de cair.
    assert.equal(rede.chamadas, 1);
  });

  it("retenta em rate limit, onde o Meta recusou e nada aconteceu", async (t) => {
    const rede = comRespostas(limite(32), ok({ id: "1_2" }));
    t.after(rede.restaurar);

    await rede.client.post("/1/comments", { message: "oi" });
    assert.equal(rede.chamadas, 2);
    assert.deepEqual(rede.esperas, [5_000]);
  });
});
