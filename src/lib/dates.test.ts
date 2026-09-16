import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addDays,
  bucketLabel,
  buildBuckets,
  chunkRange,
  daysBetween,
  resolveRange,
} from "./dates.js";

describe("addDays", () => {
  it("atravessa o fim do mês", () => {
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  });

  it("acerta o 29 de fevereiro em ano bissexto", () => {
    assert.equal(addDays("2024-02-28", 1), "2024-02-29");
    assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  });

  it("anda para trás", () => {
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  });
});

describe("bucketLabel", () => {
  it("usa a regra ISO da semana: a semana pertence ao ano da sua quinta-feira", () => {
    // 29/12/2025 é segunda; a quinta dessa semana já caiu em 2026.
    assert.equal(bucketLabel("2025-12-29", "week"), "2026-W01");
    assert.equal(bucketLabel("2026-01-01", "week"), "2026-W01");
  });

  it("rotula mês, trimestre e ano", () => {
    assert.equal(bucketLabel("2026-03-14", "month"), "2026-03");
    assert.equal(bucketLabel("2026-03-14", "quarter"), "2026-Q1");
    assert.equal(bucketLabel("2026-10-01", "quarter"), "2026-Q4");
    assert.equal(bucketLabel("2026-03-14", "year"), "2026");
  });
});

describe("buildBuckets", () => {
  it("recorta o primeiro e o último bucket nos limites pedidos", () => {
    assert.deepEqual(buildBuckets("2026-01-20", "2026-03-05", "month"), [
      { label: "2026-01", start: "2026-01-20", end: "2026-01-31" },
      { label: "2026-02", start: "2026-02-01", end: "2026-02-28" },
      { label: "2026-03", start: "2026-03-01", end: "2026-03-05" },
    ]);
  });

  it("cobre o intervalo sem buraco nem dia repetido", () => {
    const buckets = buildBuckets("2026-01-01", "2026-12-31", "week");
    const dias = buckets.reduce((acc, b) => acc + daysBetween(b.start, b.end) + 1, 0);
    assert.equal(dias, 365);
    for (let i = 1; i < buckets.length; i += 1) {
      assert.equal(buckets[i]!.start, addDays(buckets[i - 1]!.end, 1));
    }
  });
});

describe("chunkRange", () => {
  it("respeita o teto de dias por request da Graph API", () => {
    assert.deepEqual(chunkRange("2026-01-01", "2026-02-10", 30), [
      { start: "2026-01-01", end: "2026-01-30" },
      { start: "2026-01-31", end: "2026-02-10" },
    ]);
  });

  it("devolve uma fatia só quando o intervalo cabe", () => {
    assert.deepEqual(chunkRange("2026-01-01", "2026-01-05", 30), [
      { start: "2026-01-01", end: "2026-01-05" },
    ]);
  });
});

describe("resolveRange", () => {
  it("conta o default para trás incluindo o último dia", () => {
    assert.deepEqual(resolveRange(undefined, "2026-03-10", 7), {
      since: "2026-03-04",
      until: "2026-03-10",
    });
  });

  it("recusa intervalo invertido em vez de devolver vazio", () => {
    assert.throws(() => resolveRange("2026-03-10", "2026-03-01"), /Intervalo inválido/);
  });
});
