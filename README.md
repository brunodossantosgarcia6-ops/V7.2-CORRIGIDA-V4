# FictiBank V7.2 Corrigida V3

Versão corrigida do FictiBank V7.2 para Render + PostgreSQL.

## Correção principal

Corrigido o erro PostgreSQL `42P08` (`text versus integer`) na criação do lançamento de saldo inicial. O ID do usuário agora é convertido explicitamente para texto ao montar o `tx_code`.

## Render

- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variable obrigatória: `DATABASE_URL`

Aponte `DATABASE_URL` para o PostgreSQL do FictiBank.

## Importante

Esta é uma simulação fictícia. Não usa Pix real nem dinheiro real.
