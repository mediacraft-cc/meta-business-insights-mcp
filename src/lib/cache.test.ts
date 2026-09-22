import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLOSED_WINDOW_TTL_MS,
  OPEN_WINDOW_TTL_MS,
  ResponseCache,
  cacheKey,
  windowTtl,
} from "./cache.js";

describe("cacheKey", () => {
  it("é a mesma chave quando a pergunta é a mesma, escrita fora de ordem", () => {
    assert.equal(
      cacheKey("page_insights", { since: "2026-01-01", metrics: ["reach"] }),
      cacheKey("page_insights", { metrics: ["reach"], since: "2026-01-01" }),
    );
  });

  it("separa tools diferentes com o mesmo argumento", () => {
    assert.notEqual(cacheKey("a", { x: 1 }), cacheKey("b", { x: 1 }));
  });

  it("preserva a ordem de array, que em groupBy muda a saída", () => {
    assert.notEqual(
      cacheKey("t", { groupBy: ["period", "asset"] }),
      cacheKey("t", { groupBy: ["asset", "period"] }),
    );
  });

  it("ignora campo ausente em vez de criar uma chave nova", () => {
    // `since` ausente e `since: undefined` são a mesma pergunta — quem resolve
    // o intervalo é o handler, antes de montar a chave.
    assert.equal(cacheKey("t", { a: 1, since: undefined }), cacheKey("t", { a: 1 }));
  });

  it("não confunde o número 1 com a string '1'", () => {
    assert.notEqual(cacheKey("t", { limit: 1 }), cacheKey("t", { limit: "1" }));
  });
});

describe("windowTtl", () => {
  it("guarda por horas a janela que o Meta já consolidou", () => {
    assert.equal(windowTtl("2026-09-01", "2026-09-22"), CLOSED_WINDOW_TTL_MS);
  });

  it("guarda por minutos a janela que ainda toca hoje", () => {
    assert.equal(windowTtl("2026-09-22", "2026-09-22"), OPEN_WINDOW_TTL_MS);
  });

  it("trata a fronteira dos ~2 dias de consolidação como janela aberta", () => {
    // O dado de anteontem ainda se mexe: só a partir do terceiro dia é que a
    // resposta vira imutável.
    assert.equal(windowTtl("2026-09-20", "2026-09-22"), OPEN_WINDOW_TTL_MS);
    assert.equal(windowTtl("2026-09-19", "2026-09-22"), CLOSED_WINDOW_TTL_MS);
  });
});

describe("ResponseCache", () => {
  it("devolve o que guardou", () => {
    const cache = new ResponseCache();
    cache.set("k", { valor: 1 }, 1_000, 0);
    const hit = cache.get<{ valor: number }>("k", 500);
    assert.deepEqual(hit!.value, { valor: 1 });
    assert.equal(hit!.fresh, true);
    assert.equal(hit!.at, 0);
  });

  it("marca como vencida em vez de apagar", () => {
    // É o que permite servir um número velho e datado quando a cota estourou —
    // melhor que devolver erro.
    const cache = new ResponseCache();
    cache.set("k", "v", 1_000, 0);
    const hit = cache.get("k", 5_000);
    assert.equal(hit!.fresh, false);
    assert.equal(hit!.value, "v");
  });

  it("não inventa resposta para chave que nunca viu", () => {
    assert.equal(new ResponseCache().get("nada"), undefined);
  });

  it("descarta as entradas mais antigas ao passar do teto", () => {
    const cache = new ResponseCache(2);
    cache.set("a", 1, 10_000, 0);
    cache.set("b", 2, 10_000, 1);
    cache.set("c", 3, 10_000, 2);

    assert.equal(cache.size, 2);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("c")!.value, 3);
  });

  it("regravar a mesma chave a torna a mais nova, não a mais velha", () => {
    const cache = new ResponseCache(2);
    cache.set("a", 1, 10_000, 0);
    cache.set("b", 2, 10_000, 1);
    cache.set("a", 9, 10_000, 2);
    cache.set("c", 3, 10_000, 3);

    // 'b' virou a mais velha e sai; 'a' ficou com o valor novo.
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a")!.value, 9);
  });
});
