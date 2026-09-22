import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UsageTracker, describeUsage, parseUsageHeader, pressure } from "./usage.js";

const BUC = JSON.stringify({
  "17841400000000": [
    {
      type: "instagram",
      call_count: 12,
      total_cputime: 97,
      total_time: 40,
      estimated_time_to_regain_access: 0,
    },
  ],
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

describe("parseUsageHeader", () => {
  it("lê um ativo por caso de uso", () => {
    const entradas = parseUsageHeader(BUC, 1_000);
    assert.equal(entradas.length, 2);

    const ig = entradas.find((u) => u.assetId === "17841400000000")!;
    assert.equal(ig.useCase, "instagram");
    assert.equal(ig.totalCputime, 97);
    assert.equal(ig.at, 1_000);
  });

  it("entende também o x-app-usage, que não tem ativo", () => {
    const [app] = parseUsageHeader(
      JSON.stringify({ call_count: 20, total_cputime: 5, total_time: 9 }),
    );
    assert.equal(app!.assetId, "app");
    assert.equal(app!.callCount, 20);
  });

  it("não estoura com header quebrado", () => {
    // Diagnóstico não pode derrubar resposta boa: um medidor que mudou de
    // formato vira lista vazia, não exceção.
    for (const lixo of ["", "não é json", "[]", "null", '{"x":3}']) {
      assert.deepEqual(parseUsageHeader(lixo).filter((u) => u.assetId !== "app"), []);
    }
  });
});

/** As chaves do header são numéricas, e objeto JS as reordena: buscar por ID. */
function doAtivo(id: string) {
  return parseUsageHeader(BUC).find((u) => u.assetId === id)!;
}

describe("pressure", () => {
  it("é o percentual mais perto do bloqueio, não o de chamadas", () => {
    // O que estoura primeiro em consulta de Insights é CPU, não volume.
    assert.equal(pressure(doAtivo("17841400000000")), 97);
  });
});

describe("UsageTracker", () => {
  it("acha a cota pelo caminho da requisição", () => {
    const tracker = new UsageTracker();
    tracker.record(BUC);

    // O caminho da Graph API começa pelo ID do nó — é assim que o erro de um
    // batch sabe de quem é a cota que estourou.
    const [achado] = tracker.forPath("/1122334455/insights");
    assert.equal(achado!.useCase, "pages");
    assert.equal(achado!.regainAccessInMinutes, 12);

    assert.deepEqual(tracker.forPath("/me/accounts"), []);
  });

  it("elege o ativo mais pressionado do portfólio", () => {
    const tracker = new UsageTracker();
    tracker.record(BUC);
    assert.equal(tracker.worst()!.assetId, "1122334455");
  });

  it("esquece amostra mais velha que a janela de 1h do Meta", () => {
    const tracker = new UsageTracker();
    tracker.record(BUC, 0);
    // Citar um número de uma hora atrás seria pior que não citar nada.
    assert.equal(tracker.worst(61 * 60_000), undefined);
    assert.deepEqual(tracker.forPath("/1122334455/insights", 61 * 60_000), []);
  });

  it("a última leitura de um ativo substitui a anterior", () => {
    const tracker = new UsageTracker();
    tracker.record(BUC, 0);
    tracker.record(
      JSON.stringify({
        "1122334455": [{ type: "pages", call_count: 3, total_cputime: 1, total_time: 1 }],
      }),
      1_000,
    );
    assert.equal(tracker.forPath("/1122334455/x", 2_000)[0]!.callCount, 3);
  });
});

describe("describeUsage", () => {
  it("diz o quanto falta e em quanto tempo volta", () => {
    const frase = describeUsage(doAtivo("1122334455"));
    assert.match(frase, /1122334455/);
    assert.match(frase, /chamadas 100%/);
    assert.match(frase, /Libera em ~12 min/);
  });

  it("cala sobre o tempo de volta quando ainda não bloqueou", () => {
    assert.doesNotMatch(describeUsage(doAtivo("17841400000000")), /Libera/);
  });
});
