# recargagames-reload

App público de resgate do **Voucher de Parceiro** — `reload.recargagames.com`.

O usuário digita o código do voucher, vê os conteúdos do lote, preenche o
formulário (quando for entrega direta) e confirma o resgate.

**Estado atual: Brief 2.** O fluxo é navegável de ponta a ponta e a validação
do código é real, contra o banco. O **resgate em si não existe ainda**:
`/api/redeem` é um stub que valida o payload e responde
`{ status: "not_implemented" }`, e o front mostra a tela de manutenção. O
redeemer de verdade (Lapak) é o Brief 3.

---

## Stack

| Camada | Decisão |
|---|---|
| Front | HTML + CSS + JS vanilla em `public/`. **Sem framework, sem build step.** |
| Back | Netlify Functions (API v2, ESM) em `netlify/functions/` |
| Banco | Supabase `ashmirzgyuhspymldpfv` — o mesmo da loja/admin, tabelas `pv_*` |
| Host | Netlify, site próprio, CD por push na `main` |
| DNS | subdomínio `reload` gerenciado **no Netlify** (não no GoDaddy) |

Mesmo padrão de casa do `recargagames-offerwall`. Nenhuma dependência npm em
produção — o `package.json` só existe pelos scripts de teste.

## Estrutura

```
public/                 ← ISSO é o que vai pro ar (publish dir)
  index.html            as 4 telas, alternadas por [hidden]
  app.js                estado + chamadas de API (sem inline script, por CSP)
  styles.css            tokens da identidade visual
netlify/functions/
  validate.mjs          POST /api/validate  — leitura, valida o código
  redeem.mjs            POST /api/redeem    — STUB do Brief 2
lib/                    módulos server-side (fora de functions/ de propósito)
  http.mjs              CORS, JSON, hash de log, IP do cliente
  supabase.mjs          REST com a Secret key
  rate-limit.mjs        contador por IP em pv_validate_rate
  vouchers.mjs          busca + avaliação de voucher (SÓ LEITURA)
  forms.mjs             SKU → categoria → campos, e validação do payload
forms-map.json          mapa estático de formulários por categoria
migrations/             SQL aplicado manualmente no Supabase
tests/                  suíte com Supabase stubado + harness local
```

`publish = "public"` garante que `forms-map.json`, `migrations/` e `lib/`
**não** sejam servidos publicamente.

## Env vars (painel Netlify deste site — nunca no repo)

| Var | Valor |
|---|---|
| `SUPABASE_URL` | `https://ashmirzgyuhspymldpfv.supabase.co` |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` (bypassa RLS; só server-side) |
| `IP_HASH_SALT` | string aleatória longa e **fixa** (trocar zera os contadores de rate limit e os hashes de log) |

O front não usa nenhuma chave do Supabase — nem a publishable. Toda conversa
com o banco passa pelas functions.

Gerar o salt: `openssl rand -hex 32`

## Migration

`migrations/2026-07-30-pv-validate-rate.sql` — tabela `pv_validate_rate` +
função de incremento atômico `pv_validate_rate_hit()`. Aplicar colando no SQL
Editor do Supabase. O arquivo tem, comentados no fim, os testes de RLS como
`anon` e o rollback.

**A migration é pré-requisito**: sem ela o rate limit falha e as duas
functions respondem 503 (fail-closed, de propósito — ver abaixo).

## Rodar local

```bash
npm test                # 23 testes das functions, sem rede e sem banco
npm run check:secrets   # grep de secrets/SKU no bundle público
npm run check           # os dois

