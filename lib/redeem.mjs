// Estado do resgate no banco: claim atômico, trilha de tentativas e
// fechamento. Este é o arquivo que ESCREVE em pv_vouchers — o único.
//
// Máquina de estados (Brief 1, inalterada):
//   EMITIDO ──claim──► PROCESSING ──sucesso──► USADO
//                          └──erro definitivo──► EMITIDO
//   CANCELADO só sai de EMITIDO (é ação do admin, não deste app).
//   VENCIDO não é status: é derivado de batch.expires_at.
//
// Toda transição daqui é CONDICIONAL no status atual (`status=eq.X` no
// filtro) e confere quantas linhas voltaram. Um UPDATE incondicional
// atropelaria o que a reconciliação ou outra request já tiver decidido.

import { sbRpc, sbSelect, sbInsert, sbPatch } from "./supabase.mjs";
import { commonFieldNames } from "./forms.mjs";

/** Attempt considerado "em voo" depois deste tempo vira caso da reconciliação. */
export const STALE_ATTEMPT_MS = 5 * 60 * 1000;

/** Janela em que o PIN ainda pode ser reexibido pro portador (decisão do Brief 3). */
export const PIN_REPLAY_MS = 24 * 60 * 60 * 1000;

/** Intervalo mínimo entre duas consultas à Lapak pelo MESMO attempt. */
export const POLL_MIN_INTERVAL_MS = 3000;

/**
 * Flip EMITIDO → PROCESSING, atômico, via RPC pv_redeem_claim.
 *
 * É a ÚNICA barreira contra resgate duplicado — o create da Lapak não tem
 * chave de idempotência (A0). Quem não ganha o claim NÃO chama a Lapak,
 * ponto final.
 *
 * Devolve { voucherId, attemptNumber } ou null (perdeu a corrida, ou o
 * voucher não estava apto). O motivo NÃO é diferenciado de propósito.
 */
export async function claimVoucher(cfg, code) {
  const rows = await sbRpc(cfg, "pv_redeem_claim", { p_code: code });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.voucher_id) return null;
  return {
    voucherId: row.voucher_id,
    attemptNumber: Number(row.attempt_number) || 1,
  };
}

/** Devolve o voucher pra EMITIDO. Só age se ele ainda estiver PROCESSING. */
export async function releaseVoucher(cfg, voucherId) {
  const rows = await sbPatch(cfg, "pv_vouchers", `id=eq.${voucherId}&status=eq.PROCESSING`, {
    status: "EMITIDO",
  });
  return Array.isArray(rows) && rows.length > 0;
}

/** attempt_ref = <code>-a<n>. Referência INTERNA: a Lapak não a conhece. */
export function attemptRef(code, attemptNumber) {
  return `${code}-a${attemptNumber}`;
}

/**
 * Grava a tentativa ANTES de chamar a Lapak.
 *
 * A ordem importa: se o create sair e a resposta se perder, a linha já
 * existe e a reconciliação tem por onde começar. O contrário — chamar
 * primeiro e gravar depois — deixaria uma order órfã, sem rastro nenhum
 * do nosso lado.
 *
 * `clean` carrega dado pessoal. Aqui ele se divide:
 *   - email / cpf / marketing_optin → colunas próprias do attempt;
 *   - o resto (user_id do jogo) → player_data da entrega.
 * Nada disso volta pro cliente e nada disso vai pra log.
 */
