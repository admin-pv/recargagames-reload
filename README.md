# recargagames-reload

App público de resgate do **Voucher de Parceiro** — `reload.recargagames.com`.

O usuário digita o código do voucher, vê os conteúdos do lote, preenche o
formulário (quando for entrega direta) e confirma o resgate.

**Estado atual: Brief 3.** O resgate é real: o voucher é travado de forma
atômica, a order é criada na Lapak via proxy, o app acompanha o desfecho e
mostra o PIN na tela quando a entrega é por código. Custos e dado pessoal são
persistidos, e um job de reconciliação fecha o que ficou pelo caminho.

---

## Stack

| Camada | Decisão |
|---|---|
| Front | HTML + CSS + JS vanilla em `public/`. **Sem framework, sem build step.** |
| Back | Netlify Functions (API v2, ESM) em `netlify/functions/` |
| Banco | Supabase `ashmirzgyuhspymldpfv` — o mesmo da loja/admin, tabelas `pv_*` |
| Fornecedor | Lapak, **sempre** via proxy `api.recargagames.com` (`PROXY_RELOAD_KEY`) |
| Host | Netlify, site próprio, CD por push na `main` |
| DNS | subdomínio `reload` gerenciado **no Netlify** (não no GoDaddy) |

Mesmo padrão de casa do `recargagames-offerwall`. Nenhuma dependência npm em
produção — o `package.json` só existe pelos scripts de teste.

## Estrutura

```
public/                 ← ISSO é o que vai pro ar (publish dir)
  index.html            as 5 telas, alternadas por [hidden]
  app.js                estado + chamadas de API (sem inline script, por CSP)
  styles.css            tokens da identidade visual
netlify/functions/
  validate.mjs          POST /api/validate  — leitura, valida o código
  redeem.mjs            POST /api/redeem    — claim + create (gasta dinheiro)
  status.mjs            POST /api/status    — acompanha e fecha o resgate
  reconcile.mjs         Scheduled, 15/15min — resolve o que ficou pra trás
lib/                    módulos server-side (fora de functions/ de propósito)
  http.mjs              CORS, JSON, hash de log, IP do cliente
  supabase.mjs          REST com a Secret key
  rate-limit.mjs        contador por IP em pv_validate_rate (2 baldes)
  vouchers.mjs          busca + avaliação de voucher (SÓ LEITURA)
  forms.mjs             SKU → categoria → campos, trava SKU × tipo, validação
  redeem.mjs            claim atômico, trilha de tentativas, fechamento
  lapak.mjs             cliente do proxy: create, order_status, parsing do PIN
forms-map.json          mapa estático de formulários e de tipo de entrega
migrations/             SQL aplicado manualmente no Supabase
tests/                  suíte com Supabase e Lapak stubados + harness local
```

`publish = "public"` garante que `forms-map.json`, `migrations/` e `lib/`
**não** sejam servidos publicamente.

## Fluxo do resgate

```
POST /api/redeem
  1. rate limit          10/IP/10min (mesmo balde do validate)
  2. valida payload      + TRAVA SKU × delivery_type
  3. CLAIM ATÔMICO       EMITIDO → PROCESSING   ← única barreira antidupla
  4. attempt no banco    antes da Lapak, com dado pessoal e ip_hash
  5. create na Lapak     UMA vez, sem retry, jamais
  6. grava tid + custo   (IDR da resposta + conversão pelo snapshot de FX)
  → { status: "processing", attempt_ref }

POST /api/status  (front consulta de 3 em 3s, teto de 5 min de tela)
  consulta order_status quando pendente (throttle de 3s por attempt)
  SUCCESS  → voucher USADO + PIN na resposta (quando for entrega por código)
  REFUNDED → attempt error + voucher volta pra EMITIDO
  PENDING  → segue esperando

reconcile.mjs  (a cada 15 min)
  vouchers PROCESSING com tentativa de +5 min: consulta e resolve.
  NUNCA cria order.
```

Por que o desfecho não vem na mesma request: o PIN **não** existe no create.
Ele só aparece no `order_status`, em `data.data.transactions[i].voucher_code`,
como a string `"PIN : <pin>\tSerial : <serial>"` (separador TAB). Achado do
teste A0, em produção.

## Env vars (painel Netlify deste site — nunca no repo)

