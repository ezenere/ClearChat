# ClearChat

Chat desktop minimalista (Electron + React + TypeScript + Tailwind v4) para qualquer endpoint
OpenAI-compatible. O contrato do projeto está em [SPEC.md](./SPEC.md).

## Desenvolvimento

Requisitos: Node ≥ 22 e npm.

```bash
npm install        # instala deps (postinstall: baixa o Electron e roda electron-builder install-app-deps)
npm run dev        # electron-vite dev (HMR no renderer; F12 abre DevTools)
npm run typecheck  # tsc nos projetos node (main/preload/shared) e web (renderer/shared)
npm run build      # bundle de produção em out/
npm start          # roda o bundle de out/ (electron-vite preview)
npm run lint       # eslint
npm run icons      # regenera os ícones a partir de build/icon.svg (rsvg-convert + ImageMagick)
```

## Empacotamento (Linux)

```bash
unset ELECTRON_RUN_AS_NODE
npm run dist           # typecheck + build + AppImage, deb, pacman e tar.gz em dist/
npm run dist:appimage  # só o AppImage
npm run dist:dir       # só a pasta desempacotada (dist/linux-unpacked)
npm run install:local  # instala o AppImage mais recente de dist/ para o seu usuário (sem root)
npm run install:local -- --uninstall
```

- Artefatos: `dist/ClearChat-<versão>-<arch>.{AppImage,deb,pacman,tar.gz}` (o `<arch>` segue a
  convenção de cada formato: `x86_64`, `amd64`, `x64`). No Arch: `sudo pacman -U dist/ClearChat-*.pacman`.
  O AppImage precisa do `fuse2`.
- `install:local` copia o AppImage para `~/.local/bin/ClearChat.AppImage` (+ link `clearchat`), cria
  `~/.local/share/applications/clearchat.desktop` e os ícones em `~/.local/share/icons/hicolor/<N>x<N>/apps/`.
  Respeita `HOME`/`XDG_DATA_HOME` (dá para testar num diretório de rascunho).
- O `.desktop`, o `StartupWMClass` e o app_id/WM_CLASS da janela são todos `clearchat`
  (`desktopName` no package.json), então o dock agrupa as janelas no ícone certo.
- Ícone: `build/icon.svg` é o mestre; `npm run icons` gera `build/icons/*.png`, `build/icon.{png,ico,icns}`,
  `resources/icon.png` (janela) e o favicon do renderer.

- Aliases: `@shared/*` → `src/shared/*` (main, preload e renderer) e `@renderer/*` → `src/renderer/src/*`.
- Banco: `~/.config/ClearChat/clearchat.db` no Linux (`app.getPath('userData')`). O caminho é
  logado no console do main ao iniciar (`[clearchat] db: …`).
- **Nome antigo**: o app se chamava "CleartChat" (typo). Na primeira execução, se
  `~/.config/ClearChat/clearchat.db` não existe e `~/.config/CleartChat/cleartchat.db` existe, o banco é
  copiado (cópia consistente com `VACUUM INTO`) para o novo local; a pasta antiga não é tocada e pode
  ser apagada à mão depois. Não roda com `CLEARCHAT_USER_DATA`. Chats com a assinatura antiga
  `cleartchat` continuam funcionando (alias de `clearchat`).
- **better-sqlite3**: a v13 usa N-API e já traz binários pré-compilados (`prebuilds/`), então o
  mesmo binário funciona no Node e no Electron, sem recompilar. O `postinstall`
  (`electron-builder install-app-deps`) continua configurado e é inofensivo (detecta o prebuild e não compila nada).
  No build do main ele é `external`; no pacote fica em `app.asar.unpacked`.
- **Scripts headless com o runtime do Electron** (mesmo ABI do app): use
  `ELECTRON_RUN_AS_NODE=1 npx electron script.js` — o script roda como Node puro, mas com o Node
  embutido do Electron. Ex.: inspecionar o banco:
  ```bash
  ELECTRON_RUN_AS_NODE=1 npx electron -e "const D=require('better-sqlite3');console.log(new D(process.argv[1],{readonly:true}).prepare('select * from chats').all())" ~/.config/ClearChat/clearchat.db
  ```
