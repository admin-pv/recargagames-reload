// POST /api/status — acompanha o desfecho de um resgate já disparado.
//
// ============================ LEIA ANTES DE MEXER =====================
// SOMENTE LEITURA do lado da Lapak: aqui só se chama `order_status`, que
// não cobra e não entrega. NENHUM caminho deste arquivo pode criar order —
// se um dia parecer que precisa, o desenho está errado.
//
// É este endpoint que fecha o resgate (PROCESSING → USADO) quando a order
// resolve, porque o PIN só existe no order_status e alguém precisa
// observá-lo. Todo fechamento é condicional em `status=eq.PROCESSING`:
// este endpoint e a reconciliação podem olhar o mesmo tid ao mesmo tempo,
// e só um pode ganhar.
//
// PIN: passa por aqui em memória e sobe na resposta. Nunca é gravado no
// nosso banco e nunca entra em log — nem truncado, nem em debug.
// ======================================================================
//
// Contrato:
//   entrada   { code, attempt_ref }
//   em curso  200 { status: "processing" }
//   entregue  200 { status: "success", delivery_type, pin?, serial?, pin_expired? }
//   falhou    200 { status: "failed", message }     ← voucher volta a valer
//   nada a ver 200 { status: "invalid_or_unavailable" }
//   estourou  429 { error: "rate_limited", retry_after_seconds }

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
import {
  hitRateLimit,
  retryAfterSeconds,
  STATUS_MAX_ATTEMPTS,
  STATUS_BUCKET,
} from "../../lib/rate-limit.mjs";
import { normalizeCode, isPlausibleCode } from "../../lib/vouchers.mjs";
import { expectedDeliveryType } from "../../lib/forms.mjs";
import { loadSkuMap } from "../../lib/sku-map.mjs";
import { lapakConfig, orderStatus, LapakError, TERMINAL_ERROR_STATUS } from "../../lib/lapak.mjs";
import {
  findAttempt,
  mayPoll,
  touchPoll,
  finishRedeem,
  failAttempt,
  releaseVoucher,
  markPinDelivered,
  withinPinReplayWindow,
} from "../../lib/redeem.mjs";

export const config = { path: "/api/status" };

const GENERIC_INVALID = { status: "invalid_or_unavailable" };

const FAILED_MESSAGE =
  "Não conseguimos concluir este resgate. Seu código continua válido e nada foi cobrado — escolha um conteúdo novamente.";

const PIN_EXPIRED_MESSAGE =
  "Este resgate já foi concluído. Por segurança, o código PIN não é exibido novamente depois de 24 horas — fale com o suporte se precisar dele.";

const PIN_UNAVAILABLE_MESSAGE =
  "O resgate foi concluído, mas não conseguimos exibir o código PIN aqui. Fale com o suporte informando o seu voucher — o código está garantido.";

