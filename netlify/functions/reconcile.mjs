// Scheduled Function — reconciliação dos resgates que ficaram no meio.
//
// ============================ LEIA ANTES DE MEXER =====================
// NUNCA cria order. Este job só LÊ o order_status e aplica o desfecho no
// nosso banco. Se algum dia parecer que ele precisa "tentar de novo", a
// resposta é não: o create da Lapak não tem chave de idempotência (A0), e
// um retry automático aqui viraria cobrança dupla enquanto ninguém olha.
//
// Existe porque a tela do portador tem teto de 5 minutos, e o resgate não
// pode depender de a aba dele ficar aberta. Um voucher PROCESSING sem
// dono é dinheiro parado dos dois lados.
//
// Roda a cada 15 min. Não tem rota pública: Scheduled Functions do
// Netlify não são invocáveis por HTTP externo.
// ======================================================================
//
// O que ele faz com cada voucher preso em PROCESSING (ver
// reconcileDecision, em lib/redeem.mjs — a decisão é função pura):
//
//   wait     tentativa recente demais, resgate pode estar em curso
//   poll     tem tid → consulta e resolve (USADO ou de volta pra EMITIDO)
//   release  nenhuma order chegou a sair → devolve o voucher
//   manual   AMBÍGUO: create sem resposta, sem tid. NÃO se toca no
//            voucher. Vira alerta no log e espera olho humano — liberar
//            no escuro é arriscar entregar e cobrar duas vezes.
//
// Env vars: as mesmas do /api/redeem.

import { serverConfig, MisconfiguredError } from "../../lib/supabase.mjs";
import { lapakConfig, orderStatus, LapakError, TERMINAL_ERROR_STATUS } from "../../lib/lapak.mjs";
import { logEvent, codeLabel } from "../../lib/http.mjs";
import {
  listProcessingVouchers,
  listPendingPinEmails,
  reconcileDecision,
  releaseVoucher,
  failAttempt,
  finishRedeem,
  PIN_REPLAY_MS,
} from "../../lib/redeem.mjs";
import { loadSkuMap } from "../../lib/sku-map.mjs";
import { expectedDeliveryType } from "../../lib/forms.mjs";
import { sendPinEmail } from "../../lib/notify.mjs";

// A cada 15 min, como o brief define. Um voucher abandonado resolve em no
// máximo ~20 min (5 min pra tentativa ficar velha + o próximo tick).
export const config = { schedule: "*/15 * * * *" };