- ⚠️ Se `ELECTRON_RUN_AS_NODE` estiver definido no seu ambiente (acontece em processos iniciados
  por extensões do VS Code), o app **não abre** (`Cannot read properties of undefined (reading 'isPackaged')`).
  Rode `unset ELECTRON_RUN_AS_NODE` antes de `npm run dev` / `npm start` / testes E2E.
- **`CLEARCHAT_USER_DATA=/algum/dir`**: sobrescreve o diretório `userData` do app (banco
  `clearchat.db` etc.) — aplicado com `app.setPath` antes do `ready`. Use para testes isolados sem
  tocar no seu banco real.

## Personas e painel

- **Personas** (presets de chat, `src/shared/presets.ts`): modelo, system prompt, parâmetros, tools,
  aprovação, contexto, assinatura etc. (opcionalmente o diretório raiz). No Novo chat escolha uma no
  topo; ao editar qualquer campo aparece "Salvar como persona" (nova ou atualizando a de origem). A aba
  Chat do painel salva a config do chat atual; Configurações → Personas lista, edita, duplica, apaga e
  define a padrão. Campos que a persona não define seguem "Novos chats"; a "Padrão" (criada na 1ª
  execução, apagável) não define nenhum.
- **Painel direito**: abas Modelo · Chat · Tools · Arquivos; "Ver request" ({ }) no cabeçalho.

## Workspace, contexto e limites

- **Diretório raiz**: cada chat tem uma pasta-raiz (workspace) compartilhada pela sessão principal e
  pelos subagentes. Caminhos relativos das ferramentas resolvem nela; o `bash` começa nela e o `cd`
  persiste entre chamadas da sessão (o card do bash mostra o diretório atual). Com "Confinar
  ferramentas à raiz" (padrão), as tools de arquivo recusam caminhos fora dela (após `realpath`:
  `..` e symlinks não escapam). "Bash em sandbox" (só se o `bwrap`/bubblewrap estiver instalado)
  roda o terminal com a raiz gravável e o resto do sistema somente leitura. Novo chat e aba Arquivos
  têm "Nova pasta…" para começar um projeto do zero.
- **Contexto**: o medidor no composer mostra `tokens da última resposta / janela do modelo`
  (`context_length` do `/models`, ou a janela definida no chat). No limite (padrão 90%) aparece o
  banner "Compactar conversa"; opcionalmente compacta sozinho (subagentes: sempre). A compactação
  resume o histórico com o mesmo modelo (prefixo em cache), salva só o resumo como uma mensagem
  `role: user` de fronteira e as requests seguintes partem dela — as mensagens antigas continuam
  visíveis (esmaecidas) e apagar o resumo desfaz a compactação. Erros de contexto excedido mostram
  "Compactar e tentar de novo".
- **Limites das ferramentas** (`src/shared/limits.ts`): `read_file` lê em janelas (2000 linhas,
  aviso de arquivo grande, recusa binários, > 5 MB só com offset/limit), `bash` corta o meio da
  saída, `browse_url` pagina com `offset`, `list_dir`/`web_search`/`search_files`/`list_models` têm teto; o teto
  geral por resultado é configurável no chat ("Saída máx. por ferramenta"). `search_files` e
  `find_files` usam ripgrep quando disponível.
- **`list_models`** ("Listar modelos"): o modelo lista os modelos do provedor do chat (`/models`,
  com cache) filtrando por `query`, `tools_only`, `free_only`, ordenando por id/preço/contexto — útil
  para escolher o modelo de um `delegate_task`. Uma linha por modelo (`ctx`, preço por 1M, `grátis`,
  `tools`, `(atual)`). Habilitada por padrão em chats novos; chats antigos podem ligá-la na Config.
  A descrição orienta a usar modelos grátis só em tarefas fáceis e sem dados pessoais, e a trocar de
  modelo quando falham; se o modelo do subagente falhar, o `delegate_task` devolve
  `[falha do modelo X: …] … Tente outro modelo`.

## Mock de UI (sem backend)

`VITE_CLEAR_MOCK=1 npx electron-vite build` gera um renderer com uma API falsa
(`src/renderer/src/dev/mockApi.ts`); sirva `out/renderer` e abra `index.html?scenario=<nome>`
(`chat`, `onboarding`, `stream`, `reasoning` — raciocínio longo salvo + um turno ainda pensando).
Rode `npm run build` depois para voltar ao bundle normal.

