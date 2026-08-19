/* =====================================================================
   i18n do app de resgate — Brief 7 (campanha Plusmo, es-MX).

   Vanilla JS, sem build, sem framework. Carregado ANTES do app.js e
   exposto em window.RG_I18N — arquivo separado pela mesma razão do
   app.js: a CSP é script-src 'self', sem 'unsafe-inline'.

   ============================ O QUE VIVE AQUI =========================
   SÓ as strings da CASCA: títulos, botões, mensagens de erro e estado.

   Os textos dos CAMPOS do formulário (label, placeholder, help) e a
   linha de finalidade NÃO estão aqui — eles vêm do servidor, já no
   idioma certo, porque o formulário é dirigido pelo servidor desde o
   Brief 2 e assim continua. Duplicá-los aqui criaria uma segunda fonte
   de verdade que sairia de sincronia no primeiro campo novo.

   É também o que faz o CPF sumir em es-MX por CONSTRUÇÃO: o servidor
   não envia o campo, então não há o que renderizar nem o que mandar de
   volta. Não existe filtro de CPF neste arquivo, e não deve existir.
   ======================================================================

   O locale sai do HOSTNAME (ver app.js). pt-BR é o default e é o que
   está escrito no index.html — se este arquivo falhar em carregar, o
   site brasileiro continua inteiro e correto.
   ===================================================================== */

