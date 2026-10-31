# CLAUDE.md — ClearChat (pasta do projeto)

Esta pasta contém três repositórios git **separados** (ignorados aqui) e este repositório com o que é
compartilhado. Antes de mexer num deles, leia o `CLAUDE.md` daquele repositório.

- `ClearChatDesktop/` — app Electron (`ezenere/ClearChatDesktop`; até 2026-10-31 se chamava
  `ezenere/ClearChat`, nome que agora é deste repositório pai).
- `ClearChatWebsite/` — servidor de sync + site + admin (`ezenere/ClearChatWebsite`).
- `ClearChatMobile/` — app Expo/React Native (`ezenere/ClearChatMobile`).

## Protocolo de sync (compartilhado)

- Fonte única: `docs/SYNC_PROTOCOL.md` e `docs/test-vectors/` **deste** repositório. Desktop e site
  guardam cópias byte a byte; o mobile vendora em `src/vendor/protocol/`.
- Mudou o protocolo, a cripto, os esquemas de registro, os endpoints ou o WebSocket: edite aqui, suba a
  versão + changelog, `node scripts/protocol.mjs sync`, implemente no desktop **e** no servidor/site,
  revendore no mobile (`npm run vendor`). `node scripts/protocol.mjs check` deve passar.
- Os esquemas de registro (§4) espelham `ClearChatDesktop/src/shared/*` e as tabelas do desktop.

## Regras gerais

- Commits sem trailer de co-autoria de IA, em todos os repositórios.
- Servidor de produção: `ezenere@172.16.1.7:/srv/websites/clear-chat` (https://clear.ezenere.com). Só
  mexer com pedido explícito; avisar antes de usar Docker lá.
- Nunca usar os dados reais do usuário em testes (`~/.config/ClearChat`, `~/.config/CleartChat`, no Mac
  `~/Library/Application Support/ClearChat`); nunca gastar cota de API paga sem autorização; nunca abrir o
  microfone real em testes automáticos; nunca escrever chaves de API em arquivos do repositório.
- UI e textos em pt-BR; identificadores em inglês.
