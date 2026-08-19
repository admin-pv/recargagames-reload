// Leitura e avaliação de voucher. SOMENTE LEITURA neste brief: nada aqui
// escreve em pv_vouchers. O flip EMITIDO → PROCESSING é do Brief 3.

import { sbSelect } from "./supabase.mjs";

// Códigos são gerados no admin com alfabeto ABCDEFGHJKLMNPQRSTUVWXYZ23456789
// e prefixo opcional separado por '-' (ex: RLBK-K7M2XQ9DPT). A regex é
// deliberadamente mais larga que o formato atual pra não travar lote com
// prefixo diferente; serve só pra cortar lixo antes de bater no banco.
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{3,63}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** trim + remove espaços internos (colagem) + uppercase. */
export function normalizeCode(input) {
  return String(input ?? "").replace(/\s+/g, "").toUpperCase();
}

export function isPlausibleCode(code) {
  return CODE_RE.test(code);
}

export function isUuid(value) {
  return UUID_RE.test(String(value ?? ""));
}

const SELECT =
  "id,status," +
  "batch:pv_batches!inner(" +
  // `locale` (Brief 5): idioma dos emails deste lote. Fica no lote porque
  // o lote É a campanha — o da Plusmo nasce es-MX.
  "id,name,status,expires_at,locale," +
  "contents:pv_batch_contents(id,display_label,delivery_type,product_code)" +
  ")";

/** Busca o voucher pelo código. Retorna null se não existir. */
export async function findVoucher(cfg, code) {
  const rows = await sbSelect(
    cfg,
    `pv_vouchers?code=eq.${encodeURIComponent(code)}&select=${encodeURIComponent(SELECT)}&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Decide se o voucher pode seguir pro resgate.
 *
 * Resposta INVÁLIDA é sempre a mesma (`invalid_or_unavailable`) pra não
 * diferenciar "não existe" de "usado"/"cancelado"/"vencido" — qualquer
 * diferença viraria oráculo pra brute force.
 *
 * Exceção única: PROCESSING. O usuário legítimo precisa saber que o
 * resgate dele está em andamento. Vaza só "este código existe e está
 * processando", o que o brief aceita explicitamente.
 */
export function evaluateVoucher(voucher, nowMs) {
  const invalid = { ok: false, reason: "invalid_or_unavailable" };
  if (!voucher) return invalid;

  if (voucher.status === "PROCESSING") return { ok: false, reason: "processing" };
  if (voucher.status !== "EMITIDO") return invalid;

  const batch = voucher.batch;
  if (!batch || batch.status !== "active") return invalid;

  const expiresAt = Date.parse(batch.expires_at);
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) return invalid;

  const contents = Array.isArray(batch.contents) ? batch.contents : [];
  // Lote sem conteúdo é erro de cadastro, não estado de voucher. Pro
  // usuário é indistinguível de inválido; o log avisa a gente.
  if (!contents.length) return { ...invalid, misconfigured: "batch_without_contents" };

  return { ok: true, batch, contents };
}
