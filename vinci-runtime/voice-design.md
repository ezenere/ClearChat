# ClearChat por voz — duas features: ditado (STT) e chamada de voz com interjeições

**Tipo:** proposta de arquitetura / planejamento
**Data:** 2026-10-22
**Estado:** rascunho de desenho (sem implementação). Tabela de componentes/modelos pendente da pesquisa de estado da arte (em andamento).
**Derivado de:** `arquitetura_interjeicoes_voz_em_tempo_real.md` (conceito do usuário) + leitura do código do ClearChat 0.8.8.

---

## 0. Resumo executivo

São duas entregas de complexidade muito diferente:

| | Feature A — Ditado (STT) | Feature B — Chamada de voz |
|---|---|---|
| O que é | botão de microfone no composer que transcreve fala em texto no rascunho | modo "chamada" em que usuário fala, agente responde por voz, com interjeições durante a fala do usuário |
| Complexidade | média | alta (sistema em tempo real, multi-componente) |
| Risco principal | qualidade/latência do STT | timing: interjeição no momento certo sem interromper |
| Novo no app | UI no composer, captura de áudio, backend de STT, seleção de microfone | subsistema de áudio tempo real: VAD, ASR streaming, turn-taking, motor de interjeições, TTS, controlador de áudio |
| Impacto em sync | **nenhum** (texto rascunho; config global) | **nenhum na mensagem** (chamada vira mensagens normais); config de voz deve ficar global para não tocar o protocolo |
| Ordem sugerida | **primeira** (valida toda a pilha de áudio do app) | depois (reusa a pilha validada) |

**Duas decisões centrais que eu recomendo já adotar:**

1. **A chamada de voz é um modo do agente existente, não um agente novo.** Mesmo chat, mesma sessão, mesmo histórico, mesmas tools/aprovações/memória/skills — só muda a modalidade de I/O (áudio em vez de teclado/tela). Alternativa detalhada na §3.
2. **Caminho rápido (interjeições) e caminho principal (resposta) são subsistemas separados**, como proposto no documento do usuário. O caminho rápido é local, determinístico no início (regras), com clipes pré-gerados; o caminho principal é o runner do ClearChat + TTS.

---

## 1. O que já existe no ClearChat e pode ser reaproveitado

Verificado no código (0.8.8):

| Já existe | Onde | Relevância |
|---|---|---|
| Anexos de áudio (wav/mp3) com `input_audio` na request | `src/shared/attachments.ts:30`, `types.ts:550` | a request builder já sabe montar payload de áudio para o modelo |
| Checagem de modalidade por modelo (`input_modalities` do `/models`) | `src/shared/attachments.ts:148` | útil para decidir se o modelo principal aceita áudio direto ou precisa do pipeline STT→LLM→TTS |
| Composer com barra de ações + botão enviar (`ArrowUp`) | `src/renderer/src/components/chat/Composer.tsx:345` | ponto exato onde entra o botão de mic + seta de seleção |
| `buildRequest` puro + runner com streaming | `src/main/agent/request.ts`, `runner.ts` | o caminho principal da chamada reusa tudo isso |
| Config por chat/persona com campos novos padronizados | `ChatConfig` em `types.ts:177`, `PRESET_FIELDS` em `presets.ts:23` | padrão para adicionar `voice` — mas ver alerta de sync na §6 |
| Smart-Approve, aprovações, ask_user | `src/main/agent/` | valem durante a chamada (a voz não muda a política; o agente pode *anunciar* que precisa de aprovação) |
| Modo mock de UI (`VITE_CLEAR_MOCK`) | `src/renderer/src/dev/mockApi.ts` | cenário "voice" para desenvolver UI sem backend |
| Cultura de testes: unit puro + E2E Playwright | `e2e/` | a política de interjeições deve ser função pura testável; Playwright suporta microfone falso (`--use-fake-device-for-media-capture`) |

---

## 2. Feature A — Ditado por voz (STT no composer)

### 2.1 UX proposta

