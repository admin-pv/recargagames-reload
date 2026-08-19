# Playvision — Log de Sessão 2026-08-19 (Reload / Briefs 6 e 5)

**Foco:** dois briefs no mesmo dia — **Brief 6** (mapeamento SKU →
`delivery_type` em tabela) e **Brief 5** (emails transacionais via Resend).
**Modo:** cuidado nos dois (o 6 toca a trava que decide o tipo da order; o 5
toca dado pessoal e o PIN).
**Repo:** `admin-pv/recargagames-reload`.
**Motivador comum:** campanha da Plusmo (mercado MX, Minecraft e Roblox, só
PIN). O 6 tira o cadastro de SKU do deploy; o 5 tira o PIN da dependência de uma
aba aberta. Sem os dois, a campanha não roda.

> **Estrutura:** §1–§9 são o Brief 6; §10–§13, o Brief 5. §14 e §15 fecham o dia.

---

## Resumo executivo

- **Entregue e em produção.** O catálogo SKU → PIN/DTU saiu do `forms-map.json` e
  virou a tabela `pv_sku_delivery_map`. PR #4, merge `235d3d7`.
- **Cadastrar jogo novo deixou de ser deploy e virou `INSERT`.** Era o objetivo
  do brief: a Plusmo vai mandar denominações de dois jogos que ainda não existem
  no nosso mundo, e um deploy por SKU não se sustenta.
- **O fail-closed não afrouxou em lugar nenhum** — ficou mais estrito em dois
  pontos (§3).
- **Gasto: zero.** Nenhuma order foi criada nesta sessão. Os dois critérios de
  pronto foram provados sem tocar em dinheiro (§7).
- Migration `2026-08-19-pv-sku-delivery-map.sql` aplicada e conferida **antes**
  do merge, com a resolução do Free Fire provada em SQL.
- **122 testes** (+24), `check:secrets` limpo.
- **Brief 5 também entregue e em produção** (§10–§13): boas-vindas e entrega do
  PIN por email, bilíngue, com links por parceiro. PR #5, merge `22c348e`.
- **E2E do Brief 5 aprovado com order real:** dois emails na caixa, **DKIM
  pass**, voucher `USADO`, e todas as colunas de auditoria no gabarito.
  Custo: **1 order, 12.251 IDR (R$3,4611)** — o único gasto do dia.
- **158 testes** no fim do dia (98 no começo).

---

## 1. O que mudou

```
lib/sku-map.mjs        NOVO — regra de match (pura) + leitura da tabela
lib/forms.mjs          recebe o mapa por parâmetro; continua sem falar com banco
lib/lapak.mjs          createOrder aceita endUserIp → end_user_ip_address
netlify/functions/     validate, redeem e status carregam o mapa por request
forms-map.json         perdeu sku_delivery_patterns e unknown_sku_delivery
migrations/2026-08-19-pv-sku-delivery-map.sql
```

A tabela: `sku_pattern`, `delivery_type` (CHECK PIN/DTU), `requires_ip`, `notes`,
`created_at`. RLS admin-only via `is_admin()`; `service_role` com `SELECT` e mais
nada — o redeemer só lê.

---

## 2. A decisão central: prefixo, match mais longo ganha

**O problema que ela resolve.** A lista antiga era ORDENADA e a ordem era uma
armadilha: `^FFBV` **tinha** que vir antes de `^FF`, senão todo voucher de Free
Fire seria classificado como top-up e a trava inverteria de sinal — cartão de PIN
saindo como recarga por ID, com dinheiro real e sem reembolso.

Mover isso para o banco sem cuidado teria **piorado** o risco: com uma coluna de
`priority`, o mesmo erro voltaria a ser possível, agora via `INSERT` no SQL Editor,
por quem estivesse com pressa e sem contexto.

