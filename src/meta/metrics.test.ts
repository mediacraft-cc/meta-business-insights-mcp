import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IG_METRICS, PAGE_METRICS, checkDeprecated } from "./metrics.js";

describe("checkDeprecated", () => {
  it("aponta a substituta da métrica morta", () => {
    assert.match(checkDeprecated("page_fans", "page")!, /use "page_follows"/);
    assert.match(checkDeprecated("impressions", "instagram")!, /use "views"/);
  });

  it("cala quando a métrica está viva", () => {
    assert.equal(checkDeprecated("page_follows", "page"), undefined);
    assert.equal(checkDeprecated("views", "instagram"), undefined);
  });

  it("não confunde as superfícies: 'impressions' é do catálogo do Instagram", () => {
    assert.equal(checkDeprecated("impressions", "page"), undefined);
    assert.equal(checkDeprecated("page_fans", "instagram"), undefined);
  });
});

describe("catálogo", () => {
  it("não repete nome de métrica", () => {
    for (const catalogo of [PAGE_METRICS, IG_METRICS]) {
      const nomes = catalogo.map((m) => m.name);
      assert.equal(new Set(nomes).size, nomes.length);
    }
  });

  it("descreve toda métrica listada, que é o que o modelo lê para escolher", () => {
    for (const m of [...PAGE_METRICS, ...IG_METRICS]) {
      assert.ok(m.description.length > 0, `${m.name} sem descrição`);
      assert.ok(m.periods.length > 0, `${m.name} sem período`);
    }
  });
});
