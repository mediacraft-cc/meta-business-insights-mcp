import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GraphError } from "./client.js";

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
