import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactDeep, redactText } from "./redact.js";

const TOKEN = `EAA${"b7Kz9QvR2mN4pL6sT8wX".repeat(2)}`;

describe("redactText", () => {
  it("apaga o token da query string, preservando o resto da URL", () => {
    const url = `https://graph.facebook.com/v26.0/me/accounts?access_token=${TOKEN}&limit=25`;
    const limpo = redactText(url);

    assert.ok(!limpo.includes(TOKEN));
    assert.match(limpo, /access_token=\[REDACTED\]/);
    assert.match(limpo, /limit=25/);
  });

  it("cobre os outros segredos que a Meta manda na query", () => {
    for (const chave of ["client_secret", "input_token", "code"]) {
      assert.match(redactText(`?${chave}=abc123`), new RegExp(`${chave}=\\[REDACTED\\]`));
    }
  });

  it("apaga o token solto no meio do texto", () => {
    assert.equal(redactText(`erro com ${TOKEN} aqui`), "erro com [REDACTED] aqui");
  });

  it("não mexe em texto sem segredo", () => {
    const texto = "**Portfólio:** 12 páginas · 34.567 seguidores";
    assert.equal(redactText(texto), texto);
  });
});

describe("redactDeep", () => {
  it("apaga por chave, qualquer que seja o formato do valor", () => {
    const saida = redactDeep({
      pages: [{ name: "Loja", access_token: "qualquer-coisa", page_access_token: "outra" }],
    });
    assert.deepEqual(saida, {
      pages: [{ name: "Loja", access_token: "[REDACTED]", page_access_token: "[REDACTED]" }],
    });
  });

  it("alcança o token na URL de paginação, que é por onde ele vazava", () => {
    const saida = redactDeep({
      data: [{ id: "1" }],
      paging: { next: `https://graph.facebook.com/v26.0/x?access_token=${TOKEN}&after=Q1` },
    });
    assert.ok(!JSON.stringify(saida).includes(TOKEN));
    assert.match(saida.paging.next, /after=Q1/);
  });

  it("devolve o mesmo objeto quando não há o que trocar, sem copiar à toa", () => {
    const entrada = { rows: [{ periodo: "2026-01", valor: 10 }] };
    assert.equal(redactDeep(entrada), entrada);
  });

  it("atravessa null, número e booleano sem quebrar", () => {
    const entrada = { a: null, b: 1, c: true, d: undefined };
    assert.deepEqual(redactDeep(entrada), entrada);
  });
});
