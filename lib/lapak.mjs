// Cliente do proxy da Lapak (api.recargagames.com). É o ÚNICO arquivo do
// repo que fala com o mundo do fornecedor.
//
// ============================ LEIA ANTES DE MEXER =====================
// Aqui sai dinheiro. Três regras que não se negociam:
//
//  1. NUNCA existe retry automático de create. Nem em timeout, nem em 5xx,
//     nem "só uma vez". O create da Lapak não aceita referência externa
//     (confirmado no teste A0), logo o fornecedor NÃO deduplica: um
//     segundo create é uma segunda cobrança e uma segunda entrega.
//
//  2. Falha de create se divide em DUAS categorias, e a diferença vale
//     dinheiro:
//       - `definitive`: temos prova de que nenhuma order foi criada
//         (o proxy negou a chave, ou a Lapak respondeu com código de erro).
//         Seguro devolver o voucher pra EMITIDO.
//       - `ambiguous`: a request pode ter chegado na Lapak e a resposta é
//         que se perdeu (timeout nosso, 500 do proxy, 5xx da Lapak). NÃO
//         se devolve o voucher: sem tid não dá nem pra consultar o
//         order_status. Fica PROCESSING e vira caso humano.
//     Chutar `definitive` num caso ambíguo = liberar o voucher pra um
//     segundo resgate depois de o primeiro já ter sido pago e entregue.
//
//  3. PIN nunca é logado, nunca é persistido. Ele passa por este módulo
//     em memória, sobe pra resposta HTTP e acabou.
// ======================================================================
//
// Contrato do proxy (playvision-proxy/server.js):
//   POST /api/order          → cria a order      (protegido por x-proxy-key)
//   GET  /api/order_status   → consulta pelo tid (protegido por x-proxy-key)
//   header x-env: dev | prod — escolhe o ambiente Lapak POR REQUEST. O
//   default do proxy é `dev`; aqui a env var é obrigatória justamente pra
//   ninguém cair em dev por omissão e marcar voucher como usado sem
//   entregar nada.
//
// O proxy embrulha a resposta da Lapak: { status, ok, data }, onde `data`
// é o corpo cru do fornecedor ({ code, data: {...} }). Daí o
// `data.data.transactions[i].voucher_code` do relatório do A0.

import { MisconfiguredError } from "./supabase.mjs";

const PROXY_BASE = "https://api.recargagames.com";

// 10s no create, por decisão do brief. Timeout aqui NÃO é erro definitivo:
// a order pode ter sido criada do outro lado (ver regra 2 acima).
const CREATE_TIMEOUT_MS = 10000;
const STATUS_TIMEOUT_MS = 8000;

/**
 * Status da Lapak que encerram a order SEM entrega. Lista BRANCA, e é
 * assim de propósito: um status desconhecido (ou novo) não pode devolver
 * o voucher pro portador, porque a order pode seguir viva do outro lado e
 * ele resgataria de novo algo já pago. Desconhecido = continua esperando.
 *
 * O A0 observou exatamente SUCCESS | PENDING | REFUNDED; os demais estão
 * aqui como defesa contra variação de nomenclatura, não por terem sido
 * vistos.
 */
export const TERMINAL_ERROR_STATUS = new Set([
  "REFUNDED",
  "REFUND",
  "CANCELED",
  "CANCELLED",
  "FAILED",
  "FAILURE",
]);

/** Erro na conversa com o proxy/Lapak. `definitive` = nenhuma order saiu. */
export class LapakError extends Error {
  constructor(code, { definitive, detail } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.definitive = !!definitive;
  }
}

const REQUIRED_ENV = ["PROXY_RELOAD_KEY", "LAPAK_ENV"];

/**
 * Config do redeemer. Separada da serverConfig() do Supabase de propósito:
 * o /api/validate não precisa de nada disto e não pode passar a quebrar
 * por falta de env var da Lapak.
 *
 * FX_USD_IDR / FX_BRL_USD são OPCIONAIS: sem elas o resgate acontece
 * normalmente e só os custos derivados (cost_usd/cost_brl) ficam nulos.
 * O cost_idr, que é o número que a Lapak devolve, é gravado sempre.
 * Bloquear resgate por falta de cotação seria trocar receita por planilha.
 */