- **Botão de microfone** à esquerda do botão de enviar, com uma **seta (chevron)** ao lado que abre o menu de seleção de microfone (quando o PC tem mais de um).
- **Modo de gravação:** clique para iniciar / clique para parar (padrão), com **auto-stop por silêncio** (~1,5 s). Alternativa configurável: segurar pressionado (push-to-talk).
- **Transcrição parcial ao vivo** aparece no campo de texto como rascunho (visualmente diferenciada — ex.: texto acinzentado), substituída pela transcrição final quando a gravação termina. **Nunca envia sozinho** — o texto fica editável no composer.
- **Cancelar:** `Esc` ou botão X descarta a gravação. Barra de nível de áudio (VU meter) durante a gravação dá feedback de que o mic está captando.
- **Menu da seta:** lista de dispositivos de entrada (`navigator.mediaDevices.enumerateDevices`) com marcação do atual, opção "Padrão do sistema", persistência da escolha, atualização automática em hotplug (`devicechange`). Mais um atalho "Configurações de áudio".
- **Atalho de teclado** global para começar/parar ditado (ex.: `Ctrl+Shift+M`) — opcional na v1.

### 2.2 Pilha técnica

```
renderer (UI + captura)
  getUserMedia(deviceId, {echoCancellation, noiseSuppression, autoGainControl})
    → AudioWorklet: PCM 16 kHz mono (para backend local/VAD)
    → MediaRecorder: webm/opus ou wav (para backend de API)
main (rede + chaves — nunca mandar chave ao renderer)
  POST {baseUrl}/audio/transcriptions  (compatível OpenAI)
```

- **Captura e VU:** Web Audio API + AudioWorklet (cross-platform no Electron, sem dependência nativa).
- **Backend de STT — três opções:**

| Opção | Como | Prós | Contras |
|---|---|---|---|
| **API compatível OpenAI** (`/audio/transcriptions`) | usa provider/config já existentes do ClearChat (baseUrl + key); modelo tipo `whisper-1` / `whisper-large-v3-turbo` (Groq) / `gpt-4o-transcribe` | zero dependência nova; qualidade alta em pt-BR; coerente com a filosofia "qualquer endpoint OpenAI-compatible" | custo por minuto; latência de rede; exige enviar áudio para fora |
| **Local** | whisper.cpp (binding N-API com prebuilds, mesma lição do better-sqlite3) ou whisper WASM (transformers.js em Worker) | privacidade total; sem custo; funciona offline | qualidade menor/latência de inferência em CPU; peso de bundle; manutenção |
| **Híbrida** | parcial rápido local (texto grosseiro ao vivo) + final por API quando para de falar | feedback instantâneo + qualidade final | mais complexidade |

**Recomendação v1: API compatível, com a escolha do backend em Configurações (deixando o slot do local pronto).** O parcial ao vivo pode vir da API em streaming se o modelo oferecer, ou ser omitido na v1 ("transcrevendo…").

### 2.3 Configuração

- **Global** (Configurações → Áudio, sincronizável como preferência): deviceId do mic padrão, modo segurar/clique, auto-stop, idioma da transcrição (pt-BR default), backend de STT + provider/modelo.
- **Por chat:** nada na v1 (evita tocar `ChatConfig` → sync).

---

## 3. Feature B — Chamada de voz: modo do agente vs. agente novo

| Critério | Modo do agente existente (recomendado) | Agente novo dedicado |
|---|---|---|
| Histórico | a chamada gera as mesmas mensagens do chat (transcrição = msg do usuário; resposta falada = msg do assistente) — continuidade total entre voz e texto | histórico separado ou duplicado; "continuar por texto" vira export |
| Tools/aprovações/memória/skills | herda tudo, sem reimplementar | reimplementar ou copiar config |
| Runner/`buildRequest`/streaming | reusa integralmente | reusa por composição, mas com wrapper |
| System prompt | mesma persona; dá para acrescentar instruções de fala ("responda curto, em voz") via campo `voiceStyle` | prompt próprio, mais liberdade |
| Sync | nenhuma mudança de protocolo (mensagens normais) | mensagens ou tipo de sessão novo → **protocolo novo, dois repos** |
| Troca de modalidade no meio | natural (falar ⇄ digitar) | fricção |
| Risco | chamada precisa de uma política de voz para tools que falam demais / aprovações | escopo paralelo a manter |

