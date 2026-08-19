/* =====================================================================
   Testes de lib/email-templates.mjs e lib/mailer.mjs — Brief 5.

   Os templates são funções puras: rodam sem stub nenhum. O mailer tem o
   fetch stubado por teste, porque o que importa nele não é o envio e sim
   o que ele faz QUANDO FALHA — e a regra é que ele nunca lança.

   Rodar:  npm test
   ===================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  welcomeEmail,
  pinEmail,
  resolveLocale,
  resolveSiteHost,
  DEFAULT_LOCALE,
  DEFAULT_SITE_HOST,
} from "../lib/email-templates.mjs";
import { sendEmail, recipientDomain, mailerEnabled, FROM_ADDRESS } from "../lib/mailer.mjs";

const PIN = "4077123456789012";
const SERIAL = "791234567";

/* --------------------------- locale -------------------------------- */

test("locale desconhecido cai no default em vez de estourar", () => {
  // Um email em português é melhor que resgate sem email porque o locale
  // veio errado do banco.
  assert.equal(resolveLocale("pt-BR"), "pt-BR");
  assert.equal(resolveLocale("es-MX"), "es-MX");
  for (const lixo of ["en-US", "", null, undefined, "PT-br", 42]) {
    assert.equal(resolveLocale(lixo), DEFAULT_LOCALE);
  }
});

/* -------------------------- templates ------------------------------ */

test("tagline oficial por idioma, sem vazar um no outro", () => {
  const pt = welcomeEmail({ locale: "pt-BR" });
  const es = welcomeEmail({ locale: "es-MX" });

  assert.ok(pt.html.includes("RECARGA. JOGUE MAIS."));
  assert.ok(!pt.html.includes("JUEGA MÁS"));

  assert.ok(es.html.includes("RECARGA. JUEGA MÁS."));
  assert.ok(!es.html.includes("JOGUE MAIS"));

  // O logo em texto aparece nos dois — nada de imagem que nasce bloqueada.
  assert.ok(pt.html.includes("RECARGA") && pt.html.includes("GAMES"));
  assert.ok(!/<img/i.test(pt.html), "template com imagem externa");
});

test("todo email tem text/plain de verdade, não HTML sem tags", () => {
  for (const mail of [
    welcomeEmail({ locale: "pt-BR" }),
    welcomeEmail({ locale: "es-MX" }),
    pinEmail({ locale: "pt-BR", pin: PIN, serial: SERIAL }),
    pinEmail({ locale: "es-MX", pin: PIN, serial: SERIAL }),
  ]) {
    assert.ok(mail.subject.length > 0);
    assert.ok(mail.text.length > 0);
    assert.ok(!/<[a-z]/i.test(mail.text), "sobrou tag HTML no text/plain");
    assert.ok(mail.text.includes("RECARGA GAMES"));
  }
});

test("boas-vindas NÃO carrega código nenhum", () => {
  // Ele é disparado no claim, quando ainda não existe PIN. Se um dia
  // alguém passar um, o template não pode exibi-lo.
  const mail = welcomeEmail({ locale: "pt-BR", pin: PIN });
  assert.ok(!mail.html.includes(PIN));
  assert.ok(!mail.text.includes(PIN));
});

test("email de PIN traz código e serial nas duas versões", () => {
  const mail = pinEmail({ locale: "pt-BR", pin: PIN, serial: SERIAL });
  assert.ok(mail.html.includes(PIN));
  assert.ok(mail.text.includes(PIN));
  assert.ok(mail.html.includes(SERIAL));
  assert.ok(mail.text.includes(SERIAL));
});

test("sem serial o email do PIN sai igual, só sem o bloco", () => {
  // A Lapak nem sempre manda serial (o parsing do A0 é tolerante).
  const mail = pinEmail({ locale: "es-MX", pin: PIN, serial: null });
  assert.ok(mail.html.includes(PIN));
  assert.ok(!mail.html.includes("SERIAL"));
  assert.ok(!mail.text.includes("SERIAL"));
});

test("nome de produto vindo do fornecedor é escapado", () => {
  // productLabel vem da Lapak; se um dia trouxer HTML, não pode virar markup.
  const mail = pinEmail({
    locale: "pt-BR",
    pin: PIN,
    productLabel: '<script>alert("x")</script>',
  });
  assert.ok(!mail.html.includes("<script>"), "HTML do fornecedor não foi escapado");
  assert.ok(mail.html.includes("&lt;script&gt;"));
});

/* ---------------------------- mailer ------------------------------- */

const withKey = async (value, fn) => {
  const previous = process.env.RESEND_API_KEY;
  if (value === null) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous;
  }
};

test("mailerEnabled é falso sem chave — e isso não é erro", () => {
  return withKey(null, async () => {
    assert.equal(mailerEnabled(), false);
    const result = await sendEmail({ to: "a@b.com", subject: "x", html: "x", text: "x" });
    assert.deepEqual(result, { ok: false, error: "not_configured" });
  });
});

test("sendEmail NUNCA lança — nem em timeout, nem com a rede morta", async () => {
  await withKey("re_TESTE_NAO_REAL", async () => {
    const original = globalThis.fetch;

    globalThis.fetch = async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    };
    assert.deepEqual(await sendEmail({ to: "a@b.com", subject: "s" }), {
      ok: false,
      error: "timeout",
    });

    globalThis.fetch = async () => {
      throw new Error("socket morto");
    };
    assert.deepEqual(await sendEmail({ to: "a@b.com", subject: "s" }), {
      ok: false,
      error: "unreachable",
    });

    globalThis.fetch = original;
  });
});

