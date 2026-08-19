/* =====================================================================
   App de Resgate — Voucher de Parceiro
   Vanilla JS, sem build, sem dependência. Arquivo separado (não inline)
   pra que a CSP possa ser script-src 'self', sem 'unsafe-inline'.

   Regras que valem pra este arquivo:
   - O código do voucher vive SÓ em memória. Nunca vai pra URL, nunca vai
     pra localStorage/sessionStorage — link compartilhado ou histórico do
     navegador não pode carregar voucher.
   - O attempt_ref carrega o código dentro dele (<code>-a<n>): vale a mesma
     regra, memória e nada mais.
   - O PIN vive na tela e no clipboard, se o usuário copiar. Não é salvo
     em lugar nenhum — nem aqui, nem no nosso banco.
   - Nada de innerHTML com dado vindo do servidor: sempre textContent.
   - Validação daqui é conveniência de UX. A que conta é a da function.
   - NUNCA reenviar /api/redeem automaticamente. O create da Lapak não tem
     idempotência: um segundo envio é uma segunda cobrança.
   - i18n (Brief 7): as strings da CASCA vêm do i18n.js, por chave. As dos
     CAMPOS do formulário vêm do SERVIDOR, já traduzidas — não há, e não
     deve haver, dicionário de campo aqui. É por isso que o CPF some em
     es-MX sem nenhum `if` neste arquivo: o servidor não manda o campo.
   ===================================================================== */