export function lapakConfig() {
  const missing = REQUIRED_ENV.filter((k) => !String(process.env[k] || "").trim());
  if (missing.length) {
    throw new MisconfiguredError(`Missing env vars: ${missing.join(", ")}`);
  }

  const env = process.env.LAPAK_ENV.trim().toLowerCase();
  if (env !== "prod" && env !== "dev") {
    throw new MisconfiguredError(`LAPAK_ENV inválida: use "prod" ou "dev"`);
  }

  return {
    base: (process.env.PROXY_BASE_URL || PROXY_BASE).trim().replace(/\/+$/, ""),
    key: process.env.PROXY_RELOAD_KEY.trim(),
    env,
    fxUsdIdr: positiveNumber(process.env.FX_USD_IDR),
    fxBrlUsd: positiveNumber(process.env.FX_BRL_USD),
  };
}

function positiveNumber(raw) {
  const value = Number(String(raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Interruptor de pânico (Plano B do brief). Desliga o resgate sem deploy:
 * basta REDEEM_ENABLED=false no painel do Netlify.
 *
 * Ausente = LIGADO. É deliberado: um resgate não pode parar porque alguém
 * esqueceu de criar a variável. Desligar exige dizer "false" com todas as
 * letras.
 */
export function redeemEnabled() {
  const raw = String(process.env.REDEEM_ENABLED ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(raw);
}

async function proxyFetch(cfg, path, { method = "GET", body, timeoutMs } = {}) {
  let res;
  try {
    res = await fetch(`${cfg.base}${path}`, {
      method,
      headers: {
        "x-proxy-key": cfg.key,
        "x-env": cfg.env,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Timeout ou socket morto. AMBÍGUO por definição: a request pode ter
    // chegado. Quem chama não pode devolver o voucher pra EMITIDO.
    throw new LapakError(err?.name === "TimeoutError" ? "proxy_timeout" : "proxy_unreachable", {
      definitive: false,
    });
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    // 401/403/503 vêm do gate de auth do PRÓPRIO proxy: a request nunca
    // chegou na Lapak. É config nossa quebrada, e é seguro reverter.
    // 500 do proxy é o catch dele em volta da chamada à Lapak — pode ter
    // saído. Ambíguo.
    const definitive = res.status === 401 || res.status === 403 || res.status === 503;
    throw new LapakError(`proxy_http_${res.status}`, { definitive });
  }

  return payload || {};
}

/**
 * Cria a order na Lapak. UMA vez. Sem retry, em hipótese nenhuma.
 *
 * Contrato do create (corrigido empiricamente no A0 — o do brief original
 * estava errado): `count_order` (não `quantity`), `product_code`, e
 * `user_id` SÓ em DTU. Voucher/PIN não manda user_id.
 *
 * `endUserIp` é o IP CRU do portador e só é preenchido quando a linha do
 * SKU em pv_sku_delivery_map tem requires_ip = true (caso Hoyoverse). É
 * dado pessoal em trânsito: entra no corpo desta request, vai pro
 * fornecedor e acabou. Não é logado aqui, não é logado pelo proxy (que
 * registra só método, URL e status) e não tem coluna no banco — lá só
 * existe o HMAC do IP. Quem não precisa dele não o recebe: o parâmetro
 * chega null e o campo nem aparece no corpo.
 *
 * Devolve { tid, totalPriceIdr, productName }. O PIN NÃO vem aqui — só no
 * order_status, quando o status virar SUCCESS.
 */
export async function createOrder(cfg, { productCode, userId, endUserIp }) {
  const body = { count_order: 1, product_code: productCode };
  if (userId) body.user_id = String(userId);
  if (endUserIp) body.end_user_ip_address = String(endUserIp);

  const envelope = await proxyFetch(cfg, "/api/order", {
    method: "POST",
    body,
    timeoutMs: CREATE_TIMEOUT_MS,
  });

  const lapakStatus = Number(envelope.status);
  const payload = envelope.data || {};
  const code = String(payload.code || "");
  const data = payload.data || {};

  if (code && code.toUpperCase() !== "SUCCESS") {
    // A Lapak respondeu e recusou (SKU inexistente, saldo, params). Nenhuma
    // order foi criada — este é o caminho que devolve o voucher pra EMITIDO.
    throw new LapakError(`lapak_${code.toLowerCase()}`, { definitive: true });
  }

  if (!envelope.ok) {
    // 4xx da Lapak = pedido rejeitado (definitivo). 5xx = pode ter criado.
    throw new LapakError(`lapak_http_${lapakStatus || "unknown"}`, {
      definitive: Number.isFinite(lapakStatus) && lapakStatus >= 400 && lapakStatus < 500,
    });
  }

  const tid = String(data.tid || "").trim();
  if (!tid) {
    // Resposta de sucesso sem tid não deveria existir. Como não dá pra
    // consultar depois, trata como ambíguo: melhor um voucher preso do que
    // uma entrega paga duas vezes.
    throw new LapakError("lapak_success_without_tid", { definitive: false });
  }

  return {
    tid,
    totalPriceIdr: Number.isFinite(Number(data.total_price)) ? Number(data.total_price) : null,
    productName: data.product_name || null,
  };
}

/**
 * Consulta o desfecho de uma order. Leitura pura: chamar de novo não
 * cobra nada e não entrega nada.
 *
 * Devolve { status, pin, serial }:
 *   status  'SUCCESS' | 'PENDING' | 'REFUNDED' | outro | null
 *   pin     só em delivery PIN, e só quando SUCCESS. DTU vem vazio.
 */
export async function orderStatus(cfg, tid) {
  const envelope = await proxyFetch(cfg, `/api/order_status?tid=${encodeURIComponent(tid)}`, {
    timeoutMs: STATUS_TIMEOUT_MS,
  });

  const payload = envelope.data || {};
  const data = payload.data || {};
  const status = data.status ? String(data.status).toUpperCase() : null;

  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  const raw = transactions.map((t) => t && t.voucher_code).find((v) => v);
  const parsed = status === "SUCCESS" ? parseVoucherCode(raw) : null;

  return { status, pin: parsed?.pin || null, serial: parsed?.serial || null };
}

/**
 * O campo `voucher_code` não é estruturado: vem como a string
 * `"PIN : <pin>\tSerial : <serial>"`, separada por TAB (achado do A0).
 * Em DTU vem vazia.
 *
 * Tolerante de propósito — sem "Serial", com espaçamento diferente, ou com
 * a ordem trocada, o PIN ainda sai. Se o formato mudar de vez, devolve
 * null e o resgate fecha sem PIN na tela (o tid fica gravado, então o
 * suporte recupera). Melhor isso do que exibir lixo como se fosse PIN.
 */
export function parseVoucherCode(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const out = { pin: null, serial: null };
  for (const part of text.split(/[\t\n]+/)) {
    const chunk = part.trim();
    if (!chunk) continue;
    const pin = chunk.match(/^PIN\s*:\s*(.+)$/i);
    if (pin) {
      out.pin = pin[1].trim();
      continue;
    }
    const serial = chunk.match(/^Serial\s*:\s*(.+)$/i);
    if (serial) out.serial = serial[1].trim();
  }

  // Sem nenhum prefixo reconhecido e sem TAB: trata a string inteira como
  // o PIN. Cobre o caso de a Lapak simplificar o formato um dia.
  if (!out.pin && !out.serial && !/[\t]/.test(text)) out.pin = text;

  return out.pin || out.serial ? out : null;
}

/**
 * Converte o custo em IDR para USD e BRL usando o snapshot de câmbio das
 * env vars. Sem cotação configurada, devolve nulos — o cost_idr sozinho
 * ainda é uma trilha válida.
 */
export function convertCost(costIdr, cfg) {
  const idr = Number(costIdr);
  if (!Number.isFinite(idr) || !cfg.fxUsdIdr) {
    return { cost_usd: null, cost_brl: null, fx_usd_idr: cfg.fxUsdIdr, fx_brl_usd: cfg.fxBrlUsd };
  }
  const usd = idr / cfg.fxUsdIdr;
  return {
    cost_usd: round(usd, 4),
    cost_brl: cfg.fxBrlUsd ? round(usd * cfg.fxBrlUsd, 4) : null,
    fx_usd_idr: cfg.fxUsdIdr,
    fx_brl_usd: cfg.fxBrlUsd,
  };
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