export async function createAttempt(cfg, { voucherId, attemptNumber, code, productCode, clean, ipHash }) {
  const rows = await sbInsert(cfg, "pv_redeem_attempts", {
    voucher_id: voucherId,
    attempt_number: attemptNumber,
    product_code: productCode,
    attempt_ref: attemptRef(code, attemptNumber),
    result: "pending",
    email: clean.email ?? null,
    cpf: clean.cpf ?? null,
    marketing_optin: clean.marketing_optin ?? false,
    ip_hash: ipHash,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.id) throw new Error("attempt insert did not return a row");
  return row;
}

/** Só o dado de ENTREGA (user_id do jogo) — sem contato, sem consentimento. */
export function deliveryData(clean) {
  const common = new Set(commonFieldNames());
  const out = {};
  for (const [field, value] of Object.entries(clean)) {
    if (!common.has(field)) out[field] = value;
  }
  return out;
}

/**
 * Grava em pv_vouchers.player_data (coluna do Brief 1) o dado de ENTREGA
 * usado nesta tentativa — o user_id do jogo, não o contato.
 *
 * Acontece ANTES do create e não no fechamento, de propósito: se a order
 * sair e tudo depois falhar, ainda fica registrado no voucher para QUAL
 * ID a recarga foi pedida. É a primeira pergunta de qualquer disputa.
 */
export function recordPlayerData(cfg, voucherId, playerData) {
  return sbPatch(cfg, "pv_vouchers", `id=eq.${voucherId}&status=eq.PROCESSING`, {
    player_data: playerData,
  });
}

/** Registra o tid e o custo assim que o create responde. */
export function recordOrder(cfg, attemptId, { tid, costIdr, cost }) {
  return sbPatch(cfg, "pv_redeem_attempts", `id=eq.${attemptId}`, {
    lapak_tid: tid,
    cost_idr: costIdr,
    ...cost,
  });
}

/**
 * Registra um erro AMBÍGUO mantendo `result = 'pending'`.
 *
 * É o caso do timeout no create: a order pode existir. Marcar 'error'
 * aqui faria a reconciliação achar que pode devolver o voucher — e o
 * portador resgataria de novo algo que já foi pago e entregue. O attempt
 * fica pendente de propósito, esperando olho humano.
 */
export function markAttemptAmbiguous(cfg, attemptId, errorCode) {
  return sbPatch(cfg, "pv_redeem_attempts", `id=eq.${attemptId}`, {
    error_code: String(errorCode || "unknown").slice(0, 80),
  });
}

/** Marca a tentativa como fracassada. Não mexe no voucher — quem chama decide. */
export function failAttempt(cfg, attemptId, errorCode) {
  return sbPatch(cfg, "pv_redeem_attempts", `id=eq.${attemptId}`, {
    result: "error",
    error_code: String(errorCode || "unknown").slice(0, 80),
    resolved_at: new Date().toISOString(),
  });
}

/**
 * Fecha o resgate: voucher PROCESSING → USADO e attempt → success.
 *
 * O voucher é atualizado PRIMEIRO e de forma condicional. Se ele não
 * estiver mais PROCESSING (a reconciliação chegou antes, por exemplo),
 * nada é escrito e devolvemos false — dois caminhos podem consultar o
 * mesmo order_status ao mesmo tempo, e só um pode fechar.
 */
export async function finishRedeem(cfg, { voucherId, attemptId, tid, productCode, pinDelivered, pinEmailDue }) {
  const now = new Date().toISOString();

  // player_data não entra aqui: já foi gravado por recordPlayerData() antes
  // do create. Reescrever no fechamento só criaria uma janela pra perder o
  // dado se o resgate fosse concluído pela reconciliação, que não o tem.
  const rows = await sbPatch(cfg, "pv_vouchers", `id=eq.${voucherId}&status=eq.PROCESSING`, {
    status: "USADO",
    redeemed_at: now,
    order_ref: tid,
    redeemed_product_code: productCode,
  });
  const won = Array.isArray(rows) && rows.length > 0;

  await sbPatch(cfg, "pv_redeem_attempts", `id=eq.${attemptId}`, {
    result: "success",
    resolved_at: now,
    ...(pinDelivered ? { pin_delivered: true } : {}),
    // Entra na fila do email de PIN (Brief 5). Só resgate de PIN entra:
    // deixar DTU aqui encheria a fila de linhas que nunca saem.
    ...(pinEmailDue ? { pin_email_due: true } : {}),
  });

  return won;
}

/**
 * Reivindica o direito de mandar as boas-vindas deste voucher.
 *
 * UPDATE condicional em `welcome_email_at IS NULL`: quem receber linha de
 * volta ganhou, quem receber vazio perdeu a corrida (ou o email já saiu).
 * É a mesma mecânica do claim atômico, aplicada a algo que custa muito
 * menos — mas que também não pode acontecer duas vezes.
 */
export async function claimWelcomeEmail(cfg, voucherId) {
  const rows = await sbPatch(
    cfg,
    "pv_vouchers",
    `id=eq.${voucherId}&welcome_email_at=is.null`,
    { welcome_email_at: new Date().toISOString() }
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** Baixa a pendência do email de PIN e carimba o envio. */
export function markPinEmailSent(cfg, attemptId) {
  return sbPatch(cfg, "pv_redeem_attempts", `id=eq.${attemptId}`, {
    pin_email_due: false,
    pin_email_at: new Date().toISOString(),
  });
}

/** Marca que o PIN foi exibido ao portador (métrica; não guarda o PIN). */
export function markPinDelivered(cfg, attemptId) {
  return sbPatch(cfg, "pv_redeem_attempts", `id=eq.${attemptId}&pin_delivered=eq.false`, {
    pin_delivered: true,
  });
}

/** Carimba a consulta à Lapak — é o throttle de 3s por attempt. */
export function touchPoll(cfg, attemptId) {
  return sbPatch(cfg, "pv_redeem_attempts", `id=eq.${attemptId}`, {
    last_polled_at: new Date().toISOString(),
  });
}

// `email` e o `locale` do lote entram aqui por causa do Brief 5: o email
// de PIN é montado neste caminho e precisa saber para quem e em que
// idioma. É PII circulando onde antes não circulava — daí a regra
// reforçada de nunca logar `attempt.email`, só o domínio (mailer.mjs).
const ATTEMPT_SELECT =
  "id,voucher_id,attempt_number,attempt_ref,product_code,result,error_code," +
  "lapak_tid,pin_delivered,last_polled_at,created_at,resolved_at," +
  "email,pin_email_due,pin_email_at," +
  "voucher:pv_vouchers!inner(id,code,status,redeemed_at,batch:pv_batches(locale))";

/** Busca a tentativa pelo attempt_ref (UNIQUE). Null se não existir. */
export async function findAttempt(cfg, ref) {
  const rows = await sbSelect(
    cfg,
    `pv_redeem_attempts?attempt_ref=eq.${encodeURIComponent(ref)}` +
      `&select=${encodeURIComponent(ATTEMPT_SELECT)}&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** true se já passou o intervalo mínimo desde a última consulta à Lapak. */
export function mayPoll(attempt, nowMs) {
  if (!attempt.last_polled_at) return true;
  const last = Date.parse(attempt.last_polled_at);
  return !Number.isFinite(last) || nowMs - last >= POLL_MIN_INTERVAL_MS;
}

/** true enquanto o PIN deste resgate ainda pode ser reexibido na tela. */
export function withinPinReplayWindow(attempt, nowMs) {
  const done = Date.parse(attempt.resolved_at || attempt.voucher?.redeemed_at || "");
  if (!Number.isFinite(done)) return true;
  return nowMs - done <= PIN_REPLAY_MS;
}

const PROCESSING_SELECT =
  "id,code,status," +
  "batch:pv_batches(locale)," +
  "attempts:pv_redeem_attempts(id,attempt_number,product_code,result,lapak_tid,created_at,email)";

/**
 * Vouchers presos em PROCESSING, com as tentativas embutidas. Alimenta a
 * reconciliação. Usa o índice parcial pv_vouchers_processing_idx.
 */
export async function listProcessingVouchers(cfg, limit = 100) {
  const rows = await sbSelect(
    cfg,
    `pv_vouchers?status=eq.PROCESSING&select=${encodeURIComponent(PROCESSING_SELECT)}&limit=${limit}`
  );
  return Array.isArray(rows) ? rows : [];
}

const PENDING_EMAIL_SELECT =
  "id,product_code,lapak_tid,email,created_at," +
  "voucher:pv_vouchers!inner(id,code,batch:pv_batches(locale))";

/**
 * Fila de reenvio do email de PIN (Brief 5): tentativas concluídas cujo
 * email não saiu, dentro da janela de 24h.
 *
 * A janela é a MESMA da reexibição do PIN na tela, e isso é deliberado:
 * passadas 24h o PIN sai de cena em todos os canais, sem exceção. Um
 * caminho que ressuscitasse código dias depois seria uma regra a mais pra
 * lembrar e uma superfície a mais pra errar.
 *
 * Usa o índice parcial pv_redeem_attempts_pin_email_due_idx.
 */
export async function listPendingPinEmails(cfg, sinceIso, limit = 50) {
  const rows = await sbSelect(
    cfg,
    `pv_redeem_attempts?pin_email_due=is.true&created_at=gt.${encodeURIComponent(sinceIso)}` +
      `&select=${encodeURIComponent(PENDING_EMAIL_SELECT)}&limit=${limit}`
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Decide o que fazer com um voucher preso em PROCESSING. Função pura — a
 * decisão fica testável sem banco e sem Lapak.
 *
 *   "wait"    → ainda é novo, deixa quieto (resgate pode estar em curso)
 *   "poll"    → tem tid: consulta o order_status e resolve pelo desfecho
 *   "release" → nenhuma order chegou a sair: devolve pro portador
 *   "manual"  → AMBÍGUO. Attempt sem tid mas que pode ter virado order
 *               (timeout no create). NÃO se toca no voucher: liberar aqui
 *               é arriscar entregar e cobrar duas vezes. Vira alerta.
 */
export function reconcileDecision(voucher, nowMs, staleMs = STALE_ATTEMPT_MS) {
  const attempts = Array.isArray(voucher.attempts) ? voucher.attempts : [];

  // Sem tentativa nenhuma: o claim pegou e o INSERT do attempt não. Nada
  // foi pedido à Lapak — devolver é seguro.
  if (!attempts.length) {
    return { action: "release", reason: "processing_without_attempt" };
  }

  const latest = attempts.reduce((a, b) => (a.attempt_number >= b.attempt_number ? a : b));
  const age = nowMs - Date.parse(latest.created_at || 0);
  if (!Number.isFinite(age) || age < staleMs) return { action: "wait", attempt: latest };

  if (latest.lapak_tid) return { action: "poll", attempt: latest };

  // Erro definitivo já registrado, sem tid: o redeemer devia ter devolvido
  // o voucher e não conseguiu (queda no meio do caminho). Seguro devolver.
  if (latest.result === "error") {
    return { action: "release", reason: "definitive_error_without_tid", attempt: latest };
  }

  return { action: "manual", reason: "pending_without_tid", attempt: latest };
}