| Var | Valor |
|---|---|
| `SUPABASE_URL` | `https://ashmirzgyuhspymldpfv.supabase.co` |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` (bypassa RLS; só server-side) |
| `IP_HASH_SALT` | string aleatória longa e **fixa** (trocar zera os contadores de rate limit e os hashes de log) |
| `PROXY_RELOAD_KEY` | chave do proxy com escopo do app de resgate (Brief 3.0) |
| `LAPAK_ENV` | `prod` ou `dev`. **Obrigatória, sem default** — o proxy assume `dev` quando o header falta, e uma order em `dev` marcaria o voucher como usado sem entregar nada |
| `FX_USD_IDR` | opcional. Quantos IDR valem 1 USD (snapshot) |
| `FX_BRL_USD` | opcional. Quantos BRL valem 1 USD (snapshot) |
| `REDEEM_ENABLED` | opcional. `false` desliga o resgate **sem deploy** (interruptor de pânico). Ausente = ligado |

Sem `FX_*` o resgate acontece normalmente e só `cost_usd`/`cost_brl` ficam
nulos — `cost_idr`, que é o número que a Lapak devolve, é gravado sempre.

O front não usa nenhuma chave — nem do Supabase, nem do proxy. Toda conversa
com banco e fornecedor passa pelas functions.

Gerar o salt: `openssl rand -hex 32`

## Migrations

Aplicar colando no SQL Editor do Supabase, na ordem. Cada arquivo tem, no fim
e comentados, os testes de RLS como `anon` e o rollback.

1. `2026-07-30-pv-validate-rate.sql` — tabela `pv_validate_rate` + função de
   incremento atômico `pv_validate_rate_hit()`.
2. `2026-07-31-pv-redeem.sql` — colunas de persistência do resgate em
   `pv_redeem_attempts` (dado pessoal, custo, câmbio) + índices + a função
   **`pv_redeem_claim()`**, que é o flip atômico do voucher.

**As duas são pré-requisito.** Sem a primeira, o rate limit falha e tudo
responde 503 (fail-closed, de propósito). Sem a segunda, o `/api/redeem`
responde 503 no claim e nenhum resgate acontece.

## Rodar local

```bash
npm test                # 88 testes, sem rede, sem banco e sem Lapak
npm run check:secrets   # grep de secrets/SKU/credencial no bundle público
npm run check           # os dois