**A escolha:** `sku_pattern` é prefixo, e o mais longo ganha. `FFBV` (4 chars)
vence `FF` (2) sozinho. A ordem correta virou **propriedade dos dados**, não
disciplina do operador.

Três consequências que valem registro:

- **SKU exato é o caso degenerado** (o prefixo é o SKU inteiro). O brief pedia
  "prefixo ou SKU exato"; a mesma coluna atende os dois, sem modo nem flag.
- **Empate é impossível por construção.** Dois patterns do mesmo tamanho que
  casem com o mesmo SKU seriam a mesma string, e o `UNIQUE` barra. Não existe SKU
  com dois vencedores.
- **`CHECK` de canonicidade** (caixa alta, sem espaço, mínimo 2 chars). O mínimo
  não é frescura: um pattern de 1 char (`F`) nunca venceria de um mais longo, mas
  passaria a resolver qualquer SKU **desconhecido** começando com a letra — o
  curinga que engoliria o fail-closed. O código repete a checagem como segunda
  camada, para o caso de a constraint ser afrouxada à mão.

Alternativas descartadas: **só SKU exato** (uma linha por denominação; sem risco
de over-match, mas exigiria o catálogo completo da Plusmo antes da campanha) e
**prefixo + `priority`** (devolveria ao operador exatamente o erro que a regra de
tamanho elimina).

---

## 3. O fail-closed ficou mais estrito, não menos

Duas mudanças que valem mais que a migração em si:

**1. Sumiu a chave `unknown_sku_delivery`.** No `forms-map.json` existia um
`"refuse"` que virava `"allow"` com uma edição de um caractere. Agora não há
chave: afrouxar exige mudar `lib/sku-map.mjs`, com revisão de código.

**2. Falha ao LER o catálogo é 503, nunca "segue sem o mapa".** Foi decisão
explícita contra a alternativa tentadora — manter o `forms-map.json` como cópia
de emergência para o app continuar resgatando Free Fire durante um incidente.
Recusada porque duas fontes de verdade fariam o tipo de entrega de um SKU mudar
**em silêncio** justamente quando ninguém está olhando. E o custo de
disponibilidade é menor do que parece: a leitura vai para o mesmo Supabase que a
request já consulta, então se ele cair, o voucher também não é encontrado.

No `/api/redeem` esse 503 acontece **antes do claim** — falha de infra nossa não
consome voucher.

Linha malformada na tabela (tipo fora de PIN/DTU, pattern curto) é **descartada,
não interpretada**: adivinhar a intenção seria pior que ignorar. Descartada, cai
no fail-closed; interpretada, viraria uma order.

---

## 4. O achado do FFLATAM

Ao migrar o mapa, a linha `^FFLATAM → DTU` parecia descartável: sob a regra de
"mais longo ganha", `FFLATAM…` resolveria DTU pelo `FF` de qualquer forma. A
regra é **redundante para a resolução**.

Mas ela não estava ali pela resolução. Estava carregando isto, num campo `note`
do JSON:

> Free Fire Latam **EXCLUI o Brasil** (achado do A0). Não usar em lote
> brasileiro — com `check_id` OFF, **cobra sem entregar**.

Ou seja: um aviso operacional de perda financeira estava vivendo como comentário
dentro de um arquivo de configuração, sobrevivendo por acidente. Uma migração
"limpa", que removesse o redundante, teria apagado a única memória escrita disso
no repo.

A linha foi mantida no seed, e o aviso foi para a coluna `notes` da tabela — onde
fica visível para quem for cadastrar SKU novo, que é exatamente quem precisa
dele. **Lição:** ao mover configuração de lugar, o que parece comentário morto
pode ser a única cópia de um achado caro. Conferir o *porquê* de cada linha antes
de decidir que ela é redundante.

---

## 5. Descobertas durante a implementação

