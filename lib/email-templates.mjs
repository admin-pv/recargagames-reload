// Templates dos emails transacionais (Brief 5). Funções PURAS: recebem
// dados, devolvem { subject, html, text }. Nenhuma delas fala com rede,
// banco ou env — é o que permite testá-las sem stub nenhum.
//
// ============================ LEIA ANTES DE MEXER =====================
// O template do PIN recebe o PIN em claro. Ele monta a string e devolve;
// NADA aqui loga, e quem chama (lib/mailer.mjs) também não pode logar o
// corpo. O PIN passa por este módulo em memória, igual ao que já
// acontece em lapak.mjs — mesma regra, mesma disciplina.
// ======================================================================
//
// HTML deliberadamente simples: tabela, estilo inline, zero imagem
// externa, zero fonte remota, zero JS. Cliente de email não é browser —
// Outlook ignora <style>, Gmail corta CSS, e imagem remota nasce
// bloqueada na maioria dos clientes. O logo é TEXTO por isso: uma marca
// que só aparece depois de "exibir imagens" não é uma marca.
//
// Todo email tem versão text/plain de verdade (não é o HTML com as tags
// arrancadas). É o que o cliente mostra quando o HTML falha, e é o que
// mais pesa contra o filtro de spam.

import { resolveLocale } from "./locale.mjs";

/** Paleta da marca. Fundo escuro navy, acento ciano → roxo. */
const BRAND = {
  bg: "#0B1020",
  card: "#141B33",
  text: "#E8ECF8",
  muted: "#9AA6C8",
  cyan: "#22D3EE",
  purple: "#A855F7",
  border: "#26304F",
};

/**
 * Hostname usado nos LINKS quando o lote não diz outro. O branding VISUAL
 * é Recarga Games para todos; o que muda por parceiro é para onde o
 * portador é levado.
 */
export const DEFAULT_SITE_HOST = "reload.recargagames.com";

// Hostname e nada mais: sem esquema, sem barra, sem porta, sem aspas.
// A migration já barra isso no INSERT; aqui é a segunda camada, porque
// este valor vira `href` — e um valor com aspas escaparia do atributo.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Normaliza o hostname do parceiro. Qualquer coisa que não seja hostname
 * limpo vira o default: um link para o site errado é ruim, mas um link
 * para o site de outra pessoa dentro de um email assinado com o nosso
 * DKIM é phishing com a nossa cara.
 */
export function resolveSiteHost(siteHost) {
  const value = String(siteHost ?? "").trim().toLowerCase();
  return HOSTNAME_RE.test(value) && value.length <= 253 ? value : DEFAULT_SITE_HOST;
}

// A lista de idiomas vive em lib/locale.mjs, e não aqui: o formulário, os
// emails e as functions precisam concordar sobre quais existem, e três
// cópias divergiriam no primeiro idioma novo. Reexportado porque os
// testes e os templates deste arquivo já consumiam estes nomes.
export { SUPPORTED_LOCALES, DEFAULT_LOCALE, resolveLocale } from "./locale.mjs";

