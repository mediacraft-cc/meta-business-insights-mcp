/**
 * Cache de respostas das tools, em memória.
 *
 * Existe pelo mesmo motivo que o backoff: a cota do Meta é por ativo e o token
 * é um só, então várias pessoas perguntando a mesma coisa sobre o mesmo cliente
 * dividem o mesmo balde. É o cenário que estoura o limite — e, por sorte, é
 * exatamente o cenário em que um cache acerta.
 *
 * Fica na memória do processo de propósito: as `ToolDeps` são criadas uma vez
 * em `server.ts` e sobrevivem entre requisições, como o cache do portfólio.
 * Reinício zera, e tudo bem: o custo de um miss é uma consulta normal.
 */

import { daysBetween, today } from "./dates.js";

export interface CacheHit<T> {
  value: T;
  /** Quando a resposta foi produzida. */
  at: number;
  /** `false` quando o TTL já passou — a entrada ainda serve como último recurso. */
  fresh: boolean;
}

interface Entry {
  value: unknown;
  at: number;
  expiresAt: number;
}

/**
 * O Meta leva cerca de dois dias para consolidar os números do dia. Depois
 * disso a janela não muda mais, e a resposta pode ser guardada por muito mais
 * tempo do que uma que ainda toca hoje.
 */
export const CONSOLIDATION_LAG_DAYS = 2;

/** Janela fechada: o resultado é imutável, então o TTL é generoso. */
export const CLOSED_WINDOW_TTL_MS = 6 * 60 * 60 * 1000;

/** Janela que ainda toca hoje ou ontem: o número ainda se mexe. */
export const OPEN_WINDOW_TTL_MS = 10 * 60 * 1000;

/**
 * Quanto tempo a resposta de uma consulta pode ser guardada, a partir do fim da
 * janela pedida. É a decisão que torna o cache seguro: o relatório de "mês
 * passado" — que é o pedido caro e repetido — cai inteiro no TTL longo, e o
 * "como estamos hoje" continua praticamente ao vivo.
 */
export function windowTtl(until: string, now = today()): number {
  return daysBetween(until, now) > CONSOLIDATION_LAG_DAYS
    ? CLOSED_WINDOW_TTL_MS
    : OPEN_WINDOW_TTL_MS;
}

/**
 * Chave estável para uma pergunta.
 *
 * Só funciona se receber os valores **já resolvidos**: os IDs que saíram de
 * `resolveTargets` (e não `@usuario`) e o intervalo absoluto que saiu de
 * `resolveRange` (e não o `since` ausente que significa "180 dias atrás"). É o
 * ponto em que este cache acerta ou tem taxa de acerto zero: sem isso, a mesma
 * pergunta escrita de dois jeitos vira duas chaves, e a mesma chave devolve
 * amanhã o dado de hoje.
 */
export function cacheKey(tool: string, parts: Record<string, unknown>): string {
  return `${tool}:${canonical(parts)}`;
}

/**
 * JSON com as chaves de objeto em ordem — `{a,b}` e `{b,a}` são a mesma
 * pergunta. Ordem de array é preservada: em `groupBy` ela muda a saída.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export class ResponseCache {
  private readonly entries = new Map<string, Entry>();

  /**
   * `maxEntries` é teto de *entradas*, não de bytes. Uma resposta de portfólio
   * grande são dezenas de KB, então o padrão segura alguns megabytes — e sem
   * teto nenhum o cache seria o vazamento.
   */
  constructor(private readonly maxEntries = 200) {}

  /**
   * Devolve também a entrada vencida, marcada com `fresh: false`. Quem chama
   * decide: o caminho normal ignora, e o caminho de cota estourada prefere um
   * número velho e datado a um erro.
   */
  get<T>(key: string, now = Date.now()): CacheHit<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return { value: entry.value as T, at: entry.at, fresh: now < entry.expiresAt };
  }

  set(key: string, value: unknown, ttlMs: number, now = Date.now()): void {
    // Reinsere no fim para que a ordem do Map seja a ordem de idade, que é o
    // que o despejo usa.
    this.entries.delete(key);
    this.entries.set(key, { value, at: now, expiresAt: now + ttlMs });
    if (this.entries.size > this.maxEntries) this.evict();
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    const excess = this.entries.size - this.maxEntries;
    for (const key of [...this.entries.keys()].slice(0, excess)) {
      this.entries.delete(key);
    }
  }
}
