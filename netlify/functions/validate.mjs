// POST /api/validate — valida um código de Voucher de Parceiro.
//
// SOMENTE LEITURA. Não escreve em pv_vouchers, não muda status, não fala
// com a Lapak. O único INSERT/UPDATE que este endpoint provoca é o contador
// de rate limit (pv_validate_rate).
//
// Contrato:
//   entrada  { code }
//   válido   200 { valid: true, batch_name, expires_at, contents: [...] }
//   inválido 200 { valid: false, reason: "invalid_or_unavailable" }
//   em curso 200 { valid: false, reason: "processing" }
//   estourou 429 { error: "rate_limited", retry_after_seconds }
//
// Env vars (painel Netlify deste site):
//   SUPABASE_URL         https://ashmirzgyuhspymldpfv.supabase.co
//   SUPABASE_SECRET_KEY  sb_secret_...  (NUNCA no repo, NUNCA no front)
//   IP_HASH_SALT         string aleatória longa, fixa

import {
  resolveCors,
  preflight,
  json,
  clientIp,
  codeLabel,
  logEvent,
  readJsonBody,
} from "../../lib/http.mjs";
import { serverConfig, MisconfiguredError, UpstreamError } from "../../lib/supabase.mjs";
import { hitRateLimit, retryAfterSeconds, MAX_ATTEMPTS } from "../../lib/rate-limit.mjs";
import { normalizeCode, isPlausibleCode, findVoucher, evaluateVoucher } from "../../lib/vouchers.mjs";
import { fieldsForContent } from "../../lib/forms.mjs";

export const config = { path: "/api/validate" };

const GENERIC_INVALID = { valid: false, reason: "invalid_or_unavailable" };

export default async (req, context) => {
  const cors = resolveCors(req);
  if (!cors.allowed) {
    logEvent({ evt: "validate", result: "cors_rejected" });
    return json(403, { error: "forbidden_origin" }, { allowed: false, origin: null });
  }
  if (req.method === "OPTIONS") return preflight(cors);
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, cors);

  let cfg;
  try {
    cfg = serverConfig();
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      console.error(`[validate] ${err.message}`);
      return json(500, { error: "server_misconfigured" }, cors);
    }
    throw err;
  }

  const body = await readJsonBody(req);
  if (body.error) return json(400, { error: body.error }, cors);

  const nowMs = Date.now();

  // Rate limit ANTES de qualquer coisa que dependa do input: request
  // malformada também consome tentativa, senão sondar fica de graça.
  let rate;
  try {
    rate = await hitRateLimit(cfg, clientIp(req, context), nowMs);
  } catch (err) {
    // Fail-closed. Sem limitador, este endpoint é oráculo de brute force.
    console.error(`[validate] rate limiter unavailable: ${err.message}`);
    return json(503, { error: "temporarily_unavailable" }, cors);
  }
  if (rate.limited) {
    const retry = retryAfterSeconds(nowMs);
    logEvent({ evt: "validate", result: "rate_limited", attempts: rate.attempts });
    return json(
      429,
      { error: "rate_limited", retry_after_seconds: retry, max_attempts: MAX_ATTEMPTS },
      cors,
      { "Retry-After": String(retry) }
    );
  }

  const code = normalizeCode(body.value.code);
  const label = codeLabel(code, cfg.salt);

  if (!isPlausibleCode(code)) {
    // Mesma resposta de código inexistente: nada de dica de formato.
    logEvent({ evt: "validate", result: "malformed", code: label });
    return json(200, GENERIC_INVALID, cors);
  }

  let voucher;
  try {
    voucher = await findVoucher(cfg, code);
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error(`[validate] ${err.message}`);
      return json(503, { error: "temporarily_unavailable" }, cors);
    }
    throw err;
  }

  const verdict = evaluateVoucher(voucher, nowMs);
  if (!verdict.ok) {
    if (verdict.misconfigured) {
      console.error(`[validate] ${verdict.misconfigured} code=${label}`);
    }
    logEvent({ evt: "validate", result: verdict.reason, code: label });
    return json(200, { valid: false, reason: verdict.reason }, cors);
  }

  const contents = verdict.contents.map((content) => {
    const form = fieldsForContent(content);
    if (content.delivery_type === "DTU" && !form.matched) {
      // SKU DTU fora do forms-map: caiu no genérico. Não quebra o usuário,
      // mas queremos saber pra mapear a categoria direito.
      console.warn(`[validate] DTU sku unmapped, using fallback: ${content.product_code}`);
    }
    return {
      id: content.id,
      display_label: content.display_label,
      delivery_type: content.delivery_type,
      fields: form.fields,
    };
  });

  logEvent({
    evt: "validate",
    result: "valid",
    code: label,
    batch_id: verdict.batch.id,
    contents: contents.length,
  });

  return json(
    200,
    {
      valid: true,
      batch_name: verdict.batch.name,
      expires_at: verdict.batch.expires_at,
      contents,
    },
    cors
  );
};