node tests/dev-server.mjs   # http://localhost:8000
```

O `dev-server.mjs` serve o front real e roteia `/api/*` pras **functions
reais**, com o `fetch` global stubado — Supabase falso, nada toca produção.
Códigos de teste (definidos em `TEST_CODES`):

| Código | Cenário |
|---|---|
| `RLBK-VALIDO0001` | lote válido, 1 DTU + 1 PIN |
| `RLBK-SODTU00001` | só DTU |
| `RLBK-SOPIN00001` | só PIN |
| `RLBK-USADO00001` | voucher usado → mensagem genérica |
| `RLBK-CANCEL0001` | voucher cancelado → mensagem genérica |
| `RLBK-VENCIDO001` | lote vencido → mensagem genérica |
| `RLBK-PROCESS001` | resgate em andamento → mensagem específica |
| `RLBK-SKUNOVO001` | 1 SKU mapeado + 1 SKU fora do forms-map → só o mapeado aparece |
| `RLBK-SOSKUNOVO1` | só SKU fora do forms-map → mensagem genérica |
| qualquer outro | inexistente → mensagem genérica |

CPF de teste válido: `111.444.777-35`. Inválido: `111.444.777-36`.

`GET /dev/reset` zera o contador de rate limit local.

## O formulário (tela 3)

Os campos vêm todos do servidor, já resolvidos, em `forms-map.json`:

- **campos de entrega**, por categoria de SKU — hoje só Free Fire (`user_id`).
  Só o fluxo DTU tem esses; PIN não pede nada de entrega.
- **campos comuns**, pedidos em todo resgate (DTU e PIN igual):
  `email` (obrigatório, validação de formato), `cpf` (opcional, validação de
  dígito verificador quando preenchido) e `marketing_optin` (checkbox,
  **desmarcado por padrão**).

Abaixo dos campos de dado pessoal vai a linha de finalidade
(`purpose_note`, também servida pelo `forms-map.json`), e o consentimento de
marketing fica separado dela. No fluxo DTU, o aviso de entrega definitiva
(Check ID OFF) e o checkbox de conferência vêm depois.

Neste brief os dados são validados e **descartados** — persistência é Brief 3.

## Decisões de segurança (não afrouxar sem conversa)

- **Resposta de erro é sempre a mesma** (`invalid_or_unavailable`) pra código
  inexistente, usado, cancelado, vencido e lote cancelado. Diferenciar daria
  oráculo pra brute force. A única exceção é `PROCESSING`, porque o usuário
  legítimo precisa saber que o resgate dele está em curso.
- **`product_code` (SKU Lapak) nunca vai pro front.** O front escolhe conteúdo
  por `id` de `pv_batch_contents`; o mapeamento id → SKU fica no servidor. Sem
  isso o catálogo do parceiro seria enumerável.
- **Rate limit é fail-closed.** Se o contador não puder ser gravado, as
  functions respondem 503 em vez de liberar. Sem limitador o `/api/validate`
  vira oráculo de código.
- **`/api/redeem` também é rate limited**, no mesmo balde do validate — senão
  seria o mesmo oráculo por outra porta.
- **SKU DTU fora do `forms-map.json` é recusado** (`fallback_category: null`),
  não cai em formulário genérico. Pedir o campo errado entrega no lugar errado,
  e DTU não tem reembolso. Recusa o conteúdo, não o lote: os outros conteúdos
  válidos do mesmo voucher continuam resgatáveis. O SKU vai pro log de erro.
- **Log nunca tem código completo**: só os 4 primeiros chars + HMAC curto
  (HMAC, não SHA nu, pra que o log não seja reversível por força bruta).
- **Log nunca tem email, CPF ou `user_id`** — mesma regra do código. No log de
  resgate vão só os *nomes* dos campos preenchidos, nunca valores. O
  `player_data` saneado existe só em memória, dentro da request.
- **CORS restrito** ao domínio canônico + as URLs de deploy do próprio site
  (`URL`/`DEPLOY_PRIME_URL`). `localhost` só entra em contexto `dev`.
- **A chave admin do proxy não existe neste repo.** A Lapak é Brief 3;
  `tests/check-secrets.sh` reprova se alguém introduzir o nome dela.

## Deploy

Push na `main` → Netlify publica. Rollback: `git revert` + push, ou despublicar
o site no painel. Loja, admin e proxy não são tocados por este repo.