**Recomendação: modo do agente existente.** "Voz" é modalidade de I/O, não um tipo de agente — a filosofia do ClearChat (transparência, mesmo histórico, controle) se beneficia de um chat só. A diferença de comportamento (respostas curtas, ritmo) cabe em persona/campo de config, não em um agente novo.

### 3.1 Arquitetura (adaptação do documento do usuário ao ClearChat)

```
┌────────────────────────────── renderer ──────────────────────────────┐
│  Mic → AudioWorklet (PCM) → [VAD Silero] → eventos de fala/pausa      │
│              │                    │                                   │
│              │                    ├→ [Turn-taking] → fim de turno ──┐ │
│              ▼                    ▼                                  │ │
│        [ASR streaming]      [Detector de interjeições]               │ │
│          parciais texto ────────→ regras (v1) / classificador (v2)   │ │
│                                      │                               │ │
│                                      ▼                               │ │
│                               [Catálogo de clipes] (wav pré-gerados) │ │
│                                      │                               │ │
│  ┌───────────────────────────────────▼────────────────────────────┐  │ │
│  │        CONTROLADOR DE ÁUDIO (único dono da saída)              │  │ │
│  │  máquina de estados · fila de utterances · barge-in ·          │  │ │
│  │  cooldown de interjeição · ducking · timestamps de latência    │  │ │
│  └───────────────▲──────────────────────────────▲─────────────────┘  │ │
└──────────────────┼──────────────────────────────┼────────────────────┘ │
                   │ clipes de TTS (chunks)       │ transcrição final     │
┌──────────────────┼──────────────────────────────┼────────────────────┐ │
│  main: [TTS streaming] ◄── texto da resposta ◄── [Runner do agente]◄─┘ │
│        (provider TTS)              (buildRequest + API, streaming)     │
└───────────────────────────────────────────────────────────────────────┘
```

**Divisão de responsabilidade (decisão importante):**
- **renderer:** tudo que é caminho crítico de latência — captura, VAD, ASR parcial local, detector de interjeições, controlador de áudio, playback. Sem round-trip de IPC por janela de 200 ms.
- **main:** rede e chaves (STT por API, LLM, TTS), persistência, config. IPC com eventos grossos (parciais de ASR por API, chunks de TTS de ~100–200 ms, transcrições finais).
- Isso mantém o padrão de segurança do app (chaves nunca no renderer) sem pagar IPC no loop rápido.

### 3.2 Componentes e decisões por bloco

**1. VAD e segmentação** — Silero VAD (ONNX, roda em CPU em Worker) marca início/fim de fala e duração de pausas. É a base de tudo: turn-taking e interjeições são eventos sobre pausas. O VAD **não** decide "é oportuno falar" — só "há fala/pausa".

**2. ASR streaming (parcial)** — alimenta o contexto do detector de interjeições (fim da fala: "e depois...", "?") e o fim de turno. Caminhos: local (whisper.cpp streaming / Moonshine) ou API streaming. Texto parcial **não** carrega prosódia — por isso o detector também recebe features acústicas (duração da pausa, energia, queda de pitch).

**3. Turn-taking (fim de turno)** — o problema mais difícil do projeto, mais do que as interjeições. Há modelos prontos que valem testar antes de treinar o nosso: **LiveKit TurnDetector `v1-mini`** (local, CPU, grátis, 14 idiomas **incluindo português** — o mais atraente para pt-BR) e **Smart Turn v3.2** do pipecat (BSD-2, 95 MB, áudio puro). **Easy-Turn** (ICASSP 2026) prevê 4 estados incluindo *backchannel* e traz trainset aberto de 1.145 h, mas é GPU (850 MB) e a licença não foi localizada. Heurística composta v1:
- silêncio base (~700 ms) ajustado por contexto: menor se a fala termina com "?" ou frase completa; maior se termina com conjunção/preposição ("e...", "mas...", "tipo..."), entonação suspensiva ou palavra cortada;
- teto absoluto (ex.: 4 s) para nunca travar;
- v2: classificador pequeno (texto parcial + prosódia) ou um mini-LLM local decidindo `END_TURN: 0..1`.