const COPY = {
  "pt-BR": {
    tagline: "RECARGA. JOGUE MAIS.",
    welcomeSubject: "Recebemos seu resgate — Recarga Games",
    welcomeTitle: "Resgate recebido!",
    welcomeLead: "Tudo certo: estamos processando seu resgate agora.",
    welcomeBody:
      "Assim que a entrega for concluída, você recebe a confirmação neste mesmo email. " +
      "Costuma levar poucos minutos.",
    welcomeTip: "Pode fechar a página — não é preciso ficar esperando com ela aberta.",
    pinSubject: "Seu código chegou — Recarga Games",
    pinTitle: "Aqui está o seu código",
    pinLead: "Seu resgate foi concluído. Use o código abaixo para ativar:",
    pinLabel: "CÓDIGO",
    serialLabel: "SERIAL",
    pinWarning:
      "Guarde este email. Por segurança, não armazenamos este código — " +
      "ele fica disponível na tela do resgate por 24 horas.",
    pinNoShare: "Não compartilhe este código com ninguém.",
    footerHelp: "Precisa de ajuda? Este email não recebe respostas — fale com o suporte pelo site:",
    footerLegal: "Este é um email automático sobre um resgate que você iniciou.",
  },
  "es-MX": {
    tagline: "RECARGA. JUEGA MÁS.",
    welcomeSubject: "Recibimos tu canje — Recarga Games",
    welcomeTitle: "¡Canje recibido!",
    welcomeLead: "Todo listo: estamos procesando tu canje.",
    welcomeBody:
      "En cuanto se complete la entrega, recibirás la confirmación en este mismo correo. " +
      "Suele tardar pocos minutos.",
    welcomeTip: "Puedes cerrar la página — no necesitas esperar con ella abierta.",
    pinSubject: "Tu código llegó — Recarga Games",
    pinTitle: "Aquí está tu código",
    pinLead: "Tu canje se completó. Usa el código de abajo para activarlo:",
    pinLabel: "CÓDIGO",
    serialLabel: "SERIAL",
    pinWarning:
      "Guarda este correo. Por seguridad no almacenamos este código — " +
      "estará disponible en la pantalla del canje por 24 horas.",
    pinNoShare: "No compartas este código con nadie.",
    footerHelp: "¿Necesitas ayuda? Este correo no recibe respuestas — contacta a soporte en el sitio:",
    footerLegal: "Este es un correo automático sobre un canje que iniciaste.",
  },
};

/** Escapa o que vai pro HTML. Nome de produto vem do fornecedor. */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Cabeçalho da marca: logo em texto + tagline do idioma. */
function header(copy) {
  return `
    <tr>
      <td style="padding:32px 32px 8px 32px;text-align:center;">
        <div style="font:700 22px/1.2 Helvetica,Arial,sans-serif;letter-spacing:3px;color:${BRAND.text};">
          RECARGA <span style="color:${BRAND.cyan};">GAMES</span>
        </div>
        <div style="margin-top:6px;font:600 11px/1.4 Helvetica,Arial,sans-serif;letter-spacing:2px;color:${BRAND.purple};">
          ${esc(copy.tagline)}
        </div>
        <div style="margin-top:18px;height:2px;background:linear-gradient(90deg,${BRAND.cyan},${BRAND.purple});"></div>
      </td>
    </tr>`;
}

function footer(copy, host) {
  return `
    <tr>
      <td style="padding:8px 32px 32px 32px;border-top:1px solid ${BRAND.border};">
        <p style="margin:16px 0 4px 0;font:400 12px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.muted};">
          ${esc(copy.footerHelp)}
        </p>
        <p style="margin:0 0 4px 0;font:400 12px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.muted};">
          <a href="https://${esc(host)}" style="color:${BRAND.cyan};text-decoration:none;">${esc(host)}</a>
        </p>
        <p style="margin:0;font:400 11px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.muted};">
          ${esc(copy.footerLegal)}
        </p>
      </td>
    </tr>`;
}

/** Esqueleto compartilhado. `inner` são as <tr> do miolo. */
function shell(locale, copy, host, inner) {
  return `<!doctype html>
<html lang="${locale === "es-MX" ? "es-MX" : "pt-BR"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:12px;">
        ${header(copy)}
        ${inner}
        ${footer(copy, host)}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Email 1 — boas-vindas. Disparado quando o resgate coleta o email.
 * Não carrega código nenhum: só confirma que o resgate está em curso e
 * tira o portador da tela.
 */
export function welcomeEmail({ locale, siteHost } = {}) {
  const lang = resolveLocale(locale);
  const copy = COPY[lang];
  const host = resolveSiteHost(siteHost);

  const inner = `
    <tr>
      <td style="padding:24px 32px 8px 32px;">
        <h1 style="margin:0 0 12px 0;font:700 20px/1.3 Helvetica,Arial,sans-serif;color:${BRAND.text};">
          ${esc(copy.welcomeTitle)}
        </h1>
        <p style="margin:0 0 12px 0;font:400 15px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.text};">
          ${esc(copy.welcomeLead)}
        </p>
        <p style="margin:0 0 12px 0;font:400 14px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.muted};">
          ${esc(copy.welcomeBody)}
        </p>
        <p style="margin:0 0 8px 0;font:400 14px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.muted};">
          ${esc(copy.welcomeTip)}
        </p>
      </td>
    </tr>`;

  const text = [
    "RECARGA GAMES",
    copy.tagline,
    "",
    copy.welcomeTitle,
    "",
    copy.welcomeLead,
    copy.welcomeBody,
    copy.welcomeTip,
    "",
    copy.footerHelp,
    `https://${host}`,
    copy.footerLegal,
  ].join("\n");

  return { subject: copy.welcomeSubject, html: shell(lang, copy, host, inner), text };
}