## Testes

```bash
npm run test:unit   # buildRequest (+ fronteira de compactação), parser SSE/usage, <tool_call>, DuckDuckGo, assinatura de app,
                    # personas (snapshot/aplicar: campos copiados, cwd opcional, params, sanitização),
                    # confinação de caminhos, janelas do read_file, bash (corte início/fim + cd persistente),
                    # search/find_files, list_models (filtro/ordem/formato/corte) e erro de delegate,
                    # detecção de contexto excedido (Node puro, sem Electron)
                    # migração CleartChat → ClearChat; rascunho em $CLEARCHAT_TEST_TMP (padrão: tmp do sistema), apagado no fim

# E2E do backend (Playwright `_electron`, chama window.api pelo renderer; faz chamadas reais e baratas ao OpenRouter)
unset ELECTRON_RUN_AS_NODE
OPENROUTER_API_KEY=sk-or-... CLEARCHAT_E2E_DIR=/tmp/clearchat-e2e npm run test:e2e
# só alguns testes (filtro por nome, separado por vírgula):
OPENROUTER_API_KEY=... node e2e/backend.spec.ts 'delegate,fila'

# E2E da UI real (Playwright `_electron` clicando/digitando na interface; screenshots em $CLEARCHAT_E2E_DIR/shots)
OPENROUTER_API_KEY=sk-or-... CLEARCHAT_E2E_DIR=/tmp/clearchat-ui-e2e npm run test:e2e:ui
# para depois de um passo (os passos são dependentes):
OPENROUTER_API_KEY=... node e2e/ui.spec.ts 'delegate'
```

- O E2E da UI digita a key no onboarding e percorre: novo chat (combobox de modelo, system prompt,
  PWD), write/read de arquivo, aprovação de bash (Permitir / Negar / Sempre neste chat), fila (chip)
  e ⚡, Parar, delegate_task + subsessão somente leitura, edição de modelo/system prompt/params com
  conferência no "Ver request", modo texto (tools nativas off), assinatura de app none/cline nos
  headers, aba Arquivos ("Usar como PWD"), edição de provider, editar/apagar/regenerar, erro HTTP
  persistido, reinício do app, indicador global de aprovação de subagente e layout em 900x600 — e
  também o medidor de contexto, o banner de compactação (forçado com uma janela minúscula), o botão
  Compactar (divisor + card do resumo + "Ver request" compactado), a aba Arquivos confinada à raiz
  ("Usar como raiz", "Nova pasta…") e "Nova pasta…" no Novo chat — e ainda as abas do painel (Modelo ·
  Chat · Tools · Arquivos, "Ver request" de qualquer aba, aba lembrada entre reinícios) e as personas:
  criar no Novo chat depois de editar (Personalizado → Salvar como persona), começar um chat dela,
  salvar do painel (com a raiz), editar/duplicar/definir padrão/apagar nas Configurações.
- O E2E do backend cobre ainda: compactação ponta a ponta (resumo persistido, request a partir da
  fronteira, conversa coerente depois, Parar cancela sem salvar), compactação automática e
  "tentar de novo", compactação reaproveitando o cache (Haiku), aviso de arquivo grande,
  `search_files`, `list_models` (query "gpt-4.1" + tools_only), `cd` persistente no bash e rejeição de caminho fora da raiz.
  O diálogo nativo "Escolher pasta" é substituído no main para devolver a pasta de rascunho.
- A key é lida **somente do ambiente** (nunca grave em arquivo). O E2E usa `CLEARCHAT_USER_DATA`
  e um cwd de rascunho dentro de `CLEARCHAT_E2E_DIR` (apagado no início), escolhe um modelo barato
  com tools (`openai/gpt-4.1-nano`, ou `E2E_MODEL`) e um Claude Haiku para o teste de cache
  (`E2E_CACHE_MODEL`). Relatório em `$CLEARCHAT_E2E_DIR/report.json`, log do main em `main.log`.
- Os scripts `.ts` de `e2e/` rodam direto no Node ≥ 23.6 (type stripping nativo); `e2e/ts-hooks.mjs`
  resolve `@shared/*` e imports sem extensão.
