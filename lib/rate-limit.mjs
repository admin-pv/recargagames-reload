// Rate limit por IP, com estado em public.pv_validate_rate.
//
// Netlify Functions são stateless: não existe contador em memória que
// sobreviva entre invocações (nem entre regiões). O contador vive no banco.
//
// Janela FIXA de 10 min (floor do timestamp), não sliding. Um atacante
// pode, no pior caso, emendar o fim de uma janela com o começo da outra e
// fazer 20 tentativas em poucos segundos. Aceitável: o espaço de códigos
// (10 chars, alfabeto de 32) é ~2^50; o limite existe pra tornar brute
// force inviável, e 20/10min já é inviável.

import { hmacHex } from "./http.mjs";
import { sbRpc } from "./supabase.mjs";

export const WINDOW_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 10;

/**
 * Balde SEPARADO pro /api/status (Brief 3). Um resgate legítimo consulta
 * a cada 3s por até 5 min — ~100 chamadas, o que estouraria o balde de 10
 * do validate/redeem na primeira dezena de segundos.
 *
 * Teto de 150 dá folga de erro sem virar porta aberta: o /api/status não
 * é oráculo de código (exige um attempt_ref existente, que só nasce de um
 * resgate real), e o throttle de 3s por attempt (last_polled_at) já
 * impede que essas chamadas virem carga no fornecedor.
 */
export const STATUS_MAX_ATTEMPTS = 150;
export const STATUS_BUCKET = "status";

/** Início da janela atual, em ISO — mesma chave pra todos os requests da janela. */
export function windowStart(nowMs) {
  return new Date(Math.floor(nowMs / WINDOW_MS) * WINDOW_MS).toISOString();
}

/** Segundos até a janela virar (vai no header Retry-After). */
export function retryAfterSeconds(nowMs) {
  const end = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
  return Math.max(1, Math.ceil((end - nowMs) / 1000));
}

/**
 * ip_hash = HMAC-SHA256(salt, ip). O IP cru nunca é gravado nem logado.
 * HMAC em vez de sha256(salt + ip) só por higiene de construção; o
 * requisito do brief (SHA-256 + salt de env var) está atendido.
 */
export function ipHash(ip, salt, bucket = "") {
  // O balde entra no valor hasheado, não numa coluna nova: dois baldes do
  // mesmo IP viram duas chaves distintas na mesma tabela, e o IP continua
  // irrecuperável a partir dela.
  return hmacHex(salt, bucket ? `${bucket}|${ip || "unknown-ip"}` : ip || "unknown-ip");
}

/**
 * Conta a tentativa e diz se passou do teto.
 *
 * Incremento atômico via RPC pv_validate_rate_hit (INSERT ... ON CONFLICT
 * DO UPDATE ... RETURNING) — ler-depois-escrever daria corrida.
 *
 * Erro aqui NÃO é engolido: quem chama trata como fail-closed (503). Sem
 * limitador funcionando, o /api/validate viraria oráculo de brute force —
 * preferimos negar serviço por instantes a abrir essa porta.
 */
export async function hitRateLimit(cfg, ip, nowMs, { bucket = "", max = MAX_ATTEMPTS } = {}) {
  const attempts = await sbRpc(cfg, "pv_validate_rate_hit", {
    p_ip_hash: ipHash(ip, cfg.salt, bucket),
    p_window_start: windowStart(nowMs),
  });
  const count = Number(attempts);
  return {
    attempts: count,
    limited: !Number.isFinite(count) || count > max,
    max,
  };
}