**4. Motor de interjeições (caminho rápido)** — entrada: eventos de pausa, duração da fala atual, cauda da transcrição parcial, tempo desde a última interjeição, tipo da última, estado do controlador. Saída: `NONE | ACK | AGREEMENT | ENCOURAGEMENT | THINKING` (+ variante do clipe). Duas fases:
- **v1 — regras puras** (função determinística, testável em `e2e/*.test.ts`): só em pausa > ~450 ms, no máximo 1 interjeição a cada ~4 s, nunca no primeiro segundo de fala, nunca quando o assistente está falando, `ACK` neutro quando a confiança é baixa (concordar cedo é pior que calar), `NONE` deve ser de longe a saída mais comum;
- **v2 — classificador pequeno** (ONNX treinado com dados rotulados pt-BR) substituindo/complementando as regras, com expiração temporal dos resultados (decisão velha = descartada). **Validação externa importante:** a extensão `pipecat-backchannel` implementa exatamente esta arquitetura (clipes pré-gerados pelo próprio TTS do bot, cache em `.clip_cache/`, disparo em pausas "incompletas", sem LLM no playback) com parâmetros que servem de ponto de partida para as nossas regras: `cooldown 2,5 s`, `fire_probability 0,8`, `min_speech_before_eligible 0,7 s`, volume 0,6. Candidatos de M4: **MaAI** (`MaAI-Kyoto/MaAI`, MIT — VAP com modelo de backchannel VapGPT_bc, mas EN/ZH/JA, **sem pt-BR**) e **Easy-Turn** (classifica estado *backchannel*, trainset aberto com 10 h de backchannel).

**5. Catálogo de clipes pré-gerados** — a ideia mais prática do documento. Implementação sugerida: ao escolher a voz principal do TTS, **gerar uma vez** (e guardar em `userData/voice-clips/<voiceId>/`) 3–5 variantes por classe (`uhum`, `aham`, `sim`, `certo`, `entendi`, `hum...`, `ah!`), com o mesmo TTS e tratamento de áudio da voz principal. Resolve o risco de "duas pessoas falando", custa zero por interjeição e tem latência mínima (pré-carregado como `AudioBuffer`). TTS em tempo real para interjeições fica para depois (se muito).

**6. Resposta principal** — runner existente em streaming → **TTS por sentença** (falando cada sentença assim que completa, mantendo o texto fluindo). O modelo principal continua sendo texto-only na grande maioria dos provedores (o pipeline STT→LLM→TTS funciona com **qualquer** endpoint compatível — trunfo do ClearChat); modelos omni (áudio nativo) são backend alternativo futuro, não requisito.

**7. Controlador de áudio (o coração)** — único dono da saída. Estados (do documento do usuário, enxutos):

```
USER_SPEAKING → USER_PAUSE → (INTERJECTION_PENDING → toca clipe → USER_PAUSE)
USER_PAUSE → TURN_FINALIZED → ASSISTANT_SPEAKING → (barge-in: USER_SPEAKING) → …
```

Regras de arbitragem: uma saída por vez; interjeição cancelada se a resposta principal começou; clipe com timestamp expirado é descartado (nunca tocar "uhum" atrasado); cooldown entre interjeições; **barge-in**: fala do usuário durante a resposta cancela o TTS na hora e o turno retoma; **ducking** opcional (abaixar a resposta em vez de cortar, para interjeições do usuário durante a fala do assistente — "sim", "tá").

**Insígnia de design (do LiveKit "adaptive interruption"):** nem toda fala do usuário durante a resposta é interrupção — backchannel do usuário ("uhum", "tá") **não deve** cancelar a resposta do assistente, e as nossas próprias interjeições **não podem** ser ouvidas como fala do usuário (ecocancelamento/AEC + o controlador sabe o que está reproduzindo). O LiveKit usa um modelo acústico treinado em conversas reais para distinguir interrupção intencional de backchannel ("funciona com qualquer idioma, melhor em inglês"); v1 nossa pode usar heurística (fala curta durante a resposta → ducking em vez de cancelar).

**8. Instrumentação de latência (desde o dia 1)** — marcas de tempo em cada etapa: `t_fim_da_fala_percebida`, `t_decisão`, `t_inicio_do_som` (via `AudioContext.baseLatency/outputLatency` + relógio compartilhado). Painel de linha do tempo da chamada (mesma filosofia de transparência do "Ver request"): o que o VAD viu, quando as interjeições dispararam, latências p50/p95.