test("erro HTTP vira código curto, sem ler o corpo da resposta", async () => {
  await withKey("re_TESTE_NAO_REAL", async () => {
    const original = globalThis.fetch;
    let bodyLido = false;

    globalThis.fetch = async () => ({
      ok: false,
      status: 422,
      // Em 422 a Resend ecoa o destinatário na mensagem. Se alguém passar
      // a ler isto, o endereço acaba em log — daí o teste.
      json: async () => {
        bodyLido = true;
        return { message: "invalid to: jogador@email.com" };
      },
      text: async () => {
        bodyLido = true;
        return "invalid to: jogador@email.com";
      },
    });

    const result = await sendEmail({ to: "jogador@email.com", subject: "s" });
    assert.deepEqual(result, { ok: false, error: "http_422" });
    assert.equal(bodyLido, false, "o corpo do erro foi lido — pode conter PII");

    globalThis.fetch = original;
  });
});

test("destinatário inválido é barrado antes de qualquer request", async () => {
  await withKey("re_TESTE_NAO_REAL", async () => {
    const original = globalThis.fetch;
    let chamou = false;
    globalThis.fetch = async () => {
      chamou = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    for (const to of ["", null, undefined, "semarroba"]) {
      assert.deepEqual(await sendEmail({ to, subject: "s" }), {
        ok: false,
        error: "no_recipient",
      });
    }
    assert.equal(chamou, false);

    globalThis.fetch = original;
  });
});

test("recipientDomain devolve só o domínio — nunca o endereço", () => {
  assert.equal(recipientDomain("jogador@gmail.com"), "gmail.com");
  assert.equal(recipientDomain("a.b+tag@Sub.Dominio.COM"), "sub.dominio.com");
  assert.equal(recipientDomain("semarroba"), "desconhecido");
  assert.equal(recipientDomain(null), "desconhecido");
  // O local-part não sobra em lugar nenhum do retorno.
  assert.ok(!recipientDomain("jogador@gmail.com").includes("jogador"));
});

test("remetente é a caixa não monitorada decidida no brief", () => {
  assert.match(FROM_ADDRESS, /no-reply@recargagames\.com/);
  assert.match(FROM_ADDRESS, /Recarga Games/);
});

/* ------------- hostname do parceiro nos links (Brief 5) ------------- */

test("nenhum template tem hostname fixo — o link vem do parceiro", () => {
  const host = "canje.plusmo.mx";
  for (const mail of [
    welcomeEmail({ locale: "es-MX", siteHost: host }),
    pinEmail({ locale: "es-MX", siteHost: host, pin: PIN }),
  ]) {
    assert.ok(mail.html.includes(`https://${host}`), "link do parceiro ausente no HTML");
    assert.ok(mail.text.includes(`https://${host}`), "link do parceiro ausente no text");
    assert.ok(
      !mail.html.includes("reload.recargagames.com"),
      "sobrou link fixo do reload no email de outro parceiro"
    );
    assert.ok(!mail.text.includes("reload.recargagames.com"));
  }
});

test("branding visual continua Recarga Games para todo parceiro", () => {
  // O que muda é o DESTINO do link, não a marca.
  const mail = pinEmail({ locale: "es-MX", siteHost: "canje.plusmo.mx", pin: PIN });
  assert.ok(mail.html.includes("RECARGA"), "perdeu o logo");
  assert.ok(mail.html.includes("GAMES"));
  assert.ok(mail.html.includes("RECARGA. JUEGA MÁS."), "perdeu a tagline");
});

test("sem hostname, cai no reload — o default do brief", () => {
  for (const mail of [welcomeEmail({}), pinEmail({ pin: PIN })]) {
    assert.ok(mail.html.includes(`https://${DEFAULT_SITE_HOST}`));
  }
  assert.equal(DEFAULT_SITE_HOST, "reload.recargagames.com");
});

test("hostname malformado NUNCA vira href — cai no default", () => {
  // Esta é a defesa contra link de phishing assinado com o nosso DKIM.
  // O CHECK da migration barra na escrita; isto é a segunda camada.
  const perigosos = [
    'evil.com" onclick="alert(1)',
    "https://evil.com",
    "evil.com/path",
    "evil.com:8080",
    "javascript:alert(1)",
    "evil com",
    "",
    null,
    undefined,
    "  ",
    "-comeca-com-hifen.com",
  ];
  for (const host of perigosos) {
    assert.equal(resolveSiteHost(host), DEFAULT_SITE_HOST, `passou: ${host}`);
    const mail = pinEmail({ pin: PIN, siteHost: host });
    assert.ok(!mail.html.includes("evil.com"), `evil.com entrou no HTML via ${host}`);
    assert.ok(!mail.html.includes("javascript:"), "esquema javascript: no href");
  }
});

test("hostname válido é aceito e normalizado para minúsculas", () => {
  assert.equal(resolveSiteHost("canje.plusmo.mx"), "canje.plusmo.mx");
  assert.equal(resolveSiteHost("  Canje.Plusmo.MX  "), "canje.plusmo.mx");
  assert.equal(resolveSiteHost("reload.recargagames.com"), "reload.recargagames.com");
});
