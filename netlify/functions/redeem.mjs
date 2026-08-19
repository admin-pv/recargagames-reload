// POST /api/redeem — o resgate de verdade (Brief 3).
//
// ============================ LEIA ANTES DE MEXER =====================
// Este endpoint GASTA DINHEIRO. A ordem dos passos abaixo não é estética:
//
//   1. rate limit          nada acontece sem passar por aqui
//   2. validação de payload + trava SKU × delivery_type
//   3. CLAIM ATÔMICO       EMITIDO → PROCESSING (única barreira antidupla)
//   4. attempt no banco    ANTES da Lapak, pra order nenhuma nascer órfã
//   5. create na Lapak     UMA vez. Sem retry. Nunca.
//   6. tid + custo         gravados assim que o create responde
//   7. resposta            { status: "processing", attempt_ref }
//
// O desfecho NÃO é esperado nesta request: PIN só existe no order_status
// (A0), e segurar a conexão por minutos entregaria timeout ao usuário no
// lugar do prêmio. Quem acompanha é o /api/status; quem varre o que ficou
// para trás é o /api/reconcile.
//
// Inverter 3 e 5 (chamar a Lapak antes de travar o voucher) reabre o
// resgate duplo: o create não tem chave de idempotência do lado deles.
// ======================================================================
//
// Contrato:
//   entrada    { code, content_id, player_data }
//   aceito     200 { status: "processing", attempt_ref }
//   falhou     200 { status: "failed", message }        ← voucher volta a valer
//   payload    400 { status: "invalid_payload", errors: { campo: msg } }
//   voucher    200 { status: "invalid_or_unavailable" } | { status: "processing" }
//   manutenção 200 { status: "maintenance", message }
//   estourou   429 { error: "rate_limited", retry_after_seconds }
//
// Env vars (painel Netlify deste site):
//   SUPABASE_URL, SUPABASE_SECRET_KEY, IP_HASH_SALT   (Brief 2)
//   PROXY_RELOAD_KEY   chave do proxy, escopo do app de resgate
//   LAPAK_ENV          prod | dev — obrigatória, sem default
//   FX_USD_IDR, FX_BRL_USD   opcionais (só afetam cost_usd/cost_brl)
//   REDEEM_ENABLED     "false" desliga o resgate sem deploy

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
import { hitRateLimit, retryAfterSeconds, MAX_ATTEMPTS, ipHash } from "../../lib/rate-limit.mjs";
import {
  normalizeCode,
  isPlausibleCode,
  isUuid,
  findVoucher,
  evaluateVoucher,
} from "../../lib/vouchers.mjs";
import { fieldsForContent, validatePlayerData } from "../../lib/forms.mjs";
import { loadSkuMap } from "../../lib/sku-map.mjs";
import { sendWelcome } from "../../lib/notify.mjs";
import { lapakConfig, redeemEnabled, createOrder, convertCost, LapakError } from "../../lib/lapak.mjs";
import {
  claimVoucher,
  releaseVoucher,
  createAttempt,
  recordOrder,
  recordPlayerData,
  deliveryData,
  failAttempt,
  markAttemptAmbiguous,
  attemptRef,
} from "../../lib/redeem.mjs";

export const config = { path: "/api/redeem" };

const MAINTENANCE_MESSAGE =
  "O resgate está em manutenção neste momento. Seu código continua válido — tente novamente mais tarde.";