### 3.3 Modo sombra (shadow mode) — ideia que eu destacaria

Um interruptor "somente registrar" em que o motor de interjeições **decide mas não toca**, gravando onde *teria* reagido. Serve para: (a) calibrar regras sem ficar irritante; (b) gerar dados rotulados para o classificador do M4; (c) avaliar taxa de falsos positivos com uso real. Custo zero de UX, valor enorme de ajuste.

### 3.4 Ecocancelamento — risco prático que costuma ser esquecido

Com alto-falantes, o áudio do assistente volta pelo microfone e o VAD/ASR podem ouvir o assistente como se fosse o usuário (loop infernal). Mitigações: constraints `echoCancellation` do sistema (usar sempre); recomendar fones na primeira chamada; detectar correlação com o que está sendo reproduzido (v2) e, no limite, o controlador marca "assistente falando" e ignora o VAD (meia-duplex forçada) quando o AEC não estiver disponível.

---

## 4. Orçamento de latência (metas de protótipo, não promessa)

| Etapa | Meta | Observação |
|---|---|---|
| Janela de decisão (amostragem) | a cada ~200 ms | o contexto de áudio do classificador é maior que a janela (2–4 s), como o documento já observa |
| Detecção de pausa reagível | ~100 ms após o silêncio cruzar o limiar | eventos do VAD, não polling |
| Inferência do detector (regras) | ~0 ms | trivial |
| Inferência do detector (classificador ONNX pequeno) | 10–30 ms em CPU | modelo ~10–50 MB |
| Decisão → som audível (clipe pré-carregado) | < 50 ms | buffer já em memória |
| **Pausa percebida → interjeição audível** | **~200–400 ms total** | faixa humana de backchannel; é o número que importa |
| Fim de turno → primeira palavra da resposta | inclui ASR final + 1º token + 1º chunk de TTS | medir por partes |

Se uma inferência demorar mais que a janela, **descartar** (resultado velho expira) — nunca acumular fila de decisões, como o documento do usuário bem alerta.

---

## 5. Plano de etapas (cada uma com valor próprio)

| Etapa | Conteúdo | Critério de pronto |
|---|---|---|
| **M0 — Fundação de áudio** | captura PCM, VU, seletor de mic, playback, harness de latência (script de medição) | medir latência captura→reprodução num clipe de teste, número documentado |
| **M1 — Feature A (ditado)** | botão mic + seta, STT por API, rascunho no composer, config global | ditar mensagem em pt-BR e enviar; unit + E2E com mic falso |
| **M2 — Chamada meia-duplex** | modo chamada no chat: fala → transcrição → runner → TTS por sentença; turnos por silêncio (teto fixo) | conversa de 2 min sem travar; histórico do chat preenchido corretamente |
| **M3 — Interjeições v1** | regras puras + clipes pré-gerados + controlador (cooldown, cancelamento) + **shadow mode** + painel de timeline | interjeições só em pausas adequadas; p95 de reação medida; shadow mode gera log avaliável |
| **M4 — Inteligência** | fim de turno adaptativo/semântico; classificador treinado (dados do shadow mode + gravações com consentimento); avaliação com métricas do documento (falsos positivos, oportunidades perdidas, interjeições/min) | bater métricas acordadas em teste com falantes pt-BR reais |
| **M5 — Polimento** | barge-in fino, ducking, vozes/variantes, custo por minuto, omni opcional, sync da config se necessário | decisão consciente sobre o que vai para sync (dois repos) |

A ordem valida primeiro o caminho de baixa latência (M0–M3) antes de investir em modelo treinado (M4), exatamente como o documento do usuário recomenda — e o M1 entrega valor ao usuário antes do projeto grande.

---

## 6. Impactos no projeto ClearChat (obrigações de contrato)