export default async () => {
  let cfg;
  let lapak;
  try {
    cfg = serverConfig();
    lapak = lapakConfig();
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      console.error(`[reconcile] ${err.message}`);
      return new Response("misconfigured", { status: 500 });
    }
    throw err;
  }

  const nowMs = Date.now();
  const tally = { seen: 0, waited: 0, settled: 0, released: 0, manual: 0, errors: 0, emails: 0 };

  // Catálogo de entrega (Brief 6): aqui ele diz se o resgate concluído era
  // de PIN e, portanto, se cabe email. Falha de leitura não derruba o job —
  // sem o mapa, nenhum email sai neste tick e a fila espera o próximo.
  let skuMap = [];
  try {
    skuMap = await loadSkuMap(cfg);
  } catch (err) {
    console.error(`[reconcile] sku map indisponível, emails adiados: ${err.message}`);
  }

  let vouchers;
  try {
    vouchers = await listProcessingVouchers(cfg);
  } catch (err) {
    console.error(`[reconcile] leitura falhou: ${err.message}`);
    return new Response("upstream error", { status: 503 });
  }

  // Estritamente serial: nunca em paralelo. O fornecedor tem rate limit e
  // este job não tem pressa nenhuma.
  for (const voucher of vouchers) {
    tally.seen += 1;
    const label = codeLabel(voucher.code, cfg.salt);
    const decision = reconcileDecision(voucher, nowMs);

    try {
      if (decision.action === "wait") {
        tally.waited += 1;
        continue;
      }

      if (decision.action === "release") {
        await releaseVoucher(cfg, voucher.id);
        tally.released += 1;
        logEvent({ evt: "reconcile", result: "released", code: label, cause: decision.reason });
        continue;
      }

      if (decision.action === "manual") {
        tally.manual += 1;
        // Este log é o alerta. Um voucher aqui NÃO se resolve sozinho:
        // alguém precisa procurar a order no painel da Lapak pelo horário
        // e pelo SKU, e então fechar em USADO ou devolver à mão.
        console.error(
          `[reconcile] ATENÇÃO — voucher preso sem tid, precisa de conferência manual: ` +
            `code=${label} attempt=${decision.attempt.attempt_number} ` +
            `sku=${decision.attempt.product_code} criado=${decision.attempt.created_at}`
        );
        logEvent({ evt: "reconcile", result: "manual", code: label, cause: decision.reason });
        continue;
      }

      // poll — o caminho normal do abandono de tela.
      const attempt = decision.attempt;
      const result = await orderStatus(lapak, attempt.lapak_tid);

      if (result.status === "SUCCESS") {
        // Este é O caso que o Brief 5 existe pra resolver: o portador
        // fechou a aba e ninguém está na tela pra ver o PIN. O
        // order_status que acabou de ser lido JÁ traz o código em memória
        // (result.pin), então o email sai daqui sem nenhuma chamada extra
        // ao fornecedor.
        //
        // pin_delivered continua false de propósito: ele mede "apareceu na
        // TELA". Quem registra o email é pin_email_at — dois canais, duas
        // colunas, nenhuma sobrecarga de significado.
        const isPin = expectedDeliveryType(attempt.product_code, skuMap) === "PIN";
        const pin = isPin ? result.pin : null;

        await finishRedeem(cfg, {
          voucherId: voucher.id,
          attemptId: attempt.id,
          tid: attempt.lapak_tid,
          productCode: attempt.product_code,
          pinDelivered: false,
          pinEmailDue: !!pin,
        });

        if (pin) {
          const sent = await sendPinEmail(cfg, {
            attemptId: attempt.id,
            email: attempt.email,
            locale: voucher.batch?.locale,
            pin,
            serial: result.serial,
            label,
          });
          if (sent) tally.emails += 1;
        }

        tally.settled += 1;
        logEvent({ evt: "reconcile", result: "settled", code: label, tid: attempt.lapak_tid });
        continue;
      }

      if (result.status && TERMINAL_ERROR_STATUS.has(result.status)) {
        await failAttempt(cfg, attempt.id, `lapak_${result.status.toLowerCase()}`);
        await releaseVoucher(cfg, voucher.id);
        tally.released += 1;
        logEvent({
          evt: "reconcile",
          result: "released",
          code: label,
          cause: `lapak_${result.status.toLowerCase()}`,
        });
        continue;
      }

      // PENDING ou desconhecido: deixa quieto pro próximo tick. Nunca
      // liberar um voucher cujo desfecho não conhecemos.
      tally.waited += 1;
      if (result.status && result.status !== "PENDING") {
        console.error(
          `[reconcile] status desconhecido da Lapak: ${result.status} tid=${attempt.lapak_tid}`
        );
      }
    } catch (err) {
      tally.errors += 1;
      const detail = err instanceof LapakError ? err.code : err.message;
      console.error(`[reconcile] falha em code=${label}: ${detail}`);
    }
  }

  // ---------------- reenvio do email de PIN (Brief 5) ----------------
  //
  // Segunda varredura, independente da primeira: aqui os vouchers JÁ estão
  // USADO, então eles não aparecem em listProcessingVouchers(). A fila é a
  // flag pin_email_due, baixada só quando um envio confirma.
  //
  // Rebusca o PIN na Lapak pelo tid — leitura pura, não cobra e não
  // entrega nada. É o mesmo caminho da reexibição de 24h, pela mesma
  // razão: não existe armazenamento nosso do PIN.
  const since = new Date(nowMs - PIN_REPLAY_MS).toISOString();
  let pending = [];
  try {
    pending = skuMap.length ? await listPendingPinEmails(cfg, since) : [];
  } catch (err) {
    console.error(`[reconcile] leitura da fila de email falhou: ${err.message}`);
  }

  for (const attempt of pending) {
    const label = codeLabel(attempt.voucher?.code || "", cfg.salt);
    try {
      if (!attempt.lapak_tid) continue;
      if (expectedDeliveryType(attempt.product_code, skuMap) !== "PIN") continue;

      const result = await orderStatus(lapak, attempt.lapak_tid);
      if (result.status !== "SUCCESS" || !result.pin) continue;

      const sent = await sendPinEmail(cfg, {
        attemptId: attempt.id,
        email: attempt.email,
        locale: attempt.voucher?.batch?.locale,
        pin: result.pin,
        serial: result.serial,
        label,
      });
      if (sent) tally.emails += 1;
    } catch (err) {
      tally.errors += 1;
      const detail = err instanceof LapakError ? err.code : err.message;
      console.error(`[reconcile] reenvio de email falhou code=${label}: ${detail}`);
    }
  }

  // Fora da janela e ainda pendente = o PIN não vai mais por email. Vira
  // uma linha de log, não um envio: passadas 24h o código sai de cena em
  // TODOS os canais, sem exceção.
  tally.email_queue = pending.length;

  logEvent({ evt: "reconcile", result: "run", ...tally });
  return new Response(JSON.stringify(tally), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