export default async (req, context) => {
  const cors = resolveCors(req);
  if (!cors.allowed) {
    logEvent({ evt: "status", result: "cors_rejected" });
    return json(403, { error: "forbidden_origin" }, { allowed: false, origin: null });
  }
  if (req.method === "OPTIONS") return preflight(cors);
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, cors);

  let cfg;
  try {
    cfg = serverConfig();
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      console.error(`[status] ${err.message}`);
      return json(500, { error: "server_misconfigured" }, cors);
    }
    throw err;
  }

  const body = await readJsonBody(req);
  if (body.error) return json(400, { error: body.error }, cors);

  const nowMs = Date.now();

  // Balde SEPARADO (150/10min): o polling legítimo é de ~100 chamadas por
  // resgate e estouraria o balde de 10 do validate/redeem em segundos.
  let rate;
  try {
    rate = await hitRateLimit(cfg, clientIp(req, context), nowMs, {
      bucket: STATUS_BUCKET,
      max: STATUS_MAX_ATTEMPTS,
    });
  } catch (err) {
    console.error(`[status] rate limiter unavailable: ${err.message}`);
    return json(503, { error: "temporarily_unavailable" }, cors);
  }
  if (rate.limited) {
    const retry = retryAfterSeconds(nowMs);
    logEvent({ evt: "status", result: "rate_limited", attempts: rate.attempts });
    return json(
      429,
      { error: "rate_limited", retry_after_seconds: retry, max_attempts: STATUS_MAX_ATTEMPTS },
      cors,
      { "Retry-After": String(retry) }
    );
  }

  const code = normalizeCode(body.value.code);
  const ref = String(body.value.attempt_ref ?? "").trim();
  const label = codeLabel(code, cfg.salt);

  // O attempt_ref é <code>-a<n>: exigir que ele comece pelo código impede
  // que alguém com um attempt_ref alheio (ou chutado) leia o resgate de
  // outra pessoa. O código continua sendo o segredo, aqui como no resto.
  if (!isPlausibleCode(code) || !/^-a\d{1,4}$/.test(ref.slice(code.length)) || !ref.startsWith(`${code}-a`)) {
    logEvent({ evt: "status", result: "malformed", code: label });
    return json(200, GENERIC_INVALID, cors);
  }

  let attempt;
  try {
    attempt = await findAttempt(cfg, ref);
  } catch (err) {
    if (err instanceof UpstreamError) {
      // Rótulo mascarado: nem a mensagem redigida nem o attempt_ref podem
      // aparecer aqui — o attempt_ref carrega o código inteiro.
      console.error(`[status] code=${label} ${err.message}`);
      return json(503, { error: "temporarily_unavailable" }, cors);
    }
    throw err;
  }

  // Não existe, ou existe e é de outro voucher: mesma resposta genérica.
  if (!attempt || !attempt.voucher || attempt.voucher.code !== code) {
    logEvent({ evt: "status", result: "not_found", code: label });
    return json(200, GENERIC_INVALID, cors);
  }

  // Mesmo catálogo do redeemer (Brief 6). Aqui ele não decide order
  // nenhuma — só se a tela vai exibir PIN. Falha de leitura vira 503, como
  // qualquer outra falha de Supabase deste endpoint: o polling volta na
  // próxima batida e nenhum estado se perde.
  let skuMap;
  try {
    skuMap = await loadSkuMap(cfg);
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error(`[status] sku map indisponível code=${label} ${err.message}`);
      return json(503, { error: "temporarily_unavailable" }, cors);
    }
    throw err;
  }

  // `|| "DTU"` é o conservador: SKU que sumiu do catálogo entre o resgate e
  // a consulta não vira "mostra o PIN". Sem PIN na tela o portador recorre
  // ao suporte; com PIN errado na tela, não há volta.
  const delivery = expectedDeliveryType(attempt.product_code, skuMap) || "DTU";
  const logBase = { evt: "status", code: label, attempt: attempt.attempt_number, delivery_type: delivery };

  // Já fracassou: o voucher já foi devolvido pelo redeem (ou pela
  // reconciliação) e o portador pode escolher outro conteúdo.
  if (attempt.result === "error") {
    logEvent({ ...logBase, result: "failed", error_code: attempt.error_code || null });
    return json(200, { status: "failed", message: FAILED_MESSAGE }, cors);
  }

  // Já concluiu. PIN pode ser reexibido por 24h (decisão do Brief 3):
  // quem tem o código é o dono do voucher, e o PIN é rebuscado na Lapak,
  // nunca lido de um armazenamento nosso — não existe armazenamento.
  if (attempt.result === "success") {
    if (delivery !== "PIN") {
      logEvent({ ...logBase, result: "success_replay" });
      return json(200, { status: "success", delivery_type: delivery }, cors);
    }
    if (!withinPinReplayWindow(attempt, nowMs)) {
      logEvent({ ...logBase, result: "pin_replay_expired" });
      return json(
        200,
        { status: "success", delivery_type: "PIN", pin_expired: true, message: PIN_EXPIRED_MESSAGE },
        cors
      );
    }
    // Reexibição rebusca na Lapak; o PIN nunca sai de um armazenamento
    // nosso, porque não existe armazenamento nosso do PIN.
    return replayPin(cfg, attempt, { cors, logBase, nowMs });
  }

  // -------- pendente: é aqui que se olha o desfecho na Lapak --------

  // Sem tid não há o que consultar (create ambíguo). Fica em curso; quem
  // resolve é a reconciliação, com olho humano.
  if (!attempt.lapak_tid) {
    logEvent({ ...logBase, result: "pending_without_tid" });
    return json(200, { status: "processing" }, cors);
  }

  // Throttle de 3s por attempt — o "cache" que o brief pede, guardado no
  // banco porque function nenhuma sobrevive entre invocações.
  if (!mayPoll(attempt, nowMs)) {
    return json(200, { status: "processing" }, cors);
  }

  let lapak;
  try {
    lapak = lapakConfig();
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      console.error(`[status] ${err.message}`);
      return json(500, { error: "server_misconfigured" }, cors);
    }
    throw err;
  }

  await touchPoll(cfg, attempt.id).catch(() => {});

  let result;
  try {
    result = await orderStatus(lapak, attempt.lapak_tid);
  } catch (err) {
    if (!(err instanceof LapakError)) throw err;
    // Consulta falhou: não muda nada de lado nenhum, o cliente tenta de novo.
    console.error(`[status] order_status ${err.code} tid=${attempt.lapak_tid}`);
    return json(200, { status: "processing" }, cors);
  }

  if (result.status === "SUCCESS") {
    return await settleSuccess(cfg, attempt, result, { cors, logBase, delivery });
  }

  if (result.status && TERMINAL_ERROR_STATUS.has(result.status)) {
    await failAttempt(cfg, attempt.id, `lapak_${result.status.toLowerCase()}`).catch(() => {});
    await releaseVoucher(cfg, attempt.voucher_id).catch((e) =>
      console.error(`[status] release após ${result.status}: ${e.message}`)
    );
    logEvent({ ...logBase, result: "failed", error_code: `lapak_${result.status.toLowerCase()}` });
    return json(200, { status: "failed", message: FAILED_MESSAGE }, cors);
  }

  if (result.status && result.status !== "PENDING") {
    // Status que não conhecemos. NÃO liberar o voucher: a order pode estar
    // viva. Fica esperando e a gente vai ver isso no log.
    console.error(`[status] status desconhecido da Lapak: ${result.status} tid=${attempt.lapak_tid}`);
  }

  return json(200, { status: "processing" }, cors);
};