1. **`SPEC.md`** — novas seções (Áudio/Chamada de voz) são contrato; escrever antes/ao implementar.
2. **Sync (dois repositórios!)** — se a config de voz entrar em `ChatConfig` + `PRESET_FIELDS`, ela vira registro do protocolo §4 e exige mudança em ClearChat **e** ClearChatWebsite (documentos idênticos, vetores, versão do protocolo). **Minimizar:** config de voz global (settings) na v1; campo por chat/persona só se realmente precisar.
3. **Testes** — política de interjeições e turn-taking como funções puras (`src/shared/voicePolicy.ts` no espírito de `smartApprove.ts`/`shellParse.ts`); suíte nova em `e2e/voicePolicy.test.ts`; E2E com `--use-fake-device-for-media-capture`; cenário "voice" no mock de UI.
4. **Privacidade** — áudio nunca persistido por padrão (só transcrição vira mensagem, que já sincroniza); gravação para dataset de treino só opt-in explícito, com consentimento e anonimização; botão visível de "gravando" sempre presente.
5. **Permissões** — no Linux/macOS o SO pode exigir permissão de microfone (macOS: `NSMicrophoneUsageDescription` no electron-builder).

---

## 7. Riscos (além dos do documento do usuário)

| Risco | Mitigação |
|---|---|
| Ecocancelamento insuficiente (alto-falante) | AEC do sistema sempre ligado; recomendar fones; fallback meia-duplex |
| Interjeição semanticamente errada ("sim" antes da pessoa terminar a ideia) | só classes neutras quando a confiança é baixa; nunca concordar/denegir em v1 sem contexto textual |
| Latência real diferente da medida (JACK/PipeWire, Bluetooth, Electron) | M0 mede primeiro, no hardware real; mic Bluetooth é pior caso |
| Custo por minuto de ASR+LLM+TTS estourar | interjeições custam zero (clipes); mostrar custo por minuto na UI (o app já mostra custo por resposta) |
| Tools longas faladas em voz entediam | política de voz: resposta falada concisa (persona) + opção "não executar tools nesta chamada" |
| Fim de turno errado (corta o usuário) | teto + heurística conservadora + fácil retomada (falar de novo interrompe e reabre o turno) |

---

## 8. Componentes candidatos (síntese da pesquisa de 2026-10-22)

Detalhes, fontes (51 URLs) e itens não verificados: `vinci-runtime/research/voice-state-of-art-2026-10-22.md`. Todos os preços abaixo: consultados em 2026-10-22.

### 8.1 VAD / fim de turno

| Necessidade | Recomendação | Alternativa | Notas |
|---|---|---|---|
| VAD | **Silero VAD v6** (MIT, ~309K params, ~1,2 MB, ONNX/WASM, CPU) | ten-vad (licença custom "Apache com condições" — ler LICENSE) | portes npm (`@fluidinference/fluidvad`) |
| Fim de turno (M2/M4) | **LiveKit TurnDetector `v1-mini`** (local, CPU, grátis, **14 idiomas com português**) | Smart Turn v3.2 do pipecat (BSD-2, 95 MB); Easy-Turn (GPU, licença não localizada) | começar com heurística nossa e comparar com o v1-mini |

### 8.2 STT (para o ditado M1 e o parcial da chamada M3+)

| Backend | pt-BR | Licença | Latência/tamanho | Preço |
|---|---|---|---|---|
| API `gpt-4o-mini-transcribe` (OpenAI) | sim | API | — | **US$ 0,003/min** |
| API Groq `whisper-large-v3-turbo` (OpenAI-compatível) | sim | API | — | **≈ US$ 0,00067/min** (fonte secundária; página oficial não renderizou) |
| API `gpt-transcribe` (OpenAI) | sim | API | — | US$ 0,0045/min (substituto do `whisper-1`, que parece descontinuado) |
| **Nemotron 3.5 ASR Streaming 0.6B** (NVIDIA) | **sim (pt-BR/pt-PT)** | OpenMDW 1.1 | streaming nativo, ~2,2 GB, GGUF (CPU), word-latency 450 ms | local |
| whisper.cpp large-v3-turbo | sim | MIT | janela rolante, word-latency ~1,2 s; referencial CPU | local |
| Vosk small-pt | sim | Apache-2.0 | ~39 MB, word-latency ~2 s | local (**o modelo grande pt-fb é GPL-3.0 — evitar**) |

