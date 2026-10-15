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

## Modelos, personas e painel

- **Modelo = par (provedor, modelo)**: não há "provedor padrão" nem seletor de provedor. Um seletor
  só (`components/ui/ModelPicker.tsx`) lista os modelos de todos os provedores, agrupados por
  provedor (cabeçalho com nome e contagem, recolhível — lembrado no `localStorage`; o grupo da seleção
  abre sozinho), com busca em todos os grupos, erro por provedor com "tentar de novo", "Usar
  "<id>" em <provedor>" para IDs fora da lista e teclado (↑/↓, Enter, Esc). O mesmo id em dois
  provedores (Opus via OpenRouter e via Anthropic) são opções diferentes. Trocar no meio do chat vale
  na próxima request; subagentes ficam no provedor em que foram criados (`sessions.provider_id`).
  "Novos chats" → Modelo padrão grava `defaultProviderId` + `defaultModel` juntos (provedor apagado
  → não definido). A pílula do header mostra "<Provedor> · <modelo>".
- **Personas** (presets de chat, `src/shared/presets.ts`): modelo, system prompt, parâmetros, tools,
  aprovação, contexto, assinatura etc. (opcionalmente o diretório raiz). No Novo chat escolha uma no
  topo; ao editar qualquer campo aparece "Salvar como persona" (nova ou atualizando a de origem). A aba
  Chat do painel salva a config do chat atual; Configurações → Personas lista, edita, duplica, apaga e
  define a padrão. Campos que a persona não define seguem "Novos chats"; a "Padrão" (criada na 1ª
  execução, apagável) não define nenhum. Provedor + modelo da persona andam juntos: sem modelo → o
  par padrão; provedor apagado → o par padrão, com aviso.
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
- **`list_models`** ("Listar modelos"): o modelo lista os modelos do provedor da sessão (`/models`,
  com cache) filtrando por `query`, `tools_only`, `free_only`, ordenando por id/preço/contexto — útil
  para escolher o modelo de um `delegate_task`. Uma linha por modelo (`ctx`, preço por 1M, `grátis`,
  `tools`, `(atual)`). Habilitada por padrão em chats novos; chats antigos podem ligá-la na Config.
  A descrição orienta a usar modelos grátis só em tarefas fáceis e sem dados pessoais, e a trocar de
  modelo quando falham; se o modelo do subagente falhar, o `delegate_task` devolve
  `[falha do modelo X: …] … Tente outro modelo`.

## Anexos

- 📎 no composer (diálogo nativo), arrastar arquivos para o chat ou colar imagens. Imagens
  (png/jpg/webp/gif), PDF, áudio (wav/mp3) e arquivos de texto/código; até 20 MB por arquivo e
  10 por mensagem (`ATTACHMENT_LIMITS` em `src/shared/limits.ts`).
- Os bytes ficam em `userData/attachments/<sha256>.<ext>` (dedup); o histórico guarda só
  referências `clearchat-attachment://…` e o `buildRequest` as expande para base64 em cada request
  (mesmos bytes sempre → cacheável). "Ver request" mostra o base64 encurtado.
- Aviso quando o modelo não declara a modalidade (`input_modalities` do `/models`); enviar assim
  mesmo exige confirmação. PDF no OpenRouter funciona com qualquer modelo (o OpenRouter extrai o texto).
- Arquivos órfãos (chat/mensagem apagados) são removidos no próximo início do app.

## Mock de UI (sem backend)

`VITE_CLEAR_MOCK=1 npx electron-vite build` gera um renderer com uma API falsa
(`src/renderer/src/dev/mockApi.ts`); sirva `out/renderer` e abra `index.html?scenario=<nome>`
(`chat`, `onboarding`, `stream`, `reasoning` — raciocínio longo salvo + um turno ainda pensando;
`markdown` — cercas aninhadas, LaTeX e um rascunho com fórmula incompleta, no chat "Ideias de nomes").
Rode `npm run build` depois para voltar ao bundle normal.

## Testes

```bash
npm run test:unit   # seletor de modelos (e2e/models.test.ts: grupos por provedor, busca, ID livre, teclado,
                    # virtualização, par padrão/persona/subsessão), buildRequest (+ fronteira de compactação), parser SSE/usage, <tool_call>, DuckDuckGo, assinatura de app,
                    # personas (snapshot/aplicar: campos copiados, cwd opcional, params, sanitização),
                    # anexos (e2e/attachments.test.ts: codificação por tipo, expansão determinística, _attachment removido,
                    # cache_control com parts mistos, preview encurtado, arquivo ausente, compactação, GC),
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

- O E2E da UI digita a key no onboarding e percorre: novo chat (seletor de modelo, system prompt,
  PWD), write/read de arquivo, aprovação de bash (Permitir / Negar / Sempre neste chat), fila (chip)
  e ⚡, Parar, delegate_task + subsessão somente leitura, edição de modelo/system prompt/params com
  conferência no "Ver request", modo texto (tools nativas off), assinatura de app none/cline nos
  headers, aba Arquivos ("Usar como PWD"), edição de provider, editar/apagar/regenerar, erro HTTP
  persistido, reinício do app, indicador global de aprovação de subagente e layout em 900x600 — e
  também dois provedores no seletor de modelo (um OpenAI-compatible falso servido pelo próprio teste
  em 127.0.0.1 — `/models` + `/chat/completions` SSE — e um quebrado): grupos com cabeçalho, recolher
  (lembrado), busca nos dois, o mesmo id no grupo 2 → "Ver request" (URL/headers), pílula e a request
  chegando ao provedor falso; subsessões antigas no provedor delas; "Modelo padrão" (par) nas
  Configurações, persona com provedor apagado (aviso) e provedor apagado = não definido; e ainda o medidor de contexto, o banner de compactação (forçado com uma janela minúscula), o botão
  Compactar (divisor + card do resumo + "Ver request" compactado), a aba Arquivos confinada à raiz
  ("Usar como raiz", "Nova pasta…") e "Nova pasta…" no Novo chat — e ainda as abas do painel (Modelo ·
  Chat · Tools · Arquivos, "Ver request" de qualquer aba, aba lembrada entre reinícios) e as personas:
  criar no Novo chat depois de editar (Personalizado → Salvar como persona), começar um chat dela,
  salvar do painel (com a raiz), editar/duplicar/definir padrão/apagar nas Configurações.
- Anexos — backend (`node e2e/backend.spec.ts anexo`): PNG gerado (quadrado vermelho "CC42") descrito por
  um modelo de visão barato (`E2E_VISION_MODEL`, padrão `openai/gpt-4.1-nano`), texto + PDF entendidos, áudio
  wav (`E2E_AUDIO_MODEL`, padrão `google/gemini-3.1-flash-lite`), anexo na fila e no ⚡, erros legíveis,
  arquivo ausente e GC no reinício. UI (`node e2e/ui.spec.ts anexos`): botão (diálogo mockado no main),
  colar imagem, chips, aviso de modalidade + confirmação, miniatura/lightbox/prévia na mensagem enviada e
  "Ver request" encurtado.
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
