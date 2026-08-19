// Envio de email transacional via Resend (Brief 5).
//
// ============================ LEIA ANTES DE MEXER =====================
// REGRA INEGOCIÁVEL: falha de email NUNCA falha o resgate.
//
// Nenhuma função exportada daqui lança. Todas devolvem
// { ok: true } | { ok: false, error: "<código curto>" }, e quem chama
// ignora o resultado sem try/catch se quiser. Não existe caminho em que
// a Resend fora do ar, a env var faltando ou um timeout façam um voucher
// deixar de ser resgatado — o portador já pagou; o email é cortesia.
//
// SEGREDO: a RESEND_API_KEY vive SÓ em env var do Netlify. Ela não
// aparece em código, em log, em mensagem de erro nem em teste. O nome da
// variável aparece; o valor, nunca.
//
// PII E PIN: este módulo recebe as duas coisas mais sensíveis do sistema
// — o endereço do portador e, no email 2, o PIN em claro. Por isso:
//   - nenhum console.* aqui imprime `to`, `html` ou `text`;
//   - o corpo da RESPOSTA da Resend também não é logado: em erro de
//     validação ela ecoa o destinatário de volta;
//   - o diagnóstico que sobra é status HTTP + o DOMÍNIO do destinatário
//     (que não identifica ninguém) — o suficiente pra distinguir "chave
//     errada" de "domínio do portador recusando".
// ======================================================================

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Curto de propósito. Este envio acontece DENTRO do request do portador
// (boas-vindas) ou dentro do job de reconciliação: em nenhum dos dois
// vale a pena segurar a linha esperando um provedor lento. Estourou,
// vira pendência e a reconciliação tenta de novo.
const SEND_TIMEOUT_MS = 5000;

/** Remetente. Decisão do Brief 5: caixa não monitorada, nos dois idiomas. */
export const FROM_ADDRESS = "Recarga Games <no-reply@recargagames.com>";

/**
 * true quando o envio está configurado. Ausência de chave NÃO é erro:
 * é o estado normal em teste e em qualquer deploy que não deva mandar
 * email. O resgate segue igual.
 */
export function mailerEnabled() {
  return !!String(process.env.RESEND_API_KEY || "").trim();
}

/**
 * Só o domínio do destinatário, pra log. `jogador@gmail.com` → `gmail.com`.
 *
 * Endereço completo é dado pessoal e não vai pra log em hipótese alguma
 * (mesma regra do email nas colunas do attempt). O domínio sozinho não
 * identifica ninguém e é o que responde a pergunta que o suporte faz de
 * verdade: "está falhando só num provedor?".
 */
export function recipientDomain(to) {
  const at = String(to ?? "").lastIndexOf("@");
  return at > 0 ? String(to).slice(at + 1).toLowerCase() : "desconhecido";
}

/**
 * Manda um email. NUNCA lança.
 *
 * Devolve { ok: true, id } ou { ok: false, error }, onde `error` é um
 * código curto e sem dado nenhum dentro: `not_configured`, `no_recipient`,
 * `timeout`, `unreachable`, `http_401`, `http_422`…
 */
export async function sendEmail({ to, subject, html, text }) {
  const key = String(process.env.RESEND_API_KEY || "").trim();
  if (!key) return { ok: false, error: "not_configured" };
  if (!to || !String(to).includes("@")) return { ok: false, error: "no_recipient" };

  let res;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [String(to)], subject, html, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    // Diferente do create da Lapak, aqui "ambíguo" não custa dinheiro: um
    // email duplicado é um aborrecimento, não uma cobrança. Por isso o
    // timeout pode ser tratado como falha simples e reenviado depois.
    return { ok: false, error: err?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }

  if (!res.ok) {
    // O corpo da resposta NÃO é lido: em 422 a Resend devolve o
    // destinatário na mensagem de erro, e isso não pode chegar em log.
    return { ok: false, error: `http_${res.status}` };
  }

  let id = null;
  try {
    const payload = await res.json();
    id = payload && payload.id ? String(payload.id) : null;
  } catch {
    // Sucesso sem corpo parseável: o envio saiu, só ficamos sem o id.
    id = null;
  }

  return { ok: true, id };
}