(() => {
  "use strict";

  /* ------------------------------ i18n ------------------------------ */

  // Se o i18n.js não carregar, `t()` devolve o fallback e o app segue em
  // pt-BR — que é exatamente o texto já escrito no index.html.
  const I18N = window.RG_I18N || { locale: "pt-BR", t: (_k, fallback) => fallback, has: () => false };
  const LOCALE = I18N.locale;
  const t = (key, fallback) => I18N.t(key, fallback);

  /**
   * Reescreve o HTML estático quando o locale não é o padrão.
   *
   * Só roda se houver dicionário: em pt-BR nada é tocado, e é isso que
   * garante que reload.recargagames.com renderize byte a byte igual.
   */
  function applyStaticI18n() {
    if (!I18N.has()) return;

    document.documentElement.lang = t("html.lang", document.documentElement.lang);
    document.title = t("doc.title", document.title);
    const description = document.querySelector('meta[name="description"]');
    if (description) description.content = t("doc.description", description.content);

    for (const node of document.querySelectorAll("[data-i18n]")) {
      node.textContent = t(node.dataset.i18n, node.textContent);
    }
    for (const node of document.querySelectorAll("[data-i18n-aria-label]")) {
      node.setAttribute(
        "aria-label",
        t(node.dataset.i18nAriaLabel, node.getAttribute("aria-label"))
      );
    }
  }

  const SCREENS = ["code", "contents", "form", "processing", "result"];
  const STEP_OF_SCREEN = {
    code: "code",
    contents: "contents",
    form: "form",
    processing: null,
    result: null,
  };

  // Polling do desfecho: de 3 em 3 segundos, por até 5 minutos de tela.
  // Depois disso a reconciliação do servidor assume — o resgate não
  // depende desta aba ficar aberta.
  const POLL_INTERVAL_MS = 3000;
  const POLL_BACKOFF_MS = 15000; // quando o servidor pede calma (429)
  const POLL_MAX_MS = 5 * 60 * 1000;

  // Os textos em português são o fallback: se o dicionário não tiver a
  // chave, é isto que aparece. Nenhuma mensagem pode sumir por falta de
  // tradução — a uniformidade da recusa é regra inegociável do repo.
  const MSG = {
    get invalid() {
      return t(
        "msg.invalid",
        "Código inválido ou indisponível. Confira se digitou certo — se estiver certo, ele pode já ter sido usado, cancelado ou vencido."
      );
    },
    get processing() {
      return t(
        "msg.processing",
        "Este voucher já tem um resgate em andamento. Aguarde alguns minutos e tente novamente."
      );
    },
    rateLimited: (min) =>
      t("msg.rateLimited.before", "Muitas tentativas em pouco tempo. Por segurança, espere ") +
      min +
      t("msg.rateLimited.after", " e tente de novo."),
    get network() {
      return t(
        "msg.network",
        "Não conseguimos falar com o servidor. Verifique sua conexão e tente novamente."
      );
    },
    get server() {
      return t("msg.server", "Tivemos um problema por aqui. Tente novamente em alguns instantes.");
    },
  };

  // Estado da sessão de resgate — memória, só isso.
  const state = {
    code: null,
    batchName: null,
    expiresAt: null,
    purposeNote: null,
    contents: [],
    selectedId: null,
    busy: false,
    attemptRef: null,
    pollTimer: null,
    pollUntil: 0,
  };

  // Espelhos da validação do servidor (lib/forms.mjs). Se mudar lá, mudar aqui.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

  function isValidCpf(digits) {
    if (!/^\d{11}$/.test(digits)) return false;
    if (/^(\d)\1{10}$/.test(digits)) return false;
    const checkDigit = (length) => {
      let sum = 0;
      for (let i = 0; i < length; i++) sum += Number(digits[i]) * (length + 1 - i);
      const rest = (sum * 10) % 11;
      return rest === 10 ? 0 : rest;
    };
    return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10]);
  }

  function maskCpf(value) {
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
    if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }

  const el = (id) => document.getElementById(id);

  const refs = {
    steps: el("steps"),
    formCode: el("form-code"),
    code: el("code"),
    codeError: el("code-error"),
    alertCode: el("alert-code"),
    btnValidate: el("btn-validate"),
    batchName: el("batch-name"),
    batchExpires: el("batch-expires"),
    contentsList: el("contents-list"),
    btnContinue: el("btn-continue"),
    formRedeem: el("form-redeem"),
    fields: el("fields"),
    fieldsConsent: el("fields-consent"),
    purposeNote: el("purpose-note"),
    summaryTitle: el("summary-title"),
    summaryBadge: el("summary-badge"),
    summaryIcon: el("summary-icon"),
    dtuNotice: el("dtu-notice"),
    dtuConfirmWrap: el("dtu-confirm-wrap"),
    dtuConfirm: el("dtu-confirm"),
    pinInfo: el("pin-info"),
    btnRedeem: el("btn-redeem"),
    alertForm: el("alert-form"),
    processingMessage: el("processing-message"),
    resultIcon: el("result-icon"),
    resultTitle: el("title-result"),
    resultMessage: el("result-message"),
    resultDetail: el("result-detail"),
    resultDetailText: el("result-detail-text"),
    resultPin: el("result-pin"),
    pinValue: el("pin-value"),
    pinSerial: el("pin-serial"),
    pinCopied: el("pin-copied"),
    btnCopyPin: el("btn-copy-pin"),
    btnRetryContent: el("btn-retry-content"),
    btnRestart: el("btn-restart"),
  };

  /* ---------------------- navegação entre telas ---------------------- */

  function showScreen(name) {
    for (const s of SCREENS) el(`screen-${s}`).hidden = s !== name;

    const order = ["code", "contents", "form"];
    const currentStep = STEP_OF_SCREEN[name];
    for (const li of refs.steps.children) {
      const step = li.dataset.step;
      if (!currentStep) li.dataset.state = "done";
      else if (step === currentStep) li.dataset.state = "current";
      else li.dataset.state = order.indexOf(step) < order.indexOf(currentStep) ? "done" : "todo";
    }

    window.scrollTo({ top: 0, behavior: "auto" });
    const heading = el(`screen-${name}`).querySelector("h1, h2");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }

  /* --------------------------- helpers de UI ------------------------- */

  function showAlert(node, text, tone) {
    node.textContent = "";
    const strong = document.createElement("b");
    strong.textContent =
      tone === "info" ? t("alert.info", "Atenção: ") : t("alert.error", "Não foi possível: ");
    node.append(strong, document.createTextNode(text));
    node.classList.toggle("alert-info", tone === "info");
    node.dataset.show = "true";
  }

  function hideAlert(node) {
    node.dataset.show = "false";
    node.textContent = "";
  }

  function setBusy(button, busy, labelWhenBusy) {
    state.busy = busy;
    button.disabled = busy;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = "";
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      button.append(spinner, document.createTextNode(labelWhenBusy));
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  }

  function humanMinutes(seconds) {
    const min = Math.max(1, Math.ceil((Number(seconds) || 600) / 60));
    if (min === 1) return t("time.minute", "1 minuto");
    return t("time.minutes.before", "") + min + t("time.minutes.after", " minutos");
  }

  function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(LOCALE, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(date);
  }

  /* ------------------------------ API ------------------------------- */

  async function api(path, payload) {
    let res;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      return { kind: "network" };
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.status === 429) {
      return { kind: "rate_limited", retryAfter: data && data.retry_after_seconds };
    }
    // 400 carrega erros de campo úteis; o resto de 4xx/5xx é falha nossa.
    if (!res.ok && res.status !== 400) return { kind: "server", status: res.status };
    return { kind: "ok", status: res.status, data: data || {} };
  }

  /* ------------------------ TELA 1 — código ------------------------- */

  // Deixa o campo sempre no formato do voucher: maiúsculas, sem espaço.
  refs.code.addEventListener("input", () => {
    const cleaned = refs.code.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (cleaned !== refs.code.value) {
      const pos = refs.code.selectionStart;
      refs.code.value = cleaned;
      refs.code.setSelectionRange(pos, pos);
    }
    refs.code.setAttribute("aria-invalid", "false");
    refs.codeError.hidden = true;
  });

  refs.formCode.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy) return;
    hideAlert(refs.alertCode);

    const code = refs.code.value.trim().toUpperCase();
    if (code.length < 4) {
      refs.code.setAttribute("aria-invalid", "true");
      refs.codeError.textContent = t("code.incomplete", "Digite o código completo do voucher.");
      refs.codeError.hidden = false;
      refs.code.focus();
      return;
    }

    setBusy(refs.btnValidate, true, t("code.submit.busy", "Validando…"));
    const result = await api("/api/validate", { code, locale: LOCALE });
    setBusy(refs.btnValidate, false);

    if (result.kind === "network") return showAlert(refs.alertCode, MSG.network);
    if (result.kind === "server") return showAlert(refs.alertCode, MSG.server);
    if (result.kind === "rate_limited") {
      return showAlert(refs.alertCode, MSG.rateLimited(humanMinutes(result.retryAfter)), "info");
    }

    const data = result.data;
    if (!data.valid) {
      if (data.reason === "processing") return showAlert(refs.alertCode, MSG.processing, "info");
      return showAlert(refs.alertCode, MSG.invalid);
    }

    state.code = code;
    state.batchName = data.batch_name || t("brand.product", "Voucher de Parceiro");
    state.expiresAt = data.expires_at;
    state.purposeNote = data.purpose_note || null;
    state.contents = Array.isArray(data.contents) ? data.contents : [];
    state.selectedId = null;

    if (!state.contents.length) return showAlert(refs.alertCode, MSG.invalid);

    renderContents();
    showScreen("contents");
  });

  /* ---------------------- TELA 2 — conteúdos ------------------------ */

  function badgeFor(deliveryType) {
    const badge = document.createElement("span");
    badge.className = `badge ${deliveryType === "PIN" ? "badge-pin" : "badge-dtu"}`;
    badge.textContent =
      deliveryType === "PIN"
        ? t("badge.pin", "Código PIN")
        : t("badge.dtu", "Entrega no seu ID");
    return badge;
  }

  function renderContents() {
    refs.batchName.textContent = state.batchName;
    refs.batchExpires.textContent = formatDate(state.expiresAt);
    refs.contentsList.textContent = "";
    refs.btnContinue.disabled = true;

    for (const content of state.contents) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "content-card";
      card.setAttribute("aria-pressed", "false");
      card.dataset.id = content.id;

      const icon = document.createElement("span");
      icon.className = "card-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = content.delivery_type === "PIN" ? "🎟" : "💎";

      const body = document.createElement("span");
      body.className = "card-body";
      const title = document.createElement("span");
      title.className = "card-title";
      title.textContent = content.display_label || "Conteúdo";
      body.append(title, badgeFor(content.delivery_type));

      card.append(icon, body);
      card.addEventListener("click", () => selectContent(content.id));
      refs.contentsList.append(card);
    }
  }

  function selectContent(id) {
    state.selectedId = id;
    for (const card of refs.contentsList.children) {
      card.setAttribute("aria-pressed", String(card.dataset.id === id));
    }
    refs.btnContinue.disabled = false;
  }

  refs.btnContinue.addEventListener("click", () => {
    const content = state.contents.find((c) => c.id === state.selectedId);
    if (!content) return;
    renderForm(content);
    showScreen("form");
  });

  /* ------------------- TELA 3 — formulário dinâmico ----------------- */

  function renderForm(content) {
    hideAlert(refs.alertForm);
    refs.summaryTitle.textContent = content.display_label || "Conteúdo";
    refs.summaryIcon.textContent = content.delivery_type === "PIN" ? "🎟" : "💎";

    const badge = badgeFor(content.delivery_type);
    badge.id = "summary-badge";
    refs.summaryBadge.replaceWith(badge);
    refs.summaryBadge = badge;

    const isPin = content.delivery_type === "PIN";
    const fields = Array.isArray(content.fields) ? content.fields : [];

    // Campos de dado em cima, consentimento embaixo, com a linha de
    // finalidade entre os dois. Ordem definida aqui e não no forms-map
    // porque é decisão de layout, não de contrato.
    refs.fields.textContent = "";
    refs.fieldsConsent.textContent = "";
    for (const spec of fields) {
      if (spec.type === "checkbox") refs.fieldsConsent.append(checkboxNode(spec));
      else refs.fields.append(fieldNode(spec));
    }

    const hasDataFields = refs.fields.children.length > 0;
    refs.purposeNote.hidden = !(state.purposeNote && hasDataFields);
    if (state.purposeNote) refs.purposeNote.textContent = state.purposeNote;

    // PIN não pede dado de entrega (só contato). DTU pede os campos da
    // categoria e SEMPRE mostra o aviso de entrega definitiva.
    refs.pinInfo.hidden = !isPin;
    refs.dtuNotice.hidden = isPin;
    refs.dtuConfirmWrap.hidden = isPin;
    refs.dtuConfirm.checked = false;

    const firstInput = refs.fields.querySelector("input");
    if (firstInput) firstInput.focus({ preventScroll: true });
  }

  function fieldNode(spec) {
    const wrap = document.createElement("div");
    wrap.className = "field";

    const label = document.createElement("label");
    label.htmlFor = `f-${spec.field}`;
    label.textContent = spec.label || spec.field;

    const input = document.createElement("input");
    input.id = `f-${spec.field}`;
    input.className = "input";
    input.type = "text";
    input.autocomplete = "off";
    input.dataset.field = spec.field;
    input.dataset.type = spec.type || "text";
    input.dataset.required = String(!!spec.required);
    if (spec.min_length) input.dataset.minLength = String(spec.min_length);
    if (spec.max_length) {
      input.dataset.maxLength = String(spec.max_length);
      input.maxLength = spec.max_length;
    }
    if (spec.placeholder) input.placeholder = spec.placeholder;

    // type="text" + inputmode: teclado certo no celular, sem os spinners do
    // type="number" nem as esquisitices de locale dele.
    if (spec.type === "number") {
      input.inputMode = "numeric";
      input.addEventListener("input", () => {
        input.value = input.value.replace(/[^0-9]/g, "");
      });
    } else if (spec.type === "cpf") {
      input.inputMode = "numeric";
      input.maxLength = 14; // 000.000.000-00
      input.addEventListener("input", () => {
        input.value = maskCpf(input.value);
      });
    } else if (spec.type === "email") {
      input.type = "email";
      input.inputMode = "email";
      input.autocomplete = "email";
      input.spellcheck = false;
      input.maxLength = 254;
    }

    const error = document.createElement("p");
    error.className = "field-error";
    error.id = `e-${spec.field}`;
    error.hidden = true;
    input.setAttribute("aria-describedby", error.id);

    input.addEventListener("input", () => {
      input.setAttribute("aria-invalid", "false");
      error.hidden = true;
    });

    wrap.append(label, input);
    if (spec.help) {
      const help = document.createElement("p");
      help.className = "field-help";
      help.textContent = spec.help;
      wrap.append(help);
    }
    wrap.append(error);
    return wrap;
  }

  /** Checkbox de consentimento (marketing_optin). Nasce sempre desmarcado. */
  function checkboxNode(spec) {
    const wrap = document.createElement("div");

    const label = document.createElement("label");
    label.className = "check";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `f-${spec.field}`;
    input.checked = false;
    input.dataset.field = spec.field;
    input.dataset.type = "checkbox";
    input.dataset.required = String(!!spec.required);

    const text = document.createElement("span");
    text.textContent = spec.label || spec.field;

    const error = document.createElement("p");
    error.className = "field-error";
    error.id = `e-${spec.field}`;
    error.hidden = true;
    input.setAttribute("aria-describedby", error.id);

    input.addEventListener("change", () => {
      error.hidden = true;
    });

    label.append(input, text);
    wrap.append(label, error);
    return wrap;
  }

  function allFieldInputs() {
    return [
      ...refs.fields.querySelectorAll("input"),
      ...refs.fieldsConsent.querySelectorAll("input"),
    ];
  }

  /** Espelho da validação do servidor. Retorna null se algo estiver errado. */
  function collectPlayerData() {
    const data = {};
    let firstBad = null;

    for (const input of allFieldInputs()) {
      const field = input.dataset.field;
      const type = input.dataset.type;
      const error = el(`e-${field}`);
      let message = null;

      if (type === "checkbox") {
        // Booleano sempre vai no payload, marcado ou não: o Brief 3 precisa
        // saber que houve escolha explícita, e não ausência de resposta.
        if (input.dataset.required === "true" && !input.checked) {
          message = t("field.checkRequired", "É preciso marcar esta opção.");
        } else {
          data[field] = input.checked;
        }
        if (message) {
          error.textContent = message;
          error.hidden = false;
          if (!firstBad) firstBad = input;
        }
        continue;
      }

      const value = input.value.trim();
      const digits = value.replace(/\D/g, "");

      if (!value) {
        if (input.dataset.required === "true") message = t("field.required", "Preencha este campo.");
      } else if (type === "email" && !EMAIL_RE.test(value)) {
        message = t("field.email", "Digite um email válido.");
      } else if (type === "cpf" && digits.length !== 11) {
        // Sem chave de i18n DE PROPÓSITO: o CPF só existe no locale
        // pt-BR (forms-map.json, `locales: ["pt-BR"]`), então o servidor
        // nunca declara o campo em es-MX e estas mensagens não têm como
        // ser alcançadas lá. Traduzi-las sugeriria uma tela que não existe.
        message = "O CPF precisa ter 11 dígitos.";
      } else if (type === "cpf" && !isValidCpf(digits)) {
        message = "CPF inválido — confira os números.";
      } else if (type === "number" && !/^[0-9]+$/.test(value)) {
        message = t("field.numeric", "Use somente números.");
      } else if (input.dataset.minLength && value.length < Number(input.dataset.minLength)) {
        message = `Precisa ter pelo menos ${input.dataset.minLength} dígitos.`;
      } else if (input.dataset.maxLength && value.length > Number(input.dataset.maxLength)) {
        message = `Precisa ter no máximo ${input.dataset.maxLength} dígitos.`;
      }

      if (message) {
        input.setAttribute("aria-invalid", "true");
        error.textContent = message;
        error.hidden = false;
        if (!firstBad) firstBad = input;
      } else if (value) {
        data[field] = type === "cpf" ? digits : value;
      }
    }

    if (firstBad) {
      firstBad.focus();
      return null;
    }
    return data;
  }

  refs.formRedeem.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy) return;
    hideAlert(refs.alertForm);

    const content = state.contents.find((c) => c.id === state.selectedId);
    if (!content) return showScreen("contents");

    const playerData = collectPlayerData();
    if (playerData === null) return;

    if (content.delivery_type !== "PIN" && !refs.dtuConfirm.checked) {
      showAlert(
        refs.alertForm,
        t(
          "dtu.confirmRequired",
          "Marque a confirmação de que os dados estão corretos antes de continuar."
        ),
        "info"
      );
      refs.dtuConfirm.focus();
      return;
    }

    setBusy(refs.btnRedeem, true, t("form.submit.busy", "Enviando…"));
    const result = await api("/api/redeem", {
      code: state.code,
      content_id: content.id,
      player_data: playerData,
      // O locale vai junto: decide quais campos o servidor considera
      // declarados (o CPF não existe em es-MX) e em que idioma os emails
      // do Brief 5 saem.
      locale: LOCALE,
    });
    setBusy(refs.btnRedeem, false);

    if (result.kind === "network") return showAlert(refs.alertForm, MSG.network);
    if (result.kind === "server") return showAlert(refs.alertForm, MSG.server);
    if (result.kind === "rate_limited") {
      return showAlert(refs.alertForm, MSG.rateLimited(humanMinutes(result.retryAfter)), "info");
    }

    const data = result.data;

    // Erro de campo devolvido pelo servidor: pinta o campo, não troca de tela.
    if (data.status === "invalid_payload") {
      const errors = data.errors || {};
      let firstBad = null;
      for (const [field, message] of Object.entries(errors)) {
        const input = el(`f-${field}`);
        const error = el(`e-${field}`);
        if (!input || !error) continue;
        input.setAttribute("aria-invalid", "true");
        error.textContent = String(message);
        error.hidden = false;
        if (!firstBad) firstBad = input;
      }
      if (firstBad) firstBad.focus();
      else showAlert(refs.alertForm, MSG.server);
      return;
    }

    // Resgate aceito: o voucher já está travado e a order já foi pedida.
    // A partir daqui só se ACOMPANHA — nunca se reenvia.
    if (data.status === "processing" && data.attempt_ref) {
      state.attemptRef = data.attempt_ref;
      showScreen("processing");
      startPolling();
      return;
    }

    showResult(data.status, data.message);
  });

  /* ------------- TELA 4 — acompanhamento do desfecho ---------------- */

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function startPolling() {
    stopPolling();
    state.pollUntil = Date.now() + POLL_MAX_MS;
    state.pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }

  function scheduleNextPoll(delay) {
    if (Date.now() >= state.pollUntil) {
      stopPolling();
      showResult("timeout");
      return;
    }
    state.pollTimer = setTimeout(pollOnce, delay);
  }

  async function pollOnce() {
    if (!state.code || !state.attemptRef) return;

    const result = await api("/api/status", {
      code: state.code,
      attempt_ref: state.attemptRef,
    });

    // Rede instável ou erro do servidor não encerram nada: a order existe
    // do lado de lá e o desfecho continua valendo. Tenta de novo.
    if (result.kind === "network" || result.kind === "server") {
      return scheduleNextPoll(POLL_INTERVAL_MS);
    }
    if (result.kind === "rate_limited") {
      return scheduleNextPoll(POLL_BACKOFF_MS);
    }

    const data = result.data;

    if (data.status === "success") {
      stopPolling();
      return showResult("success", data.message, data);
    }
    if (data.status === "failed" || data.status === "invalid_or_unavailable") {
      stopPolling();
      return showResult(data.status, data.message);
    }

    scheduleNextPoll(POLL_INTERVAL_MS);
  }

  /* ---------------------- TELA 5 — resultado ------------------------ */

  function showResult(status, serverMessage, data) {
    const payload = data || {};
    const isPin = payload.delivery_type === "PIN";

    const views = {
      success: {
        icon: "🎉",
        tone: "ok",
        title: t("result.success.title", "Resgate concluído"),
        message: !isPin
          ? t(
              "result.success.dtu",
              "Pronto! O conteúdo foi entregue direto na conta do ID que você informou."
            )
          : payload.pin
            ? t(
                "result.success.pin",
                "Seu código PIN está aqui embaixo. Use-o no jogo para receber o conteúdo."
              )
            : t("result.success.plain", "O resgate foi concluído."),
        detail: isPin
          ? null
          : t(
              "result.success.dtuDetail",
              "A entrega pode levar alguns minutos para aparecer no jogo. Se não aparecer, fale com o suporte com este voucher em mãos."
            ),
      },
      // Falha depois do disparo: o servidor já devolveu o voucher, então
      // dá pra escolher outro conteúdo sem sair da sessão.
      failed: {
        icon: "⚠",
        tone: "warn",
        // A mensagem do servidor já diz que o código continua válido; um
        // detail repetindo isso só empurra os botões pra baixo.
        title: t("result.failed.title", "Não deu pra concluir"),
        message: serverMessage || MSG.server,
        detail: null,
        retry: true,
      },
      // Teto de 5 min da tela. O resgate NÃO foi cancelado: a
      // reconciliação do servidor fecha sozinha em até 20 minutos.
      timeout: {
        icon: "⏳",
        tone: "info",
        title: t("result.slow.title", "Ainda processando"),
        message: t(
          "result.slow.message",
          "O fornecedor está demorando mais que o normal. Seu resgate continua em andamento — não é preciso fazer nada."
        ),
        detail: t(
          "result.slow.detail",
          "Consulte seu código mais tarde nesta mesma tela para ver o resultado. Não tente resgatar de novo agora."
        ),
      },
      maintenance: {
        icon: "🛠",
        tone: "info",
        title: t("result.maintenance.title", "Resgate em manutenção"),
        message:
          serverMessage ||
          t(
            "result.maintenance.message",
            "O resgate está em manutenção neste momento. Tente novamente mais tarde."
          ),
        detail: t(
          "result.maintenance.detail",
          "Seu código NÃO foi usado e continua válido. Nada foi entregue e nada foi cobrado."
        ),
      },
      processing: {
        icon: "⏳",
        tone: "info",
        title: t("result.inProgress.title", "Resgate em andamento"),
        message: MSG.processing,
        detail: null,
      },
      invalid_or_unavailable: {
        icon: "⚠",
        tone: "warn",
        title: t("result.unavailable.title", "Código indisponível"),
        message: MSG.invalid,
        detail: null,
      },
    };

    const view = views[status] || {
      icon: "⚠",
      tone: "warn",
      title: t("result.failed.title", "Não deu pra concluir"),
      message: MSG.server,
      detail: null,
    };

    refs.resultIcon.textContent = view.icon;
    refs.resultIcon.dataset.tone = view.tone;
    refs.resultTitle.textContent = view.title;
    refs.resultMessage.textContent = view.message;

    // Sucesso sem PIN na tela (expirado ou não recuperável) traz a
    // explicação do servidor no lugar do detalhe padrão.
    const detail = status === "success" && payload.message ? payload.message : view.detail;
    refs.resultDetail.hidden = !detail;
    if (detail) refs.resultDetailText.textContent = detail;

    // "Escolher outro conteúdo" só em falha, e só se ainda houver lista.
    refs.btnRetryContent.hidden = !(view.retry && state.contents.length > 0);

    showPin(payload.pin, payload.serial);
    showScreen("result");
  }

  function showPin(pin, serial) {
    refs.pinCopied.textContent = "";
    if (!pin) {
      refs.resultPin.hidden = true;
      refs.pinValue.textContent = "";
      refs.pinSerial.hidden = true;
      return;
    }
    refs.pinValue.textContent = pin;
    refs.pinSerial.hidden = !serial;
    if (serial) refs.pinSerial.textContent = `Serial: ${serial}`;
    refs.resultPin.hidden = false;
  }

  refs.btnCopyPin.addEventListener("click", async () => {
    const pin = refs.pinValue.textContent;
    if (!pin) return;
    try {
      await navigator.clipboard.writeText(pin);
      refs.pinCopied.textContent = t("pin.copied", "Código copiado.");
    } catch {
      // Clipboard bloqueado (permissão, contexto inseguro): seleciona o
      // texto pro usuário copiar à mão em vez de deixar sem saída.
      const range = document.createRange();
      range.selectNodeContents(refs.pinValue);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      refs.pinCopied.textContent = t("pin.copyManual", "Selecione e copie o código acima.");
    }
  });

  refs.btnRetryContent.addEventListener("click", () => {
    state.attemptRef = null;
    state.selectedId = null;
    showPin(null);
    renderContents();
    showScreen("contents");
  });

  /* ----------------------------- voltar ----------------------------- */

  for (const button of document.querySelectorAll("[data-back]")) {
    button.addEventListener("click", () => {
      if (state.busy) return;
      showScreen(button.dataset.back);
    });
  }

  refs.btnRestart.addEventListener("click", () => {
    stopPolling();
    state.code = null;
    state.batchName = null;
    state.expiresAt = null;
    state.purposeNote = null;
    state.contents = [];
    state.selectedId = null;
    state.attemptRef = null;
    showPin(null);
    refs.code.value = "";
    refs.formRedeem.reset();
    hideAlert(refs.alertCode);
    hideAlert(refs.alertForm);
    showScreen("code");
    refs.code.focus();
  });

  applyStaticI18n();
  showScreen("code");
  refs.code.focus({ preventScroll: true });
})();
