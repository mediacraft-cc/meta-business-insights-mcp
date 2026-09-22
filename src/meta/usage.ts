/**
 * Leitura dos medidores de cota que a Graph API devolve em todo response.
 *
 * O Meta não avisa que você está perto do limite: ele responde normalmente até
 * a hora em que recusa. O aviso está num header que vem em toda resposta —
 * `x-business-use-case-usage` — com três percentuais por ativo, e é a única
 * forma de saber que o próximo relatório vai falhar antes de ele falhar.
 *
 * Os três percentuais são independentes e qualquer um deles a 100% bloqueia o
 * ativo. O que estoura primeiro aqui não costuma ser `call_count`: consultas de
 * Insights com janela longa e várias métricas são caras em CPU, então
 * `total_cputime` chega antes.
 */

/** Percentuais de uso de um ativo em um caso de uso, no momento da leitura. */
export interface AssetUsage {
  /** ID da Página / conta do Instagram / conta de anúncios. */
  assetId: string;
  /** Caso de uso do balde: `pages`, `instagram`, `ads_insights`… */
  useCase?: string;
  /** % das chamadas permitidas na janela de 1h. */
  callCount: number;
  /** % do tempo total permitido. */
  totalTime: number;
  /** % do tempo de CPU permitido. */
  totalCputime: number;
  /** Minutos até o acesso voltar. Só é diferente de 0 quando já bloqueou. */
  regainAccessInMinutes: number;
  /** Quando esta amostra foi lida. */
  at: number;
}

/**
 * A janela do Meta é de uma hora, então uma amostra mais velha que isso não diz
 * nada sobre o agora — e citar um número velho num erro é pior que não citar.
 */
const USAGE_TTL_MS = 60 * 60 * 1000;

/**
 * Teto de ativos rastreados. O portfólio é pequeno, mas a tool `graph_api_get`
 * aceita qualquer caminho: sem teto, um laço sobre IDs arbitrários faria o
 * medidor virar o vazamento.
 */
const MAX_TRACKED = 500;

/** O percentual que está mais perto do bloqueio. */
export function pressure(usage: AssetUsage): number {
  return Math.max(usage.callCount, usage.totalTime, usage.totalCputime);
}

function toPct(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function toEntry(
  assetId: string,
  raw: Record<string, unknown>,
  at: number,
): AssetUsage {
  return {
    assetId,
    useCase: typeof raw.type === "string" ? raw.type : undefined,
    callCount: toPct(raw.call_count),
    totalTime: toPct(raw.total_time),
    totalCputime: toPct(raw.total_cputime),
    regainAccessInMinutes: toPct(raw.estimated_time_to_regain_access),
    at,
  };
}

/**
 * Lê o header. Aceita as duas formas que a Graph API usa: o
 * `x-business-use-case-usage`, que é um objeto de ativo → lista de casos de
 * uso, e o `x-app-usage`, que traz os mesmos campos soltos e vale para o app
 * inteiro (aqui guardado sob o ativo `app`).
 *
 * Header malformado devolve lista vazia em vez de estourar: isto é diagnóstico,
 * e nenhuma resposta boa pode ser perdida porque um medidor mudou de formato.
 */
export function parseUsageHeader(raw: string, at = Date.now()): AssetUsage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const record = parsed as Record<string, unknown>;

  // x-app-usage: os campos vêm soltos, sem ativo.
  if ("call_count" in record || "total_cputime" in record) {
    return [toEntry("app", record, at)];
  }

  const out: AssetUsage[] = [];
  for (const [assetId, value] of Object.entries(record)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === "object") {
        out.push(toEntry(assetId, item as Record<string, unknown>, at));
      }
    }
  }
  return out;
}

/** Frase curta para entrar numa mensagem de erro. */
export function describeUsage(usage: AssetUsage): string {
  const alvo =
    usage.assetId === "app" ? "o app" : `o ativo ${usage.assetId}`;
  const caso = usage.useCase ? ` (${usage.useCase})` : "";
  const partes = [
    `chamadas ${Math.round(usage.callCount)}%`,
    `CPU ${Math.round(usage.totalCputime)}%`,
    `tempo ${Math.round(usage.totalTime)}%`,
  ].join(", ");
  const volta =
    usage.regainAccessInMinutes > 0
      ? ` Libera em ~${Math.ceil(usage.regainAccessInMinutes)} min.`
      : "";
  return `Cota do Meta para ${alvo}${caso}: ${partes}.${volta}`;
}

/**
 * Guarda a última leitura por ativo e caso de uso.
 *
 * Vive no `GraphClient` porque é lá que passa toda resposta da Graph API — e
 * uma instância por processo, como o cache do portfólio, para que a leitura
 * feita numa requisição sirva à seguinte.
 */
export class UsageTracker {
  private readonly samples = new Map<string, AssetUsage>();

  /** Chamado a cada resposta, com o valor cru do header (ou `null`). */
  record(raw: string | null | undefined, at = Date.now()): void {
    if (!raw) return;
    for (const usage of parseUsageHeader(raw, at)) {
      this.samples.set(`${usage.assetId}|${usage.useCase ?? ""}`, usage);
    }
    if (this.samples.size > MAX_TRACKED) this.evict();
  }

  /** Leituras ainda válidas de um ativo, da mais pressionada para a menos. */
  forAsset(assetId: string, now = Date.now()): AssetUsage[] {
    return [...this.samples.values()]
      .filter((u) => u.assetId === assetId && now - u.at < USAGE_TTL_MS)
      .sort((a, b) => pressure(b) - pressure(a));
  }

  /**
   * O ativo dono do caminho da requisição. Os caminhos da Graph API começam
   * pelo ID do nó (`/17841400000000/insights`), então o erro de um batch sabe
   * de quem é a cota que estourou.
   */
  forPath(path: string, now = Date.now()): AssetUsage[] {
    const id = /^\/?(\d+)/.exec(path)?.[1];
    return id ? this.forAsset(id, now) : [];
  }

  /** A leitura mais pressionada do portfólio, entre as ainda válidas. */
  worst(now = Date.now()): AssetUsage | undefined {
    return [...this.samples.values()]
      .filter((u) => now - u.at < USAGE_TTL_MS)
      .sort((a, b) => pressure(b) - pressure(a))[0];
  }

  private evict(): void {
    // Mais velhas primeiro: uma amostra antiga já não seria citada de qualquer
    // forma, porque o TTL a descarta na leitura.
    const ordered = [...this.samples.entries()].sort(
      ([, a], [, b]) => a.at - b.at,
    );
    for (const [key] of ordered.slice(0, this.samples.size - MAX_TRACKED)) {
      this.samples.delete(key);
    }
  }
}
