// POST /api/redeem — STUB DO BRIEF 2.
//
// ============================ LEIA ANTES DE MEXER =====================
// Este endpoint NÃO resgata nada. Ele valida o payload de ponta a ponta
// (código, conteúdo pertencente ao lote, campos do formulário) e responde
// { status: "not_implemented" }.
//
// O que ele deliberadamente NÃO faz — e não deve fazer até o Brief 3:
//   - chamar a Lapak (nem em modo de teste). A chave admin do proxy não
//     existe neste repo — nem o nome dela, e tests/check-secrets.sh reprova
//     o build se alguém a introduzir.
//   - flipar status de voucher (EMITIDO → PROCESSING). É só leitura.
//   - inserir em pv_redeem_attempts.
//   - polling, webhook, parsing de PIN.
//
// Por que validar tudo se não resgata: o contrato de entrada fica travado e
// testado agora, então o Brief 3 troca só o miolo (o bloco final) sem mexer
// no front nem no formato do payload.
// ======================================================================
//
// Contrato:
//   entrada    { code, content_id, player_data }
//   stub ok    200 { status: "not_implemented", message }
//   payload    400 { status: "invalid_payload", errors: { campo: msg } }
//   voucher    200 { status: "invalid_or_unavailable" } | { status: "processing" }
//   estourou   429 { error: "rate_limited", retry_after_seconds }

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
import {
  normalizeCode,
  isPlausibleCode,
  isUuid,
  findVoucher,
  evaluateVoucher,
} from "../../lib/vouchers.mjs";
import { fieldsForContent, validatePlayerData } from "../../lib/forms.mjs";

export const config = { path: "/api/redeem" };

const MAINTENANCE_MESSAGE =
  "O resgate está em manutenção neste momento. Seu código continua válido — tente novamente mais tarde.";

export default async (req, context) => {
  const cors = resolveCors(req);
  if (!cors.allowed) {
    logEvent({ evt: "redeem", result: "cors_rejected" });
    return json(403, { error: "forbidden_origin" }, { allowed: false, origin: null });
  }
  if (req.method === "OPTIONS") return preflight(cors);
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, cors);

  let cfg;
  try {
    cfg = serverConfig();
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      console.error(`[redeem] ${err.message}`);
      return json(500, { error: "server_misconfigured" }, cors);
    }
    throw err;
  }

  const body = await readJsonBody(req);
  if (body.error) return json(400, { error: body.error }, cors);

  const nowMs = Date.now();

  // Mesmo balde de rate limit do /api/validate, de propósito: sem isso o
  // redeem seria o mesmo oráculo de código por outra porta. Um resgate
  // legítimo gasta 2 tentativas do teto de 10 — sobra folga.
  let rate;
  try {
    rate = await hitRateLimit(cfg, clientIp(req, context), nowMs);
  } catch (err) {
    console.error(`[redeem] rate limiter unavailable: ${err.message}`);
    return json(503, { error: "temporarily_unavailable" }, cors);
  }
  if (rate.limited) {
    const retry = retryAfterSeconds(nowMs);
    logEvent({ evt: "redeem", result: "rate_limited", attempts: rate.attempts });
    return json(
      429,
      { error: "rate_limited", retry_after_seconds: retry, max_attempts: MAX_ATTEMPTS },
      cors,
      { "Retry-After": String(retry) }
    );
  }

  const code = normalizeCode(body.value.code);
  const contentId = String(body.value.content_id ?? "");
  const label = codeLabel(code, cfg.salt);

  if (!isPlausibleCode(code) || !isUuid(contentId)) {
    logEvent({ evt: "redeem", result: "malformed", code: label });
    return json(200, { status: "invalid_or_unavailable" }, cors);
  }

  let voucher;
  try {
    voucher = await findVoucher(cfg, code);
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error(`[redeem] ${err.message}`);
      return json(503, { error: "temporarily_unavailable" }, cors);
    }
    throw err;
  }

  const verdict = evaluateVoucher(voucher, nowMs);
  if (!verdict.ok) {
    logEvent({ evt: "redeem", result: verdict.reason, code: label });
    return json(200, { status: verdict.reason }, cors);
  }

  // O conteúdo TEM que ser do lote deste voucher. Sem essa checagem o
  // usuário poderia resgatar SKU de outro lote mandando id arbitrário.
  const content = verdict.contents.find((c) => c.id === contentId);
  if (!content) {
    logEvent({ evt: "redeem", result: "content_not_in_batch", code: label });
    return json(200, { status: "invalid_or_unavailable" }, cors);
  }

  // Espelha o fail-closed do /api/validate: conteúdo sem formulário
  // resolvível é recusado, nunca resgatado com campo adivinhado.
  const form = fieldsForContent(content);
  if (!form.ok) {
    console.error(
      `[redeem] ${form.reason}: conteúdo recusado, sku=${content.product_code} content_id=${content.id}`
    );
    logEvent({ evt: "redeem", result: "invalid_or_unavailable", code: label, cause: form.reason });
    return json(200, { status: "invalid_or_unavailable" }, cors);
  }

  const checked = validatePlayerData(form.fields, body.value.player_data);
  if (!checked.ok) {
    logEvent({ evt: "redeem", result: "invalid_payload", code: label });
    return json(400, { status: "invalid_payload", errors: checked.errors }, cors);
  }

  // -------------------------------------------------------------------
  // AQUI ENTRA O BRIEF 3.
  // A partir deste ponto o payload está validado e o voucher está apto:
  //   code (normalizado), content.id, content.product_code,
  //   content.delivery_type, checked.clean (= player_data saneado).
  //
  // O redeemer real vai: flipar EMITIDO → PROCESSING (guardando contra
  // corrida), gravar pv_redeem_attempts com attempt_ref único, chamar o
  // create da Lapak via proxy, fazer polling do order_status, parsear o
  // PIN quando delivery_type='PIN', e fechar em USADO ou voltar pra
  // EMITIDO em caso de erro. NADA disso acontece neste brief.
  // -------------------------------------------------------------------
  // `fields` são só os NOMES dos campos preenchidos. Valor de email e CPF
  // não entra em log em nenhuma hipótese — mesma regra do código do voucher.
  // checked.clean carrega dado pessoal e fica só em memória, nesta request.
  logEvent({
    evt: "redeem",
    result: "not_implemented",
    code: label,
    content_id: content.id,
    delivery_type: content.delivery_type,
    fields: Object.keys(checked.clean),
  });

  return json(200, { status: "not_implemented", message: MAINTENANCE_MESSAGE }, cors);
};