node tests/dev-server.mjs   # http://localhost:8000
```

O `dev-server.mjs` serve o front real e roteia `/api/*` pras **functions
reais**, com o `fetch` global stubado — Supabase falso e **Lapak falsa**.
Nenhuma order é criada, nenhum centavo é gasto. A Lapak falsa responde
`PENDING` nas duas primeiras consultas e `SUCCESS` depois, então dá pra ver a
tela de entrega em andamento e a do PIN de verdade.

| Código | Cenário |
|---|---|
| `RLBK-VALIDO0001` | lote válido, 1 DTU + 1 PIN |
| `RLBK-SODTU00001` | só DTU |
| `RLBK-SOPIN00001` | só PIN → exercita a tela do PIN |
| `RLBK-USADO00001` | voucher usado → mensagem genérica |
| `RLBK-CANCEL0001` | voucher cancelado → mensagem genérica |
| `RLBK-VENCIDO001` | lote vencido → mensagem genérica |
| `RLBK-PROCESS001` | resgate em andamento → mensagem específica |
| `RLBK-SKUNOVO001` | 1 SKU mapeado + 1 fora do forms-map → só o mapeado aparece |
| `RLBK-SOSKUNOVO1` | só SKU fora do forms-map → mensagem genérica |
| `RLBK-SKUTROCAD1` | SKU de PIN cadastrado como DTU → recusado pela trava |
| `RLBK-ERROLAPAK1` | fornecedor recusa → voucher volta a valer, dá pra escolher outro |
| `RLBK-TIMEOUT001` | timeout no create (ambíguo) → voucher fica em PROCESSING |
| qualquer outro | inexistente → mensagem genérica |

CPF de teste válido: `111.444.777-35`. Inválido: `111.444.777-36`.

`GET /dev/reset` zera o estado local. `GET /dev/reconcile` roda o job de
reconciliação na hora, sem esperar 15 minutos.

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

O que é persistido: `email`, `cpf` (só dígitos), `marketing_optin` e `ip_hash`
vão pras colunas de `pv_redeem_attempts`; o dado de **entrega** (`user_id`) vai
pro `player_data` do voucher. O IP cru não é gravado em lugar nenhum.

## Decisões de segurança (não afrouxar sem conversa)

- **Resposta de erro é sempre a mesma** (`invalid_or_unavailable`) pra código
  inexistente, usado, cancelado, vencido e lote cancelado. Diferenciar daria
  oráculo pra brute force. A única exceção é `PROCESSING`, porque o usuário
  legítimo precisa saber que o resgate dele está em curso.
- **O claim atômico é a única barreira contra resgate duplicado.** O create da
  Lapak não aceita referência externa (A0), então o fornecedor não deduplica
  nada. Quem não ganha o `pv_redeem_claim()` não chama a Lapak. Nunca inverter
  a ordem "trava primeiro, pede depois".
- **Nunca existe retry automático de create.** Falhou, para e reporta.
- **Falha de create se divide em duas categorias.** `definitive` (o proxy negou
  a chave, ou a Lapak respondeu com código de erro) devolve o voucher pra
  EMITIDO. `ambiguous` (timeout, 500 do proxy, 5xx da Lapak) **não devolve**: a
  order pode existir, e liberar seria arriscar cobrar e entregar duas vezes. O
  voucher fica em PROCESSING e vira alerta pra conferência manual.
- **Status desconhecido da Lapak nunca libera o voucher.** A lista de status
  terminais é branca (`REFUNDED` e afins); qualquer coisa fora dela continua
  esperando.
- **`product_code` (SKU Lapak) nunca vai pro front.** O front escolhe conteúdo
  por `id` de `pv_batch_contents`; o mapeamento id → SKU fica no servidor. Sem
  isso o catálogo do parceiro seria enumerável.
- **Trava SKU × delivery_type.** O admin não valida se o SKU cadastrado é mesmo
  do tipo declarado — um lote de teste já teve SKU de voucher cadastrado como
  DTU. `sku_delivery_patterns` no `forms-map.json` decide o tipo verdadeiro, e
  SKU sem regra é **recusado nos dois tipos** (`unknown_sku_delivery: refuse`).
  A recusa acontece antes do claim: cadastro errado não consome voucher.
- **SKU DTU fora do `forms-map.json` é recusado** (`fallback_category: null`),
  não cai em formulário genérico. Recusa o conteúdo, não o lote.
- **Rate limit é fail-closed** e tem dois baldes: 10/IP/10min pro
  validate+redeem, 150/IP/10min pro status (o polling legítimo é de ~100
  chamadas por resgate). O throttle de 3s por attempt, no banco, é o que
  protege o fornecedor.
- **PIN nunca é gravado nem logado.** Ele passa em memória pela function, sobe
  na resposta e acabou. A reexibição por 24h rebusca na Lapak pelo tid.
- **Log nunca tem código completo**: só os 4 primeiros chars + HMAC curto
  (HMAC, não SHA nu, pra que o log não seja reversível por força bruta). O
  `attempt_ref` também não vai pra log — ele carrega o código dentro dele.
- **Log nunca tem email, CPF, `user_id` ou IP** — só os *nomes* dos campos
  preenchidos.
- **CORS restrito** ao domínio canônico + same-origin do deploy que atendeu a
  request. `localhost` só entra em contexto `dev`.
- **A chave admin do proxy não existe neste repo.** O app usa a
  `PROXY_RELOAD_KEY`, que tem escopo próprio e é revogável sozinha;
  `tests/check-secrets.sh` reprova se alguém introduzir a admin.

## Deploy e emergência

Push na `main` → Netlify publica.

- **Desligar o resgate sem deploy:** `REDEEM_ENABLED=false` no painel. O
  endpoint volta a responder manutenção e não toca em nada.
- **Rollback de código:** `git revert` + push (Netlify republica em ~30s).
- **Voucher preso em PROCESSING:** a reconciliação resolve em até 20 min. Se
  ficar (caso ambíguo, sem tid), o log diz `conferência manual` — procure a
  order no painel da Lapak pelo horário e pelo SKU antes de mexer no voucher à
  mão.
- **Rollback do banco:** bloco comentado no fim de cada migration.

Loja, admin e proxy não são tocados por este repo.
