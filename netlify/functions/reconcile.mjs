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
  reconcileDecision,
  releaseVoucher,
  failAttempt,
  finishRedeem,
} from "../../lib/redeem.mjs";

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
  const tally = { seen: 0, waited: 0, settled: 0, released: 0, manual: 0, errors: 0 };

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
        // O PIN não é exibido aqui (não há ninguém na tela) e não é
        // gravado. pin_delivered fica false: o portador ainda pode buscá-lo
        // pelo /api/status dentro da janela de reexibição.
        await finishRedeem(cfg, {
          voucherId: voucher.id,
          attemptId: attempt.id,
          tid: attempt.lapak_tid,
          productCode: attempt.product_code,
          pinDelivered: false,
        });
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

  logEvent({ evt: "reconcile", result: "run", ...tally });
  return new Response(JSON.stringify(tally), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