/**
 * Email 2 — entrega do PIN. Só fluxo PIN, só com result=success.
 *
 * ATENÇÃO: `pin` é o código em claro. Este é o ÚNICO lugar do sistema
 * onde ele é escrito em algo que persiste fora da nossa memória — a
 * caixa do portador. Quem chama não pode logar o retorno desta função.
 */
export function pinEmail({ locale, pin, serial, productLabel, siteHost } = {}) {
  const lang = resolveLocale(locale);
  const copy = COPY[lang];
  const host = resolveSiteHost(siteHost);

  const serialBlock = serial
    ? `
        <div style="margin-top:12px;font:400 12px/1.4 Helvetica,Arial,sans-serif;color:${BRAND.muted};">
          ${esc(copy.serialLabel)}
        </div>
        <div style="font:600 14px/1.4 'Courier New',Courier,monospace;color:${BRAND.text};">
          ${esc(serial)}
        </div>`
    : "";

  const productBlock = productLabel
    ? `<p style="margin:0 0 12px 0;font:400 14px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.muted};">
         ${esc(productLabel)}
       </p>`
    : "";

  const inner = `
    <tr>
      <td style="padding:24px 32px 8px 32px;">
        <h1 style="margin:0 0 12px 0;font:700 20px/1.3 Helvetica,Arial,sans-serif;color:${BRAND.text};">
          ${esc(copy.pinTitle)}
        </h1>
        ${productBlock}
        <p style="margin:0 0 16px 0;font:400 15px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.text};">
          ${esc(copy.pinLead)}
        </p>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="background:${BRAND.bg};border:1px solid ${BRAND.cyan};border-radius:10px;">
          <tr><td style="padding:18px 20px;text-align:center;">
            <div style="font:400 12px/1.4 Helvetica,Arial,sans-serif;letter-spacing:2px;color:${BRAND.cyan};">
              ${esc(copy.pinLabel)}
            </div>
            <div style="margin-top:6px;font:700 24px/1.3 'Courier New',Courier,monospace;letter-spacing:2px;color:${BRAND.text};word-break:break-all;">
              ${esc(pin)}
            </div>
            ${serialBlock}
          </td></tr>
        </table>

        <p style="margin:16px 0 4px 0;font:600 13px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.purple};">
          ${esc(copy.pinNoShare)}
        </p>
        <p style="margin:0 0 8px 0;font:400 13px/1.6 Helvetica,Arial,sans-serif;color:${BRAND.muted};">
          ${esc(copy.pinWarning)}
        </p>
      </td>
    </tr>`;

  const text = [
    "RECARGA GAMES",
    copy.tagline,
    "",
    copy.pinTitle,
    ...(productLabel ? [String(productLabel)] : []),
    "",
    copy.pinLead,
    "",
    `${copy.pinLabel}: ${pin}`,
    ...(serial ? [`${copy.serialLabel}: ${serial}`] : []),
    "",
    copy.pinNoShare,
    copy.pinWarning,
    "",
    copy.footerHelp,
    `https://${host}`,
    copy.footerLegal,
  ].join("\n");

  return { subject: copy.pinSubject, html: shell(lang, copy, host, inner), text };
}
