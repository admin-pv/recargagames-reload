/* =====================================================================
   App de Resgate — Voucher de Parceiro
   Vanilla JS, sem build, sem dependência. Arquivo separado (não inline)
   pra que a CSP possa ser script-src 'self', sem 'unsafe-inline'.

   Regras que valem pra este arquivo:
   - O código do voucher vive SÓ em memória. Nunca vai pra URL, nunca vai
     pra localStorage/sessionStorage — link compartilhado ou histórico do
     navegador não pode carregar voucher.
   - Nada de innerHTML com dado vindo do servidor: sempre textContent.
   - Validação daqui é conveniência de UX. A que conta é a da function.
   ===================================================================== */

(() => {
  "use strict";

  const SCREENS = ["code", "contents", "form", "result"];
  const STEP_OF_SCREEN = { code: "code", contents: "contents", form: "form", result: null };

  const MSG = {
    invalid:
      "Código inválido ou indisponível. Confira se digitou certo — se estiver certo, ele pode já ter sido usado, cancelado ou vencido.",
    processing:
      "Este voucher já tem um resgate em andamento. Aguarde alguns minutos e tente novamente.",
    rateLimited: (min) =>
      `Muitas tentativas em pouco tempo. Por segurança, espere ${min} e tente de novo.`,
    network:
      "Não conseguimos falar com o servidor. Verifique sua conexão e tente novamente.",
    server:
      "Tivemos um problema por aqui. Tente novamente em alguns instantes.",
  };

  // Estado da sessão de resgate — memória, só isso.
  const state = {
    code: null,
    batchName: null,
    expiresAt: null,
    contents: [],
    selectedId: null,
    busy: false,
  };

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
    summaryTitle: el("summary-title"),
    summaryBadge: el("summary-badge"),
    summaryIcon: el("summary-icon"),
    dtuNotice: el("dtu-notice"),
    dtuConfirmWrap: el("dtu-confirm-wrap"),
    dtuConfirm: el("dtu-confirm"),
    pinInfo: el("pin-info"),
    btnRedeem: el("btn-redeem"),
    alertForm: el("alert-form"),
    resultIcon: el("result-icon"),
    resultTitle: el("title-result"),
    resultMessage: el("result-message"),
    resultDetail: el("result-detail"),
    resultDetailText: el("result-detail-text"),
    btnRestart: el("btn-restart"),
  };

  /* ---------------------- navegação entre telas ---------------------- */

  function showScreen(name) {
    for (const s of SCREENS) el(`screen-${s}`).hidden = s !== name;

    const order = ["code", "contents", "form"];
    const currentStep = STEP_OF_SCREEN[name];
    for (const li of refs.steps.children) {
      const step = li.dataset.step;
      if (name === "result") li.dataset.state = "done";
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
    strong.textContent = tone === "info" ? "Atenção: " : "Não foi possível: ";
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
    return min === 1 ? "1 minuto" : `${min} minutos`;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
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
      refs.codeError.textContent = "Digite o código completo do voucher.";
      refs.codeError.hidden = false;
      refs.code.focus();
      return;
    }

    setBusy(refs.btnValidate, true, "Validando…");
    const result = await api("/api/validate", { code });
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
    state.batchName = data.batch_name || "Voucher de Parceiro";
    state.expiresAt = data.expires_at;
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
    badge.textContent = deliveryType === "PIN" ? "Código PIN" : "Entrega no seu ID";
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

    refs.fields.textContent = "";
    for (const spec of fields) refs.fields.append(fieldNode(spec));

    // PIN não pede nada: só resumo + confirmar. DTU pede os campos da
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
    // type="text" + inputmode: teclado numérico no celular sem os spinners
    // e sem as esquisitices de locale do type="number".
    if (spec.type === "number") {
      input.inputMode = "numeric";
      input.addEventListener("input", () => {
        input.value = input.value.replace(/[^0-9]/g, "");
      });
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

  /** Espelho da validação do servidor. Retorna null se algo estiver errado. */
  function collectPlayerData() {
    const inputs = Array.from(refs.fields.querySelectorAll("input"));
    const data = {};
    let firstBad = null;

    for (const input of inputs) {
      const value = input.value.trim();
      const error = el(`e-${input.dataset.field}`);
      let message = null;

      if (!value) {
        if (input.dataset.required === "true") message = "Preencha este campo.";
      } else if (input.dataset.type === "number" && !/^[0-9]+$/.test(value)) {
        message = "Use somente números.";
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
        data[input.dataset.field] = value;
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
        "Marque a confirmação de que os dados estão corretos antes de continuar.",
        "info"
      );
      refs.dtuConfirm.focus();
      return;
    }

    setBusy(refs.btnRedeem, true, "Enviando…");
    const result = await api("/api/redeem", {
      code: state.code,
      content_id: content.id,
      player_data: playerData,
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

    showResult(data.status, data.message);
  });

  /* ---------------------- TELA 4 — resultado ------------------------ */

  function showResult(status, serverMessage) {
    const views = {
      // Brief 2: o resgate é stub. Vira tela de sucesso/PIN no Brief 3.
      not_implemented: {
        icon: "🛠",
        tone: "info",
        title: "Resgate em manutenção",
        message:
          serverMessage ||
          "O resgate está em manutenção neste momento. Tente novamente mais tarde.",
        detail:
          "Seu código NÃO foi usado e continua válido. Nada foi entregue e nada foi cobrado.",
      },
      processing: {
        icon: "⏳",
        tone: "info",
        title: "Resgate em andamento",
        message: MSG.processing,
        detail: null,
      },
      invalid_or_unavailable: {
        icon: "⚠",
        tone: "warn",
        title: "Código indisponível",
        message: MSG.invalid,
        detail: null,
      },
    };

    const view = views[status] || {
      icon: "⚠",
      tone: "warn",
      title: "Não deu pra concluir",
      message: MSG.server,
      detail: null,
    };

    refs.resultIcon.textContent = view.icon;
    refs.resultIcon.dataset.tone = view.tone;
    refs.resultTitle.textContent = view.title;
    refs.resultMessage.textContent = view.message;
    refs.resultDetail.hidden = !view.detail;
    if (view.detail) refs.resultDetailText.textContent = view.detail;

    showScreen("result");
  }

  /* ----------------------------- voltar ----------------------------- */

  for (const button of document.querySelectorAll("[data-back]")) {
    button.addEventListener("click", () => {
      if (state.busy) return;
      showScreen(button.dataset.back);
    });
  }

  refs.btnRestart.addEventListener("click", () => {
    state.code = null;
    state.batchName = null;
    state.expiresAt = null;
    state.contents = [];
    state.selectedId = null;
    refs.code.value = "";
    refs.formRedeem.reset();
    hideAlert(refs.alertCode);
    hideAlert(refs.alertForm);
    showScreen("code");
    refs.code.focus();
  });

  showScreen("code");
  refs.code.focus({ preventScroll: true });
})();
