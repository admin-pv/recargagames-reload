#!/usr/bin/env bash
# Checklist de segurança do repo, automatizado.
#
# 1) Nada de secret no bundle público (public/ é o que o Netlify publica).
# 2) A chave do PROXY não aparece no front — nem o nome, nem o header.
# 3) PROXY_ADMIN_KEY não existe neste repo: o app de resgate usa a
#    PROXY_RELOAD_KEY, que tem escopo próprio e é revogável sozinha.
#    Introduzir a admin key aqui daria ao app público um credencial que
#    derruba a loja inteira se vazar.
# 4) Nenhum SKU/product_code no front.
# 5) A chave da Resend (Brief 5) não vaza pro bundle público — nem o nome
#    da env var, nem um valor com a cara de key (re_...).
#
# Rodar: bash tests/check-secrets.sh   (ou npm run check:secrets)
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { printf '  %s %s\n' "$1" "$2"; }

echo "→ 1. secrets no bundle público (public/)"
for pattern in 'sb_secret' 'SUPABASE_SECRET_KEY' 'IP_HASH_SALT' 'service_role' 'eyJhbGciOi' 'RESEND_API_KEY'; do
  if grep -rIn --exclude-dir=.git -- "$pattern" public/ >/dev/null 2>&1; then
    report "✗" "ENCONTRADO '$pattern' em public/ — abortar deploy"
    grep -rIn --exclude-dir=.git -- "$pattern" public/ | sed 's/^/      /'
    fail=1
  else
    report "✓" "sem '$pattern'"
  fi
done

echo "→ 2. credencial do proxy fora do front"
for pattern in 'PROXY_RELOAD_KEY' 'x-proxy-key' 'api.recargagames.com'; do
  if grep -rIn --exclude-dir=.git -- "$pattern" public/ >/dev/null 2>&1; then
    report "✗" "ENCONTRADO '$pattern' em public/ — o front NÃO fala com o proxy"
    grep -rIn --exclude-dir=.git -- "$pattern" public/ | sed 's/^/      /'
    fail=1
  else
    report "✓" "sem '$pattern' em public/"
  fi
done

echo "→ 3. PROXY_ADMIN_KEY não existe neste repo"
if grep -rIn --exclude-dir=.git --exclude-dir=node_modules --exclude="check-secrets.sh" -- 'PROXY_ADMIN_KEY' . >/dev/null 2>&1; then
  report "✗" "ENCONTRADO PROXY_ADMIN_KEY — use a PROXY_RELOAD_KEY"
  grep -rIn --exclude-dir=.git --exclude-dir=node_modules --exclude="check-secrets.sh" -- 'PROXY_ADMIN_KEY' . | sed 's/^/      /'
  fail=1
else
  report "✓" "nenhuma referência"
fi

echo "→ 4. SKU / product_code fora do front"
if grep -rIn --exclude-dir=.git -- 'product_code' public/ >/dev/null 2>&1; then
  report "✗" "product_code aparece em public/"
  fail=1
else
  report "✓" "front não conhece product_code"
fi

# Valor de chave da Resend tem forma própria (re_ + ~30 chars). Regex, e
# não string fixa: 're_' cru daria falso positivo em qualquer
# 'score_', 'more_' ou 'share_' do front.
echo "→ 5. valor de chave da Resend fora do front"
if grep -rInE --exclude-dir=.git -- 're_[A-Za-z0-9_-]{20,}' public/ >/dev/null 2>&1; then
  report "✗" "algo com cara de RESEND_API_KEY em public/ — abortar deploy"
  grep -rInE --exclude-dir=.git -- 're_[A-Za-z0-9_-]{20,}' public/ | sed 's/^/      /'
  fail=1
else
  report "✓" "nenhum valor de chave da Resend"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "OK — checklist de secrets passou."
else
  echo "FALHOU — corrigir antes de deployar."
fi
exit "$fail"