(() => {
  "use strict";

  const DICT = {
    "pt-BR": null, // o pt-BR é o que já está no HTML. Nada a reescrever.

    "es-MX": {
      /* ---- documento ---- */
      "html.lang": "es-MX",
      "doc.title": "Canjea tu Voucher de Socio — Recarga Games",
      "doc.description": "Canjea tu Voucher de Socio Recarga Games.",

      /* ---- casca ---- */
      "brand.product": "Voucher de Socio",
      "steps.aria": "Progreso del canje",
      "step.code": "Código",
      "step.contents": "Contenido",
      "step.form": "Confirmación",
      "foot.text": "Recarga Games · Voucher de Socio — un solo canje por código.",

      /* ---- tela 1: código ---- */
      "code.eyebrow": "Voucher de Socio",
      "code.title.before": "Canjea tu ",
      "code.title.grad": "premio",
      "code.lede": "Escribe el código de tu voucher para ver qué puedes canjear.",
      "code.label": "Código del voucher",
      "code.help": "Tal como aparece en tu voucher, con o sin el guion.",
      "code.submit": "Validar código",
      "code.submit.busy": "Validando…",
      "code.incomplete": "Escribe el código completo del voucher.",

      /* ---- tela 2: conteúdos ---- */
      "contents.validUntil": "Válido hasta",
      "contents.title.before": "Elige tu ",
      "contents.title.grad": "contenido",
      "contents.lede.before": "Puedes canjear ",
      "contents.lede.bold": "un",
      "contents.lede.after": " artículo de este voucher. La elección es definitiva.",
      "contents.aria": "Contenidos disponibles",
      "contents.continue": "Continuar",
      "contents.back": "← Usar otro código",
      "badge.pin": "Código PIN",
      "badge.dtu": "Entrega en tu ID",

      /* ---- tela 3: formulário ---- */
      "form.title.before": "Confirma tus ",
      "form.title.grad": "datos",
      "form.pinInfo.before": "Este contenido se entrega como ",
      "form.pinInfo.bold": "código PIN",
      "form.pinInfo.after": ". El código aparece en pantalla al terminar el canje.",
      "form.submit": "Confirmar canje",
      "form.submit.busy": "Enviando…",
      "form.back": "← Elegir otro contenido",

      /* aviso do fluxo DTU (Check ID OFF na Lapak) */
      "dtu.title": "⚠ Entrega directa y definitiva",
      "dtu.item1.before": "La recarga se entrega ",
      "dtu.item1.bold": "directamente en el ID que indiques",
      "dtu.item1.after": ", sin etapa de verificación.",
      "dtu.item2.bold": "Revisa el ID antes de confirmar",
      "dtu.item2.after": " — la verificación es tu responsabilidad.",
      "dtu.item3.before": "Después de la entrega ",
      "dtu.item3.bold": "no hay reembolso, cambio ni reversión",
      "dtu.item3.after": ", aunque el ID esté equivocado.",
      "dtu.confirm": "Confirmo que los datos son correctos y entiendo que la entrega es definitiva.",
      "dtu.confirmRequired": "Marca la confirmación de que los datos son correctos antes de continuar.",

      /* ---- validação de campo (espelha lib/forms.mjs) ---- */
      "field.required": "Completa este campo.",
      "field.checkRequired": "Debes marcar esta opción.",
      "field.email": "Escribe un correo válido.",
      "field.numeric": "Usa solo números.",

      /* ---- tela 4: entrega em andamento ---- */
      "processing.title.before": "Entregando tu ",
      "processing.title.grad": "premio",
      "processing.lede": "Estamos procesando tu canje con el proveedor. Suele tardar unos segundos.",
      "processing.warn.bold": "No cierres esta pantalla.",
      "processing.warn.after":
        " Tu voucher ya está reservado — el resultado aparece aquí en cuanto el proveedor confirme.",

      /* ---- tela 5: resultado ---- */
      "pin.label": "Tu código PIN",
      "pin.copy": "Copiar",
      "pin.copied": "Código copiado.",
      "pin.copyManual": "Selecciona y copia el código de arriba.",
      "pin.warn.bold": "Anótalo ahora.",
      "pin.warn.after":
        " Canjea este código en el juego — estará disponible en esta pantalla por 24 horas.",
      "result.retryContent": "Elegir otro contenido",
      "result.restart": "Volver al inicio",

      "result.success.title": "Canje completado",
      "result.success.dtu": "¡Listo! El contenido se entregó directo en la cuenta del ID que indicaste.",
      "result.success.pin": "Tu código PIN está aquí abajo. Úsalo en el juego para recibir el contenido.",
      "result.success.plain": "El canje se completó.",
      "result.success.dtuDetail":
        "La entrega puede tardar unos minutos en aparecer en el juego. Si no aparece, contacta a soporte con este voucher a la mano.",

      "result.failed.title": "No se pudo completar",
      "result.slow.title": "Aún procesando",
      "result.slow.message":
        "El proveedor está tardando más de lo normal. Tu canje sigue en curso — no necesitas hacer nada.",
      "result.slow.detail":
        "Consulta tu código más tarde en esta misma pantalla para ver el resultado. No intentes canjear de nuevo ahora.",
      "result.maintenance.title": "Canje en mantenimiento",
      "result.maintenance.message": "El canje está en mantenimiento en este momento. Inténtalo más tarde.",
      "result.maintenance.detail":
        "Tu código NO fue usado y sigue siendo válido. No se entregó ni se cobró nada.",
      "result.inProgress.title": "Canje en curso",
      "result.unavailable.title": "Código no disponible",

      /* ---- alertas ---- */
      "alert.info": "Atención: ",
      "alert.error": "No fue posible: ",
      "msg.invalid":
        "Código inválido o no disponible. Revisa si lo escribiste bien — si está correcto, puede que ya se haya usado, cancelado o vencido.",
      "msg.processing":
        "Este voucher ya tiene un canje en curso. Espera unos minutos e inténtalo de nuevo.",
      "msg.rateLimited.before": "Demasiados intentos en poco tiempo. Por seguridad, espera ",
      "msg.rateLimited.after": " e inténtalo de nuevo.",
      "msg.network": "No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.",
      "msg.server": "Tuvimos un problema por aquí. Inténtalo de nuevo en unos instantes.",

      /* ---- tempo ---- */
      "time.minute": "1 minuto",
      "time.minutes.before": "",
      "time.minutes.after": " minutos",
      "time.seconds.before": "",
      "time.seconds.after": " segundos",
    },
  };

  /**
   * Hostnames que servem cada idioma. Qualquer outro cai no default —
   * inclusive reload.recargagames.com, que É o default e por isso não
   * precisa estar aqui.
   */
  const HOST_LOCALE = {
    "plusmo.recargagames.com": "es-MX",
  };

  const DEFAULT_LOCALE = "pt-BR";
  const SUPPORTED = ["pt-BR", "es-MX"];

  /**
   * Hostnames onde o override por query param (`?locale=es-MX`) é aceito.
   *
   * Existe pra revisar o fluxo es-MX inteiro num Deploy Preview antes de
   * o DNS da Plusmo existir. NUNCA vale em produção: lá o idioma é uma
   * propriedade do domínio, e um link `?locale=` circulando geraria
   * suporte com prints de uma tela que ninguém consegue reproduzir.
   */
  function overrideAllowed(hostname) {
    return (
      hostname.endsWith(".netlify.app") ||
      hostname === "localhost" ||
      hostname === "127.0.0.1"
    );
  }

  function detectLocale(location) {
    const hostname = String(location.hostname || "").toLowerCase();

    if (overrideAllowed(hostname)) {
      const asked = new URLSearchParams(location.search).get("locale");
      if (asked && SUPPORTED.includes(asked)) return asked;
    }

    return HOST_LOCALE[hostname] || DEFAULT_LOCALE;
  }

  const locale = detectLocale(window.location);
  const dict = DICT[locale] || null;

  window.RG_I18N = {
    locale,
    /** Traduz. Sem dicionário (pt-BR) devolve o fallback do HTML. */
    t(key, fallback) {
      if (!dict) return fallback;
      const value = dict[key];
      return value === undefined ? fallback : value;
    },
    has: () => !!dict,
    // Exportado só pros testes; o app usa `locale` acima.
    _detect: detectLocale,
    _dict: DICT,
    _hosts: HOST_LOCALE,
  };
})();