// Mensagem única de falha. Não diz QUAL erro a Lapak devolveu: o motivo
// interessa ao log, não ao portador, e detalhar diferenciaria SKU sem
// estoque de SKU inexistente — enumeração do catálogo por outra porta.
const FAILED_MESSAGE =
  "Não conseguimos concluir este resgate. Seu código continua válido e nada foi cobrado — escolha um conteúdo novamente.";

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

  // Interruptor de pânico ANTES de qualquer coisa cara: desligado, este
  // endpoint volta a ser o stub do Brief 2 e não toca em nada.
  if (!redeemEnabled()) {
    logEvent({ evt: "redeem", result: "maintenance" });
    return json(200, { status: "maintenance", message: MAINTENANCE_MESSAGE }, cors);
  }

  const body = await readJsonBody(req);
  if (body.error) return json(400, { error: body.error }, cors);

  const nowMs = Date.now();

  // IP CRU do portador. Ele já existia aqui em duas formas de uso (balde do
  // rate limit e ip_hash do attempt); agora tem uma terceira, o
  // end_user_ip_address dos SKUs com requires_ip. Fica numa const só pra
  // ficar visível que é UM dado pessoal com três destinos — e que nenhum
  // deles é log nem coluna em claro.
  const rawIp = clientIp(req, context);

  // Mesmo balde de rate limit do /api/validate, de propósito: sem isso o
  // redeem seria o mesmo oráculo de código por outra porta. Um resgate
  // legítimo gasta 2 tentativas do teto de 10 — sobra folga.
  let rate;
  try {
    rate = await hitRateLimit(cfg, rawIp, nowMs);
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
      // Rótulo mascarado: a mensagem do erro é redigida na origem e não
      // carrega mais o código, então o rastro tem que vir daqui.
      console.error(`[redeem] code=${label} ${err.message}`);
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

  // Catálogo de tipo de entrega (Brief 6). Carregado depois do veredito do
  // voucher e ANTES do claim: falha de leitura vira 503 com o voucher
  // intacto, e quem varre códigos inválidos não ganha leitura extra de
  // banco por tentativa.
  let skuMap;
  try {
    skuMap = await loadSkuMap(cfg);
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error(`[redeem] sku map indisponível code=${label} ${err.message}`);
      return json(503, { error: "temporarily_unavailable" }, cors);
    }
    throw err;
  }

  // Espelha o fail-closed do /api/validate — e agora carrega junto a trava
  // SKU × delivery_type. Recusa ANTES do flip: um conteúdo mal cadastrado
  // não pode nem consumir o voucher, quanto mais virar order.
  //
  // Os três motivos daqui (unmapped_sku, unmapped_delivery_sku,
  // sku_delivery_mismatch) são SEMPRE erro nosso de cadastro, nunca do
  // portador — mas ele vê a mensagem genérica. Por isso o console.error
  // com o SKU: é o único jeito de o suporte distinguir "digitou errado"
  // de "nosso lote está furado" (lição do Brief 2 §8.3).
  const form = fieldsForContent(content, skuMap);
  if (!form.ok) {
    console.error(
      `[redeem] ${form.reason}: conteúdo recusado, sku=${content.product_code} ` +
        `content_id=${content.id} cadastrado=${content.delivery_type}` +
        (form.expected ? ` esperado=${form.expected}` : "")
    );
    logEvent({ evt: "redeem", result: "invalid_or_unavailable", code: label, cause: form.reason });
    return json(200, { status: "invalid_or_unavailable" }, cors);
  }

  const checked = validatePlayerData(form.fields, body.value.player_data);
  if (!checked.ok) {
    logEvent({ evt: "redeem", result: "invalid_payload", code: label });
    return json(400, { status: "invalid_payload", errors: checked.errors }, cors);
  }

  // Config da Lapak só é exigida aqui: se faltar env var, o erro aparece
  // ANTES do claim, com o voucher ainda intacto.
  let lapak;
  try {
    lapak = lapakConfig();
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      console.error(`[redeem] ${err.message}`);
      return json(500, { error: "server_misconfigured" }, cors);
    }
    throw err;
  }

  // -------------------------------------------------------------------
  // A PARTIR DAQUI O VOUCHER PODE MUDAR DE ESTADO.
  // -------------------------------------------------------------------

  let claim;
  try {
    claim = await claimVoucher(cfg, code);
  } catch (err) {
    console.error(`[redeem] claim failed code=${label}: ${err.message}`);
    return json(503, { error: "temporarily_unavailable" }, cors);
  }

  // Perdeu a corrida. A leitura de segundos atrás dizia EMITIDO, então o
  // cenário esperado é o duplo submit (duas abas): a outra request ganhou
  // e está resgatando. `processing` é a resposta honesta — e é a exceção
  // à mensagem genérica que o Brief 2 já abriu.
  if (!claim) {
    logEvent({ evt: "redeem", result: "claim_lost", code: label });
    return json(200, { status: "processing" }, cors);
  }

  const ref = attemptRef(code, claim.attemptNumber);
  const logBase = {
    evt: "redeem",
    code: label,
    content_id: content.id,
    delivery_type: content.delivery_type,
    attempt: claim.attemptNumber,
  };

  let attempt;
  try {
    attempt = await createAttempt(cfg, {
      voucherId: claim.voucherId,
      attemptNumber: claim.attemptNumber,
      code,
      productCode: content.product_code,
      clean: checked.clean,
      ipHash: ipHash(rawIp, cfg.salt),
    });
  } catch (err) {
    // Nenhuma order saiu: devolver o voucher é seguro e obrigatório.
    console.error(`[redeem] attempt insert failed code=${label}: ${err.message}`);
    await releaseVoucher(cfg, claim.voucherId).catch((e) =>
      console.error(`[redeem] release após falha de attempt: ${e.message}`)
    );
    return json(503, { error: "temporarily_unavailable" }, cors);
  }

  // Para QUAL ID a recarga foi pedida fica registrado no voucher antes de
  // qualquer coisa sair. Falhar aqui não impede o resgate — o create leva
  // o mesmo user_id de qualquer forma — mas some com a trilha, então loga.
  await recordPlayerData(cfg, claim.voucherId, deliveryData(checked.clean)).catch((err) =>
    console.error(`[redeem] player_data não gravado code=${label}: ${err.message}`)
  );

  // Boas-vindas (Brief 5). Fica ANTES do create e fora do caminho crítico:
  // é `await` só pra não deixar promessa solta num runtime que pode
  // congelar a function depois da resposta, mas o retorno é ignorado e a
  // função não lança — nem chave faltando, nem Resend fora do ar chegam
  // aqui como erro. Uma vez por voucher: quem envia é quem ganha o UPDATE
  // condicional lá dentro.
  //
  // RESSALVA CONHECIDA: se o create falhar logo abaixo, o voucher volta
  // pra EMITIDO e o portador já terá recebido "recebemos seu resgate".
  // É o que o brief pede (disparo no sucesso do claim) e o custo é um
  // email a mais; a alternativa — mandar só depois do create — deixaria
  // sem email justamente quem fecha a aba durante a espera.
  await sendWelcome(cfg, {
    voucherId: claim.voucherId,
    email: checked.clean.email,
    locale: verdict.batch.locale,
    siteHost: verdict.batch.site_host,
    label,
  });

  // ---------------- A ÚNICA CHAMADA QUE GASTA DINHEIRO ----------------
  // `fields` são só os NOMES dos campos preenchidos. Valor de email, CPF e
  // user_id não entra em log em nenhuma hipótese — nem o attempt_ref, que
  // carrega o código completo dentro dele. `requires_ip` é boolean: diz que
  // o IP foi enviado, nunca qual.
  logEvent({
    ...logBase,
    result: "order_create",
    fields: Object.keys(checked.clean),
    requires_ip: form.requiresIp,
  });

  let order;
  try {
    order = await createOrder(lapak, {
      productCode: content.product_code,
      userId: content.delivery_type === "PIN" ? null : checked.clean.user_id,
      // Só os SKUs marcados com requires_ip na pv_sku_delivery_map (caso
      // Hoyoverse) levam o IP cru. Usa e descarta: o valor morre no corpo
      // desta request. O que fica gravado é o ip_hash do attempt.
      endUserIp: form.requiresIp ? rawIp : null,
    });
  } catch (err) {
    if (!(err instanceof LapakError)) throw err;

    if (err.definitive) {
      // Temos prova de que nada foi criado: devolve o voucher pro portador.
      await failAttempt(cfg, attempt.id, err.code).catch(() => {});
      await releaseVoucher(cfg, claim.voucherId).catch((e) =>
        console.error(`[redeem] release após erro definitivo: ${e.message}`)
      );
      logEvent({ ...logBase, result: "failed", error_code: err.code });
      return json(200, { status: "failed", message: FAILED_MESSAGE }, cors);
    }

    // AMBÍGUO: a order pode existir e não temos tid pra conferir. O
    // voucher FICA em PROCESSING de propósito — liberar aqui seria
    // arriscar cobrar e entregar duas vezes. Vira caso humano.
    await markAttemptAmbiguous(cfg, attempt.id, err.code).catch(() => {});
    console.error(
      `[redeem] AMBIGUOUS create (${err.code}) code=${label} attempt=${claim.attemptNumber} ` +
        `sku=${content.product_code} — voucher fica em PROCESSING, conferir no painel da Lapak`
    );
    logEvent({ ...logBase, result: "ambiguous", error_code: err.code });
    return json(200, { status: "processing", attempt_ref: ref }, cors);
  }

  // A order existe. Daqui pra frente nenhum erro pode devolver o voucher.
  const cost = convertCost(order.totalPriceIdr, lapak);
  try {
    await recordOrder(cfg, attempt.id, { tid: order.tid, costIdr: order.totalPriceIdr, cost });
  } catch (err) {
    // O tid é o que liga a nossa trilha à order paga. Se não deu pra
    // gravar, ele vai pro log — não é dado pessoal nem segredo, e sem ele
    // a reconciliação fica cega.
    console.error(
      `[redeem] ORDER CRIADA MAS NÃO GRAVADA code=${label} tid=${order.tid} ` +
        `attempt=${claim.attemptNumber}: ${err.message}`
    );
  }

  logEvent({ ...logBase, result: "processing", tid: order.tid, cost_idr: order.totalPriceIdr });

  return json(200, { status: "processing", attempt_ref: ref }, cors);
};
