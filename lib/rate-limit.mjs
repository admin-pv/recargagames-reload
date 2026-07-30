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
export function ipHash(ip, salt) {
  return hmacHex(salt, ip || "unknown-ip");
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
export async function hitRateLimit(cfg, ip, nowMs) {
  const attempts = await sbRpc(cfg, "pv_validate_rate_hit", {
    p_ip_hash: ipHash(ip, cfg.salt),
    p_window_start: windowStart(nowMs),
  });
  const count = Number(attempts);
  return {
    attempts: count,
    limited: !Number.isFinite(count) || count > MAX_ATTEMPTS,
  };
}
