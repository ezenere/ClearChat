# ClearChat

Chat com IA e agentes que mostra tudo o que faz: ferramentas sob a sua aprovação, subagentes, memória,
skills, voz e sincronização com criptografia ponta a ponta. Site: <https://clear.ezenere.com>.

Esta pasta reúne o projeto inteiro. Cada parte é um repositório próprio, clonado aqui dentro; este
repositório guarda só o que é compartilhado entre eles.

| Pasta | Repositório | O que é |
|---|---|---|
| [`ClearChatDesktop/`](https://github.com/ezenere/ClearChatDesktop) | `ezenere/ClearChatDesktop` | App desktop (Electron + React + TypeScript) — Windows, macOS e Linux. Releases e downloads. |
| [`ClearChatWebsite/`](https://github.com/ezenere/ClearChatWebsite) | `ezenere/ClearChatWebsite` | Servidor de sync (FastAPI + Postgres), site (landing, cadastro, painel que decifra no navegador) e admin. Self-host com Docker Compose. |
| `ClearChatMobile/` | — (ainda local) | App mobile (Expo / React Native) — Android primeiro, iOS depois. |

## O que fica aqui

- [`docs/SYNC_PROTOCOL.md`](docs/SYNC_PROTOCOL.md) — **contrato do sync** (criptografia, registros,
  REST, WebSocket, host de execução). Fonte única; os repositórios guardam cópias idênticas.
- [`docs/test-vectors/`](docs/test-vectors) — vetores de criptografia e algoritmos normativos; todo
  cliente passa em todos (`cd docs/test-vectors && npm install && node generate.ts --check`).
- [`scripts/protocol.mjs`](scripts/protocol.mjs) — copia o protocolo para os repositórios (`sync`) ou
  confere que estão idênticos (`check`).

## Montar a pasta

```bash
git clone <este repositório> ClearChat && cd ClearChat
git clone https://github.com/ezenere/ClearChatDesktop.git
git clone https://github.com/ezenere/ClearChatWebsite.git
node scripts/protocol.mjs check
```

Cada repositório tem o seu README com desenvolvimento, testes e build.

## Mudando o protocolo

1. Edite `docs/SYNC_PROTOCOL.md` (e regenere os vetores se a cripto mudar), suba a versão do protocolo e
   escreva o changelog.
2. `node scripts/protocol.mjs sync` — copia para o desktop e o site.
3. Implemente nos dois lados (app e servidor/site) e, no mobile, rode `npm run vendor`.
4. Commit em cada repositório (e aqui).
