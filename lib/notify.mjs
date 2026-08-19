// Orquestração dos emails transacionais (Brief 5): decide, monta, manda,
// registra. É a única camada que junta template + mailer + banco.
//
// ============================ LEIA ANTES DE MEXER =====================
// NENHUMA função daqui lança. Todas engolem o próprio erro e devolvem um
// booleano. Isso é o que sustenta a regra do brief — falha de email nunca
// falha o resgate — mesmo se alguém esquecer o try/catch lá em cima.
//
// O PIN entra em sendPinEmail e morre nela: vai pro corpo do email e não
// aparece em log, em retorno, nem em mensagem de erro.
// ======================================================================

import { logEvent } from "./http.mjs";
import { sendEmail, recipientDomain, mailerEnabled } from "./mailer.mjs";
import { welcomeEmail, pinEmail } from "./email-templates.mjs";
import { claimWelcomeEmail, markPinEmailSent } from "./redeem.mjs";

/**
 * Email 1 — boas-vindas. Uma vez por voucher, garantido pelo UPDATE
 * condicional (`welcome_email_at IS NULL`): dois submits simultâneos
 * disputam a linha e só um ganha o direito de enviar.
 *
 * A ordem é "marca, depois manda". O inverso — mandar e depois marcar —
 * abriria a janela pra dois emails se a marcação falhasse. Trocado assim,
 * o pior caso é NÃO mandar um email de boas-vindas, que é o lado barato
 * de errar.
 *
 * Devolve true se o email saiu.
 */
export async function sendWelcome(cfg, { voucherId, email, locale, label }) {
  if (!email || !mailerEnabled()) return false;

  let won = false;
  try {
    won = await claimWelcomeEmail(cfg, voucherId);
  } catch {
    // Não conseguimos nem reivindicar: desiste em silêncio. Reivindicar de
    // novo depois pode duplicar, e duplicar boas-vindas é pior que faltar.
    return false;
  }
  if (!won) return false;

  const { subject, html, text } = welcomeEmail({ locale });
  const result = await sendEmail({ to: email, subject, html, text });

  logEvent({
    evt: "email",
    kind: "welcome",
    code: label,
    result: result.ok ? "sent" : "email_send_failed",
    ...(result.ok ? {} : { error: result.error, domain: recipientDomain(email) }),
  });

  return result.ok;
}

/**
 * Email 2 — entrega do PIN. Só fluxo PIN, só com resgate concluído.
 *
 * Aqui a ordem é a INVERSA da anterior: manda primeiro, marca depois. O
 * `pin_email_due` só é baixado quando o envio confirma, e é isso que faz
 * a reconciliação reencontrar a pendência no próximo tick. Marcar antes
 * transformaria uma falha de rede em PIN que nunca chega.
 *
 * Duplicar aqui é aceitável e barato — o portador recebe o mesmo código
 * duas vezes. Não duplica cobrança: nada nesta função fala com a Lapak.
 */
export async function sendPinEmail(cfg, { attemptId, email, locale, pin, serial, productLabel, label }) {
  if (!email || !pin || !mailerEnabled()) return false;

  const { subject, html, text } = pinEmail({ locale, pin, serial, productLabel });
  const result = await sendEmail({ to: email, subject, html, text });

  if (result.ok) {
    // Falhar aqui não é grave: o email já saiu, e a pior consequência é a
    // reconciliação reenviar uma vez.
    await markPinEmailSent(cfg, attemptId).catch(() => {});
  }

  logEvent({
    evt: "email",
    kind: "pin",
    code: label,
    result: result.ok ? "sent" : "email_send_failed",
    ...(result.ok ? {} : { error: result.error, domain: recipientDomain(email) }),
  });

  return result.ok;
}