/** Fecha o resgate: voucher → USADO, attempt → success, PIN pra tela. */
async function settleSuccess(cfg, attempt, result, { cors, logBase, delivery }) {
  const pin = delivery === "PIN" ? result.pin : null;

  await finishRedeem(cfg, {
    voucherId: attempt.voucher_id,
    attemptId: attempt.id,
    tid: attempt.lapak_tid,
    productCode: attempt.product_code,
    pinDelivered: !!pin,
  });

  // PIN entregue mas não parseado é um caso a investigar: o resgate está
  // pago e concluído, e o portador ficou sem o código na tela. O tid vai
  // pro log (não é segredo); o PIN, jamais.
  if (delivery === "PIN" && !pin) {
    console.error(
      `[status] SUCCESS sem PIN parseável tid=${attempt.lapak_tid} — recuperar pelo order_status`
    );
  }

  logEvent({ ...logBase, result: "success", tid: attempt.lapak_tid, pin_delivered: !!pin });

  return json(
    200,
    {
      status: "success",
      delivery_type: delivery,
      ...(pin ? { pin, serial: result.serial || null } : {}),
      // Entrega por código sem código na mão não é "sucesso" pro portador:
      // ele precisa saber que tem um caminho, e não uma tela vazia.
      ...(delivery === "PIN" && !pin
        ? { pin_unavailable: true, message: PIN_UNAVAILABLE_MESSAGE }
        : {}),
    },
    cors
  );
}

/**
 * Reexibe o PIN de um resgate já concluído, rebuscando na Lapak.
 *
 * Quando o throttle de 3s barra a consulta, a resposta é `processing` e NÃO
 * `success`: o front continua no polling e pega o código no ciclo seguinte.
 * Responder "concluído" sem o PIN aqui mostraria a tela de sucesso vazia
 * por uma razão puramente técnica e temporária.
 */
async function replayPin(cfg, attempt, { cors, logBase, nowMs }) {
  if (!attempt.lapak_tid) {
    return json(
      200,
      { status: "success", delivery_type: "PIN", pin_unavailable: true, message: PIN_UNAVAILABLE_MESSAGE },
      cors
    );
  }
  if (!mayPoll(attempt, nowMs)) {
    return json(200, { status: "processing" }, cors);
  }

  let lapak;
  try {
    lapak = lapakConfig();
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      console.error(`[status] ${err.message}`);
      return json(500, { error: "server_misconfigured" }, cors);
    }
    throw err;
  }

  await touchPoll(cfg, attempt.id).catch(() => {});

  try {
    const result = await orderStatus(lapak, attempt.lapak_tid);
    if (result.status === "SUCCESS" && result.pin) {
      if (!attempt.pin_delivered) await markPinDelivered(cfg, attempt.id).catch(() => {});
      logEvent({ ...logBase, result: "pin_replay" });
      return json(
        200,
        { status: "success", delivery_type: "PIN", pin: result.pin, serial: result.serial || null },
        cors
      );
    }
    // Concluído, mas a Lapak não devolveu PIN legível. Resgate está pago e
    // feito: o suporte recupera pelo tid, que está gravado no attempt.
    console.error(`[status] replay sem PIN parseável tid=${attempt.lapak_tid}`);
  } catch (err) {
    if (!(err instanceof LapakError)) throw err;
    console.error(`[status] replay order_status ${err.code} tid=${attempt.lapak_tid}`);
    // Falha de rede é transitória: deixa o front tentar de novo.
    return json(200, { status: "processing" }, cors);
  }

  logEvent({ ...logBase, result: "pin_unavailable" });
  return json(
    200,
    { status: "success", delivery_type: "PIN", pin_unavailable: true, message: PIN_UNAVAILABLE_MESSAGE },
    cors
  );
}