- **Havia um terceiro consumidor que o brief não citava.** `status.mjs` usava
  `expectedDeliveryType()` para decidir se a tela exibe PIN. O `|| "DTU"` de
  fallback continua sendo o conservador: SKU que sumiu do catálogo entre o
  resgate e a consulta não vira "mostra o PIN" — sem PIN na tela o portador
  recorre ao suporte; com PIN errado na tela, não há volta.
- **O proxy não precisou de mudança.** Ele repassa `req.body` verbatim
  (`server.js:586`), sem whitelist de campos, então `end_user_ip_address` chega
  na Lapak direto. E loga só método, URL e status — o IP não vaza lá.
- **A resolução virou assíncrona.** `expectedDeliveryType()` era síncrona e
  rodava em loop no `/api/validate`. A solução foi carregar o mapa **uma vez por
  request** e injetá-lo, mantendo `forms.mjs` puro e testável sem banco.
- **Sem cache, de propósito.** A tabela é minúscula e a leitura vai para o mesmo
  Supabase já consultado. Cache em memória de function é servido por container e
  expira sem hora marcada — durante um incidente ("corrigi a linha errada, por
  que não pegou?") isso vira tempo perdido. Se o volume justificar, o lugar do
  TTL é `lib/sku-map.mjs`, e só ali.
- **O catálogo não é lido para código inválido.** Quem varre códigos não ganha
  uma leitura extra de banco por tentativa.

---

## 6. `requires_ip` — a porta do IP cru

Fica na tabela, por linha, `default false`. Ligada, o create leva
`end_user_ip_address` (caso Hoyoverse: Genshin, Zenless, HSR).

O IP é **usado e descartado**: mora no corpo daquela request e em lugar nenhum
mais. Não vai para log — o log registra o **booleano** `requires_ip`, que
documenta que o IP foi enviado sem dizer qual —, não tem coluna, e no banco
continua existindo só o HMAC. Um teste prova que a flag só liga com boolean
`true`: nem `"true"`, nem `1`. Mandar IP para o fornecedor é decisão de LGPD, não
acidente de tipagem.

---

## 7. Validação

**Suíte:** 122 testes (de 98), Supabase e Lapak stubados. Além da regressão dos
dois fluxos FF, os testes novos cobrem: mais-longo-ganha **com a ordem das linhas
embaralhada**, SKU exato vencendo a família, case-insensitive, SKU sem match,
catálogo vazio, catálogo ilegível → 503 sem claim e sem order, `requires_ip` no
corpo do create **e a ausência dele nos SKUs vizinhos do mesmo lote**, IP fora de
log e de coluna, e o SKU trocado do Brief 2 §8.2 seguindo recusado.

**Harness local:** `validate → redeem PIN → polling → PIN na tela`, ponta a
ponta, com o catálogo vindo da tabela.

**SQL Editor, antes do merge:** RLS provada como `anon` (`42501` no INSERT — o
teste que mais importa, porque quem escreve nessa tabela decide se um SKU entrega
PIN ou top-up), CHECKs de canonicidade barrando caixa baixa / 1 char / tipo
inválido, e a resolução do Free Fire conferida em SQL.

**Deploy preview, antes do merge:** foi aqui que se cobriu o único ponto que a
suíte não alcança — se a Secret key do Netlify realmente lê a tabela nova depois
do `REVOKE ALL … FROM service_role; GRANT SELECT`. Nenhum teste local prova isso,
e no SQL Editor a sessão é `postgres`, que bypassa tudo. Um código de teste
conhecido devolveu os dois conteúdos FF: leitura OK.

**Produção, pós-merge:** ambos os critérios de pronto do brief, sem gastar nada.

- *Caminho feliz:* lote de teste existente (prefixo `ATT-`) devolvendo os dois
  conteúdos Free Fire. Regressão do Brief 3 preservada.
- *Fail-closed:* lote descartável `RLBK-B6TESTE001`, com dois SKUs fictícios
  (`ZZTESTPIN-b6` e `ZZTESTDTU-b6`, um PIN e um DTU). Resultado no gabarito —
  mensagem genérica na tela, `unmapped_delivery_sku` duplo no log com o código
  mascarado, voucher `EMITIDO` com `redeemed_at` e `order_ref` nulos, zero
  linhas em `pv_redeem_attempts`.

O lote de teste foi construído **só com SKUs fictícios**, de propósito. Um lote
misto (1 FF válido + 1 inventado) tornaria a recusa parcial visível no browser
sem depender de log, mas deixaria um conteúdo **realmente resgatável** na tela —
e um clique errado vira order com dinheiro. A recusa parcial já está coberta pela
suíte (`RLBK-SKUNOVO001`); não valia reprovar em produção a esse custo. Prefixo
`ZZTEST` para o lote nunca virar resgatável por acidente quando os SKUs da
Plusmo forem cadastrados.

---

## 8. Ordem de aplicação (o risco operacional do brief)

O redeemer novo lê **só** da tabela. Se o código subir antes dela existir ou com
ela vazia, todo SKU vira `unmapped_delivery_sku` e o resgate para inteiro.

Nenhum voucher é queimado nesse cenário — a recusa acontece antes do claim — mas
o app fica inútil até o seed rodar. Por isso a sequência foi: **migration →
conferência em SQL → preview → merge**. Na ordem certa não há janela nenhuma: a
tabela fica ociosa até o deploy, porque nada mais no banco a consulta.

**Rollback:** revert do PR. A tabela fica órfã, sem efeito, pronta para nova
tentativa. O `DROP TABLE` está comentado no fim da migration e só faz sentido
*depois* de reverter o código.

---

## 9. O que mudou na rotina

**Cadastrar SKU novo não é mais tarefa de código.** É `INSERT` em
`pv_sku_delivery_map` — jogo novo, denominação nova, mercado novo. O §5 da
migration tem o passo a passo, um exemplo pronto e as armadilhas (confirmar o
`variant` no catálogo da Lapak **antes** de inserir; preferir o prefixo mais
específico que cubra a família, porque quanto mais curto, mais chance de capturar
um jogo futuro por acidente).

Até o CRUD do admin existir (Brief 4), o INSERT é manual no SQL Editor.

**Novo sintoma em `CLAUDE.md` §10:** "tudo virou `invalid_or_unavailable` de uma
vez, sem 503" = a tabela está legível mas vazia, ou perdeu as linhas de FF. É o
fail-closed funcionando; re-rodar o seed do §3 da migration.

---

## 10. Brief 5 — o que foi construído

```
lib/mailer.mjs           envio via Resend. NUNCA lança — falha vira { ok: false }
lib/email-templates.mjs  templates pt-BR / es-MX. Funções puras
lib/notify.mjs           decide, monta, manda e registra os dois emails
migrations/2026-08-19-pv-emails.sql
```

Cinco colunas novas: `pv_batches.locale` e `.site_host`;
`pv_vouchers.welcome_email_at`; `pv_redeem_attempts.pin_email_due` e
`.pin_email_at`. Mais um índice parcial na fila.

**Infra que já estava pronta antes do código:** domínio `Verified` no Resend e
`RESEND_API_KEY` no Netlify.

**A armadilha da chave, que continua valendo:** no plano Free do Resend ela é
*secret* e **por contexto**. Rotacionar exige trocar em **Production E em Deploy
Previews, separadamente**. Esquecer o preview deixa key revogada rodando no
ambiente onde justamente se testa antes de subir.

É a mesma família de pegadinha do commit `1385717` (`redeploy do preview para
pegar LAPAK_ENV=prod`): env var nova não alcança um preview já publicado.
**Regra geral:** mexeu em env var, pergunte "em quais contextos?" e "quais
deploys precisam ser republicados?".

---

## 11. Brief 5 — as quatro decisões

**1. A regra que governa tudo: falha de email nunca falha o resgate.** Nenhuma
função de `mailer.mjs` ou `notify.mjs` lança. Chave ausente, Resend fora do ar,
timeout e erro HTTP devolvem `{ ok: false }`. Não é convenção: com a Resend
mockada em 500, o teste exige que o resgate conclua, o voucher vire `USADO` e o
PIN apareça na tela. O portador já pagou; o email é cortesia.

**2. O grão das duas flags é diferente — o brief sugeria as duas no attempt.**

- *Boas-vindas* → `pv_vouchers.welcome_email_at`. "Uma vez por voucher" não
  sobrevive no attempt: um create recusado devolve o voucher para `EMITIDO` e a
  retentativa mandaria um "bem-vindo" novo. A coluna é também a trava de
  concorrência (`UPDATE … WHERE welcome_email_at IS NULL`), mesma mecânica do
  claim atômico.
- *Email de PIN* → `pin_email_due` (fila) + `pin_email_at` (auditoria). Duas
  colunas porque, com só `pin_email_at IS NULL` como fila, todo resgate DTU
  ficaria pendente para sempre, engordando índice e varredura com linhas que
  nunca saem.

**3. O gatilho do boas-vindas mudou depois da revisão.** Começou no sucesso do
claim, como o brief pedia. Movido para **depois de o create resolver**, porque no
lugar antigo um create recusado devolvia o voucher com o portador já tendo
recebido "recebemos seu resgate" — email de uma compra que não aconteceu.

O critério não é "deu certo", é **"o voucher foi consumido"**:

| Desfecho do create | Manda? | Por quê |
|---|---|---|
| Sucesso | sim | existe order |
| Ambíguo (timeout) | **sim** | a order pode existir, o voucher fica em `PROCESSING` e não volta ao portador — "estamos processando" é o estado literal dele |
| Definitivo | **não** | nada foi criado, o voucher volta a valer |

O caso ambíguo é o que impediu de usar "só no sucesso": ali o portador teve o
voucher consumido e ficaria sem aviso nenhum — o silêncio que o brief quer
eliminar. Um dos testes verifica a **ordem das chamadas**, não só o resultado: se
alguém mover o disparo de volta para cima, ele quebra mesmo com o create OK.

**4. O hostname dos links vem do banco, nunca do header `Host`.** Pedido em
revisão: o link do rodapé não pode ser fixo em `reload.recargagames.com`, porque
um resgate do lote da Plusmo mandaria o portador para um site que ele nunca viu.

Seria natural usar o `Host` da requisição — é literalmente "de onde veio o
resgate". **Não foi.** Esse header é controlado por quem chama, e o
`/api/redeem` aceita request sem `Origin` (curl). Um `Host: evil.com` forjado
colocaria um link de phishing dentro de um email assinado com o **nosso DKIM**.
Vindo de `pv_batches.site_host`, o valor é escrito por admin e nunca pelo
visitante.

Como ele vira `href`, há duas camadas: `CHECK` de formato na coluna (só hostname
— sem esquema, barra, porta ou aspas) e `resolveSiteHost()` no template, que
devolve o default para qualquer coisa malformada. O teste passa 11 entradas
hostis, incluindo tentativa de escapar do atributo e esquema `javascript:`.

O **branding visual segue Recarga Games para todos**; o que varia é o destino do
link.

---

## 12. Brief 5 — o achado, e o que ele economizou

`orderStatus()` devolve `{status, pin, serial}`, e a reconciliação **já lia isso
e descartava o PIN** (`reconcile.mjs:108`, comentário explicando que "não há
ninguém na tela").

Ou seja: o caso que motivou o brief inteiro — portador fechou a aba, o job fecha
o resgate sozinho — passou a mandar o email **sem nenhuma chamada extra ao
fornecedor**. Um teste garante que a Lapak é consultada exatamente uma vez.

**O retry precisou de fila própria** por uma razão que só aparece olhando o
estado: quando o email de PIN falha, o voucher **já está `USADO`**, e
`listProcessingVouchers()` não o enxerga mais. Daí a segunda varredura na
reconciliação, alimentada pelo `pin_email_due`.

Janela de **24h**, a mesma da reexibição na tela. Deliberado: passado isso o
código sai de cena em **todos** os canais. Um caminho que ressuscitasse PIN dias
depois seria uma regra a mais para lembrar e uma superfície a mais para errar.

---

## 13. Brief 5 — PII, e a primeira flexibilização da regra do PIN

Três coisas mudaram de superfície e ficam registradas:

**1. O endereço do portador passou a circular em `status.mjs` e
`reconcile.mjs`** (entrou no `ATTEMPT_SELECT`). Eram caminhos limpos de PII.
Contramedida: log recebe só o **domínio** (`recipientDomain()`), que responde
"está falhando só num provedor?" sem identificar ninguém.

**2. O corpo de erro da Resend não é lido.** Em 422 ela ecoa o destinatário na
mensagem. Há teste que **falha** se alguém passar a lê-lo.

**3. O PIN em claro no email é a primeira flexibilização real** da regra "PIN não
é persistido em lugar nenhum" (§5.6 do `CLAUDE.md`). Ele agora existe na infra da
Resend e na caixa do portador — dois lugares fora do nosso controle. Foi a troca
aceita para matar o chamado nº 1 previsto para a campanha. Continua sem coluna,
sem log e sem cache nosso. Está registrado no `CLAUDE.md` como troca deliberada,
não como esquecimento — para que ninguém "descubra" isso depois achando que foi
descuido.

**Emails transacionais não dependem de `marketing_optin`.** O optin governa
marketing futuro; confirmação de resgate e entrega de código são execução do que
a pessoa pediu. O E2E foi feito com o optin **desmarcado**, provando isso na
prática.

**Lacuna fechada:** `tests/check-secrets.sh` passou a conhecer `RESEND_API_KEY` e
o prefixo `re_` — pendência que o próprio log do Brief 6 tinha registrado horas
antes. Verificada por **teste negativo**: com uma chave falsa em `public/`, o
checklist reprova.

---

## 14. Brief 5 — validação e o E2E

**158 testes** no fim do dia, contra 98 no começo. `check:secrets` limpo.

O que os testes novos cobrem, além dos templates: mailer que nunca lança
(timeout, rede morta, 401/422, destinatário inválido); os três desfechos do
create; email uma vez por voucher; DTU sem email de PIN; Resend em 500 sem
afetar resgate; chave ausente sem afetar resgate; PIN, serial, endereço e chave
fora do log; reconciliação mandando o email do abandono de tela; reenvio da
fila; janela de 24h barrando reenvio tardio; hostname do parceiro atravessando
lote → email; 11 hostnames hostis.

**Teste de falha em preview: dispensado por decisão do owner.** O raciocínio
registrado: as duas provas locais (500 mockado e chave ausente) exercitam o mesmo
caminho de código, o isolamento por try/catch é estrutural, e se o envio falhar
no E2E real o comportamento é idêntico ao que o teste provaria — com a fila
recuperando. Fica anotado que a decisão foi consciente, não esquecimento.

**E2E em produção, com order real — aprovado integralmente:**

| Item | Resultado |
|---|---|
| Emails | Boas-vindas + entrega do PIN, ambos na caixa |
| DKIM | **pass** |
| Voucher | `USADO`, `order_ref` preenchido |
| `welcome_email_at` | preenchido |
| `pin_delivered` | `true` (tela) |
| `pin_email_due` / `pin_email_at` | `false` / preenchido (email) |
| Custo | **12.251 IDR = R$3,4611** |

As duas últimas linhas são o par que justifica o desenho: `pin_delivered` mede a
**tela**, `pin_email_at` mede o **email**. Canais separados, colunas separadas —
os dois caminhos de entrega funcionaram de forma independente, sem sobrecarregar
o significado de `pin_delivered`.

**O número do custo é o primeiro dado real de uma order PIN isolada** (o log de
31/07 tinha 3 orders somadas, misturando DTU e PIN). R$3,46 por cartão de 100
diamantes é a base para a conta da campanha da Plusmo.

---

## 15. Fechamento

**Brief 6.** Lote de teste `RLBK-B6TESTE001` e seus dois conteúdos fictícios
**descartados** (o batch leva os conteúdos junto por `ON DELETE CASCADE`).
Nenhuma linha em `pv_redeem_attempts` para limpar — nenhuma tentativa chegou a
nascer, que era exatamente o ponto do teste.

**Brief 5.** Lote `RLBK-B5E2E00001` **cancelado, não apagado**. A diferença
importa: o voucher está `USADO` e carrega o `order_ref` de uma order que foi
**paga de verdade**. Apagar a linha apagaria a trilha dessa order — mesmo motivo
pelo qual os `USADO` dos lotes de teste do Brief 3 foram preservados em 31/07.
Cancelar o lote basta para tirá-lo de circulação: `pv_redeem_claim()` exige
`batch.status = 'active'`.

**Gasto do dia: 1 order, 12.251 IDR (R$3,4611).** Todo o resto foi provado sem
tocar em dinheiro.

**Dado pessoal coletado:** o email do Vinicius no E2E, gravado em
`pv_redeem_attempts.email` como qualquer resgate. Optin de marketing desmarcado.

**Códigos de voucher neste log:** só os dos lotes descartáveis
(`RLBK-B6TESTE001`, `RLBK-B5E2E00001`), ambos fora de circulação. O código do
lote vivo usado no caminho feliz do Brief 6 **não foi registrado** — código de
voucher é segredo ao portador, e aqui vale a mesma regra do log de produção.

---

## 16. Próximos passos

- **Cadastrar os SKUs da Plusmo** quando as denominações chegarem (Minecraft e
  Roblox, MX, só PIN). É `INSERT`, sem deploy. Confirmar o `variant` no catálogo
  da Lapak antes de cada linha.
- **Brief 4:** CRUD da tabela no admin (`recargagames-admin`). Atenção: o painel
  deve escrever como `authenticated` + `is_admin()`, **não** com a Secret key —
  o `service_role` tem só `SELECT` nesta tabela, e um `42501` ali é o desenho,
  não um bug.
- **Brief 7** (locale `es-MX`, remoção de CPF, reskin). Dois pontos que este dia
  deixou preparados e um que ele descobriu:
  - `pv_batches.locale` e `.site_host` já existem e já atravessam até o email. O
    Brief 7 pode sobrescrever o locale com o do site; a coluna vira fallback.
  - **CORS é o ponto aberto.** Se o site da Plusmo ficar em domínio próprio *e*
    chamar nossa API cross-origin, o `lib/http.mjs:12` barra — `CANONICAL_ORIGIN`
    é fixo e a allowlist não conhece parceiro. Servido do mesmo host (subdomínio
    nosso ou site Netlify próprio), o `selfOrigin` já resolve. É decisão de
    arquitetura, e é melhor tomá-la antes de escrever o Brief 7.
- **Reenvio self-service do email** pelo portador: o brief mandou avaliar no
  fechamento. Hoje a recuperação é a tela (24h) ou o suporte. Vale só se os
  chamados aparecerem — a fila automática já cobre a falha técnica.
- Segue valendo o item do log anterior: alertar quando `unmapped_sku`,
  `unmapped_delivery_sku`, `sku_delivery_mismatch` ou `all_contents_refused`
  aparecerem no log. São sempre erro nosso de cadastro, nunca do usuário — e
  agora o conserto de um deles é uma linha de SQL, não um deploy.