Recomendação: **M1 = API** (Groq turbo ou `gpt-4o-mini-transcribe`); slot local = **Nemotron Streaming** (único streaming nativo com pt-BR verificado) ou whisper.cpp. **Moonshine está descartado (sem pt-BR).**

### 8.3 TTS (voz principal + geração dos clipes de interjeição)

| Opção | Licença (código/**pesos**) | pt-BR | Latência/1º áudio | Custo |
|---|---|---|---|---|
| **Kokoro-82M** (local, CPU) | Apache-2.0 / **Apache-2.0** | sim (vozes `pf`/`pm`; entonação irregular segundo a comunidade) | ~489 ms (blog terceiro) | grátis — **ideal para gerar os clipes** |
| **Chatterbox Multilingual V3** (local) | MIT / **MIT** | sim (fine-tune `Chatterbox-Multilingual-pt-br`) | ~5 s (GPU melhor; medido por terceiros) | grátis |
| Cartesia Sonic-3.6 (API) | API | sim | TTFA ~199 ms (terceiros) | ~US$ 0,06/min (voice agents) |
| ElevenLabs v4 Turbo (API) | API | sim | ~100 ms (autodeclarado) | US$ 0,04/1k chars |
| ~~OpenAI `tts-1` / `gpt-4o-mini-tts`~~ | API | sim | boa | **DEPRECIADOS (desligamento 06/01/2027) — não construir sobre eles** |

Alerta de mercado: "código permissivo + pesos restritivos" é o padrão — **XTTS-v2 é não-comercial irrecuperável** (Coqui fechou), F5-TTS/Spark-TTS têm pesos CC-BY-NC, MiniCPM-o 2.6 é proibido comercialmente com fala (ChatTTS CC-BY-NC). Para o app, só contam licenças permissivas nos **pesos**: Kokoro, Chatterbox, Orpheus, CSM-1B, Moshi/Mimi (esses 3 sem pt-BR).

### 8.4 Caminho principal / referências de arquitetura

| Item | Achado |
|---|---|
| Omni aberto (backend alternativo) | **Qwen3-Omni-30B-A3B** (Apache-2.0, fala streaming em **português** entrada e saída, 234 ms teóricos; GPU MoE pesada). "Qwen3.8-Omni-Flash" existe como API (OpenRouter US$ 0,15/0,47 por 1M), mas streaming de áudio de saída **não confirmado** nessa rota |
| Full-duplex de referência | **Moshi** (Kyutai, Apache-2.0) — modelagem multi-stream modela overlap/backchannel naturalmente; **inglês**, serve como arquitetura de estudo |
| Validação da nossa arquitetura | **`pipecat-backchannel`** implementa o mesmo desenho (§3.2 bloco 4); **LiveKit adaptive interruption** resolve o problema de backchannel × barge-in (§3.2 bloco 7) |
| Dados para treino pt-BR | **não existe dataset de backchannel em pt-BR** achado — reforça o shadow mode + coleta própria (M3→M4) |
| Pesquisa acadêmica | VAP/backchannel NAACL 2025 (arXiv 2410.15929 — base do MaAI); fusão acústico+LLM (arXiv 2401.14717); ICASSP 2020 listener-aware backchannel |

---

## 9. Decisões em aberto (para o usuário)

1. **STT do ditado:** API compatível — **Groq turbo ≈ US$ 0,00067/min** ou `gpt-4o-mini-transcribe` US$ 0,003/min (recomendado v1) × local (Nemotron Streaming 2,2 GB / whisper.cpp) × híbrido?
2. **Chamada = modo do agente existente** (recomendado) × agente novo?
3. **Voz principal (TTS):** local **Kokoro** (grátis, Apache, CPU, entonação pt-BR irregular) / **Chatterbox pt-br** (MIT, melhor, GPU) × API **Cartesia/ElevenLabs** (~US$ 0,04–0,06/min, latência ~100–200 ms)? (define os clipes e a identidade vocal; atenção: linha de TTS da OpenAI está depreciada)
4. **pt-BR primeiro** (recomendado) ou multilíngue desde o início?
5. **Chamada com tools liberadas** ou "só conversa" (mais seguro, mais simples)?
6. **Orçamento de hardware local:** o detector/ASR local precisa rodar em qual máquina?