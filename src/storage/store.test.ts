import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { SnapshotStore, type Snapshot } from "./store.js";

const dirs: string[] = [];

function store(): SnapshotStore {
  const dir = mkdtempSync(join(tmpdir(), "meta-mcp-test-"));
  dirs.push(dir);
  return new SnapshotStore(dir);
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function snap(date: string, assetId: string, followers: number | null): Snapshot {
  return {
    date,
    capturedAt: `${date}T03:00:00.000Z`,
    surface: "instagram",
    assetId,
    assetName: `conta ${assetId}`,
    followers,
  };
}

describe("SnapshotStore", () => {
  it("começa vazio quando o arquivo ainda não existe", () => {
    assert.deepEqual(store().query(), []);
  });

  it("cria o diretório na primeira gravação", () => {
    const s = new SnapshotStore(join(mkdtempSync(join(tmpdir(), "meta-mcp-test-")), "sub", "dir"));
    dirs.push(s.path);
    assert.deepEqual(s.save([snap("2026-01-01", "a", 10)]), { written: 1, total: 1 });
  });

  it("substitui o snapshot do mesmo dia e ativo em vez de duplicar", () => {
    const s = store();
    s.save([snap("2026-01-01", "a", 10)]);
    const resultado = s.save([snap("2026-01-01", "a", 12)]);

    assert.deepEqual(resultado, { written: 1, total: 1 });
    assert.equal(s.query()[0]!.followers, 12);
  });

  it("guarda o mesmo dia de ativos diferentes", () => {
    const s = store();
    s.save([snap("2026-01-01", "a", 10), snap("2026-01-01", "b", 20)]);
    assert.equal(s.query().length, 2);
  });

  it("filtra por intervalo e por ativo", () => {
    const s = store();
    s.save([
      snap("2026-01-01", "a", 10),
      snap("2026-02-01", "a", 11),
      snap("2026-02-01", "b", 20),
    ]);

    assert.equal(s.query({ since: "2026-02-01" }).length, 2);
    assert.equal(s.query({ until: "2026-01-31" }).length, 1);
    assert.deepEqual(
      s.query({ assetIds: ["b"] }).map((x) => x.assetName),
      ["conta b"],
    );
  });

  it("mantém a ordem por data", () => {
    const s = store();
    s.save([snap("2026-03-01", "a", 30)]);
    s.save([snap("2026-01-01", "a", 10)]);
    assert.deepEqual(
      s.query().map((x) => x.date),
      ["2026-01-01", "2026-03-01"],
    );
  });

  /**
   * O snapshot diário roda por timer: um arquivo corrompido não pode derrubar
   * a gravação de hoje, senão um acidente vira um buraco permanente na série.
   */
  it("trata arquivo corrompido como histórico vazio e segue gravando", () => {
    const s = store();
    writeFileSync(s.path, "{ isso não é json", "utf8");
    assert.deepEqual(s.query(), []);
    assert.deepEqual(s.save([snap("2026-01-01", "a", 10)]), { written: 1, total: 1 });
  });
});
