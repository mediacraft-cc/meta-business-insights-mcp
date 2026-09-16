import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatNumber, formatPct, formatSigned, issuesBlock, markdownTable } from "./format.js";

describe("markdownTable", () => {
  it("escapa o pipe do texto para não quebrar a tabela", () => {
    const table = markdownTable(["Legenda"], [["promo | 50% off"]]);
    assert.match(table, /promo \\\| 50% off/);
  });

  it("marca célula vazia com travessão", () => {
    assert.match(markdownTable(["a", "b"], [[null, undefined]]), /\| — \| — \|/);
  });

  it("avisa quando trunca", () => {
    const rows = Array.from({ length: 5 }, (_, i) => [i]);
    const table = markdownTable(["n"], rows, { maxRows: 2 });
    assert.match(table, /Exibindo 2 de 5 linhas/);
  });

  it("devolve a mensagem de vazio sem cabeçalho", () => {
    assert.equal(markdownTable(["a"], [], { emptyMessage: "_nada_" }), "_nada_");
  });
});

describe("formatação numérica", () => {
  it("usa o padrão pt-BR e arredonda em duas casas", () => {
    assert.equal(formatNumber(1234.567), "1.234,57");
  });

  it("dá sinal explícito ao positivo", () => {
    assert.equal(formatSigned(3), "+3");
    assert.equal(formatSigned(-3), "-3");
    assert.equal(formatSigned(null), "—");
  });

  it("dá duas casas à variação menor que 1%, que de outro modo viraria 0%", () => {
    assert.equal(formatPct(0.5), "+0,50%");
    assert.equal(formatPct(12.34), "+12,3%");
    assert.equal(formatPct(undefined), "—");
    assert.equal(formatPct(Infinity), "—");
  });
});

describe("issuesBlock", () => {
  it("some quando não há aviso", () => {
    assert.equal(issuesBlock([]), "");
  });

  it("identifica ativo, superfície e métrica", () => {
    const bloco = issuesBlock([
      { assetName: "Loja", surface: "instagram", metric: "views", message: "sem permissão" },
    ]);
    assert.match(bloco, /### Avisos/);
    assert.match(bloco, /\*\*Loja\*\* \(instagram, views\): sem permissão/);
  });
});
