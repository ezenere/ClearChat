# Estado da arte — Voz em tempo real com interjeições (backchannels) — 2026-10

Pesquisa web realizada em **2026-10-22** (data de acesso de todas as URLs abaixo).
Contexto: app desktop Electron, pt-BR, ditado por voz + "chamada de voz" agêntica com
interjeições curtas em baixa latência durante a fala do usuário. Preferência por pesos abertos.

---

## 1. VERIFICAÇÃO DE NOMES

| Nome citado | Veredito | O que realmente é | Licença | Evidência (acesso 2026-10-22) |
|---|---|---|---|---|
| "MaAI" | **EXISTE** (nome correto) | `MaAI-Kyoto/MaAI` — "Real-time Turn-taking, Backchannel, and Head-nodding Prediction for Full-duplex Interaction". Implementação em tempo real do Voice Activity Projection (VAP): prevê quando falar, quando dar backchannel e quando acenar. Modelo de backchannel (VapGPT_bc, adicionado em nov/2025) recebe áudio 2-canal 16 kHz (ch1 = usuário, ch2 = sistema) e devolve a probabilidade posterior `p_bc` do momento de interjeição | MIT | [github.com/maai-kyoto/maai](https://github.com/maai-kyoto/maai) · commits de backchannel 2025-11-10/19: [github.com/MaAI-Kyoto/MaAI/commit/d4f4367](https://github.com/MaAI-Kyoto/MaAI/commit/d4f436762625f48e6a6d085e6f2b38305b466f17) · paper base: [arxiv.org/abs/2410.15929](https://arxiv.org/abs/2410.15929) |
| "Easy-Turn" | **EXISTE** (nome correto) | Detector de troca de turno do ASLP-lab (NWPU + Huawei), paper ICASSP 2026. Modelo modular acústico+linguístico que prevê 4 estados: *complete*, *incomplete*, **backchannel** (momento de feedback curto) e *wait*. Vem com trainset aberto de 1.145 h (580 complete / 532 incomplete / **10 h de backchannel** / 23 wait) e testset | não localizada no model card (ver "NÃO VERIFICADO") | [huggingface.co/ASLP-lab/Easy-Turn](https://huggingface.co/ASLP-lab/Easy-Turn) · [arxiv.org/abs/2509.23938](https://arxiv.org/abs/2509.23938) · DOI 10.1109/ICASSP55912.2026.11463929 |
| "Qwen Omni Flash" | **NOME IMPRECISO** — a família real é **Qwen-Omni**; "Flash" existe como variante de API | Ver detalhes abaixo | — | ver abaixo |

**Detalhe Qwen-Omni** (linha do tempo real):

| Modelo | O que é | Pesos abertos / licença | Áudio em streaming | Onde roda | Fonte |
|---|---|---|---|---|---|
| Qwen3-Omni-30B-A3B (Instruct/Thinking/Captioner), set/2025 | Omni end-to-end MoE Thinker–Talker; entrada texto/áudio/imagem/vídeo, saída texto+**fala em tempo real**; fala em 10 idiomas de saída **incluindo português** e 19 de entrada (incl. português) | **Sim, Apache-2.0** | Sim ("real-time streaming responses in both text and natural speech") | vLLM/Transformers (GPU pesada; MoE), API DashScope | [github.com/QwenLM/Qwen3-Omni](https://github.com/QwenLM/Qwen3-Omni) · latência total (áudio) **234 ms** teórica, 1 concorrência, vLLM+torch.compile: [arxiv.org/abs/2509.17765](https://arxiv.org/abs/2509.17765) |
| "Qwen3-Omni-Flash" (API) | Variante grande servida via DashScope (Thinker–Talker MoE, fala em 20 idiomas) | Não (API) | Sim | API Alibaba | [qwencloud.com/models/qwen3-omni-flash](https://www.qwencloud.com/models/qwen3-omni-flash) |
| Qwen3.8-Omni-Flash, 21/09/2026 | Omni-modal com raciocínio, áudio+vídeo nativo, contexto 1M; "o primeiro Qwen construído em torno de capacidades agênticas" | Não localizado (API) | Via API "Qwen-Omni-Realtime" (áudio→áudio em tempo real); via OpenRouter a modalidade de saída de áudio em streaming **não foi confirmada** | OpenRouter `qwen/qwen3.8-omni-flash`: **US$ 0,15 / US$ 0,47 por 1M tokens** (in/out); latência P50 ≈ 2,0 s, TTFT/throughput P50 57 tok/s | [openrouter.ai/qwen/qwen3.8-omni-flash](https://openrouter.ai/qwen/qwen3.8-omni-flash) · [docs Alibaba Qwen-Omni-Realtime](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/realtime) |

Nota: "Qwen3.5-Omni" (mar/2026, citado como sucessor do Qwen3-Omni-Flash) só apareceu em fonte secundária — ver "NÃO VERIFICADO".

---

## 2. VAD e detecção de fim de turno (end-of-turn)

| Ferramenta | O que é | Licença | Tamanho / latência | Onde roda | Fonte |
|---|---|---|---|---|---|
| **Silero VAD v6.x** (v6.2.1 citado em portes) | VAD streaming STFT+CNN+LSTM, saída de probabilidade de fala por frame de 32 ms (512 samples @16 kHz) | **MIT** (repo e pesos) | ~309K params, ~1,2 MB; roda em CPU (PyTorch ou ONNX Runtime em qualquer arquitetura); portes WASM para browser/Node (`@fluidinference/fluidvad`, MIT) e MLX/CoreML | local, CPU, web, Node | [github.com/snakers4/silero-vad](https://github.com/snakers4/silero-vad) · [huggingface.co/mlx-community/silero-vad-v6](https://huggingface.co/mlx-community/silero-vad-v6) · [npmjs.com/package/@fluidinference/fluidvad](https://www.npmjs.com/package/@fluidinference/fluidvad) |
| **ten-vad** (TEN Framework / Agora) | VAD de baixa latência, detecção por frame, ONNX (~560 KB) + libs pré-compiladas (C/Python/Go/WASM) | **"Apache-2.0 com condições" (licença custom — a docs da sherpa-onnx avisa para ler a LICENSE antes de uso comercial)** | lib 306 KB; RTF 0,015 em AMD Ryzen (número autodeclarado pela TEN); WASM disponível desde 11/2025 | local, CPU, web | [github.com/ten-framework/ten-vad](https://github.com/ten-framework/ten-vad) · [theten.ai/docs/ten_vad](https://theten.ai/docs/ten_vad) · [k2-fsa.github.io/sherpa/onnx/vad/ten-vad.html](https://k2-fsa.github.io/sherpa/onnx/vad/ten-vad.html) |
| WebRTC VAD | VAD clássico (GMM) do projeto WebRTC, muito usado como baseline | não verificada neste levantamento | extremamente leve, CPU | local | não pesquisado a fundo (ver "NÃO VERIFICADO") |
| **Smart Turn v3.2** (pipecat) | Modelo aberto de detecção de fim de turno em áudio nativo (não é só silêncio: entende se a fala terminou) | **BSD-2-Clause** | 95 MB, 27 ms de inferência (medido por terceiros em RTX 4090, ver Easy-Turn) | local (GPU/CPU) | [github.com/pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn/) |
| **LiveKit TurnDetector** | Detector de fim de turno em áudio puro (sem transcrição), combina semântica + entonação; versões `v1` (hospedado na LiveKit Inference) e `v1-mini` (local, CPU, grátis) | `v1-mini` livre de uso; `v1` incluso no LiveKit Cloud / pago self-hosted | 14 idiomas **incluindo português**; thresholds por idioma | local (mini) ou API (v1) | [docs.livekit.io/agents/logic/turns/turn-detector](https://docs.livekit.io/agents/logic/turns/turn-detector/) |
| **Easy-Turn** | vê seção 1; classifica inclusive o estado *backchannel* | não localizada | 850 MB; 263 ms (RTX 4090); ACC_bc 91% | GPU | [huggingface.co/ASLP-lab/Easy-Turn](https://huggingface.co/ASLP-lab/Easy-Turn) |
| TEN Turn Detection | Detector de turno baseado em texto (precisa de ASR antes) | repo `ten-framework/ten-turn-detection` | 7.220 MB (com Paraformer), 204 ms | GPU/serve | comparado em [huggingface.co/ASLP-lab/Easy-Turn](https://huggingface.co/ASLP-lab/Easy-Turn) |

O que os frameworks usam hoje: **pipecat** — "user turn strategies" (VAD analyzer, timeout de fala, fim de turno por transcrição) + Smart Turn; **LiveKit Agents** — VAD (Silero) + TurnDetector em camadas + endpointing ([docs.pipecat.ai/pipecat/learn/speech-input](https://docs.pipecat.ai/pipecat/learn/speech-input) · [docs.livekit.io/agents/build/turn-detection](https://docs.livekit.io/agents/build/turn-detection/)).

---

## 3. STT streaming de baixa latência (pesos abertos) + APIs compatíveis

| Motor | Streaming nativo? | pt-BR | Licença | Latência / tamanho | CPU? | Fonte |
|---|---|---|---|---|---|---|
| **Nemotron 3.5 ASR Streaming 0.6B** (NVIDIA, 2026) | **Sim** (FastConformer+RNNT cache-aware, feito para voice agents) | **Sim (pt-BR e pt-PT entre os 19 locales "transcription-ready"; 40 locales no total)** | **OpenMDW 1.1** (permissiva) | word-emission latency 450 ms (benchmark terceiros); ~2,2 GB; export **GGUF** disponível (CPU viável, sem número medido) | sim (GGUF) | [huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) · latência: [picovoice.ai/products/voice/streaming-speech-to-text](https://picovoice.ai/products/voice/streaming-speech-to-text/) (benchmark de fabricante) |
| **whisper.cpp** (large-v3-turbo) | Parcial: janela rolante de 500 ms–3 s, "mini-batch" concatenado | Sim (Whisper multilíngue ~99 idiomas) | MIT | word-emission latency 1.240 ms (Base, benchmark Picovoice) | sim (o referencial em CPU) | [github.com/ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [dev.to/voxrtio/streaming-asr-vs-whisper-on-mobile-2026-08-18](https://dev.to/voxrtio/streaming-asr-vs-whisper-on-mobile-when-to-switch-5cm7) |
| **faster-whisper** | Não (lote; até 4x mais rápido que openai/whisper) | Sim | MIT | — | sim | [github.com/SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| **Vosk** (`vosk-model-small-pt-0.3`) | Sim (API de streaming contínuo) | Sim | API Apache-2.0; small models Apache-2.0 (exceto checo, MIT). **Cuidado: o modelo grande pt (`vosk-model-pt-fb-v0.1.1`, 1,3 GB) é GPL-3.0** | small pt ≈ 39 MB, ~300 MB RAM; word-emission latency 2.000 ms (benchmark Picovoice) | sim (RPi/celular) | [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models) · licenças dos small: [huggingface.co/localstack/vosk-models](https://huggingface.co/localstack/vosk-models) · GPL do pt-fb: [github.com/alphacep/vosk-api/issues/971](https://github.com/alphacep/vosk-api/issues/971) |
| **Moonshine Streaming** | Sim (modelos streaming por idioma) | **NÃO tem pt-BR** (idiomas: en, ar, de, ja, zh, es, tl, vi, ko, uk) | MIT nos modelos streaming; **modelos antigos não-streaming fora de inglês são "Moonshine Community License" (não comercial)** | Medium 245M: 59 ms (MacBook Pro, doc do fabricante); 6,65% WER en | sim | [moonshine-voice.readthedocs.io/en/stable/models/available-models](https://moonshine-voice.readthedocs.io/en/stable/models/available-models/) · [github.com/moonshine-ai/moonshine/blob/main/LICENSE](https://github.com/moonshine-ai/moonshine/blob/main/LICENSE) |
| **Parakeet-TDT-0.6B-v3** (NVIDIA) | Não nativo (offline; transcrição de alta vazão) | Sim (25 línguas europeias) | **CC-BY-4.0** | 0,6B; GGUF disponível | sim (com quantização) | [huggingface.co/nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| **Canary-1B-v2** (NVIDIA) | Não (ASR+AST lote) | Sim (25 línguas europeias) | não conferida (ver "NÃO VERIFICADO") | 1B | GPU melhor | [huggingface.co/nvidia/canary-1b-v2](https://huggingface.co/nvidia/canary-1b-v2) |

**Melhor opção para parcial em tempo real em pt-BR em CPU:** (1) **Nemotron 3.5 ASR Streaming** se ~2 GB de modelo couberem (único streaming nativo com pt-BR verificado); (2) **whisper.cpp large-v3-turbo** com janela rolante (melhor acurácia em pt, latência de palavra ~1,2 s — ok para ditado, apertado para detecção de oportunidade de interjeição); (3) **Vosk small pt** se footprint mínimo for crítico (aceitando latência ~2 s e acurácia antiga). Moonshine está descartado por não ter pt.

**APIs compatíveis com `/audio/transcriptions`** (preços consultados em 2026-10-22):

| Modelo | Preço estimado | Observações | Fonte |
|---|---|---|---|
| `gpt-transcribe` (OpenAI) | **US$ 0,0045/min** | substituto atual do whisper-1 | [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing) |
| `gpt-4o-transcribe` | **US$ 0,006/min** (US$ 2,50/10,00 in/out por 1M tokens) | JSON | idem |
| `gpt-4o-mini-transcribe` | **US$ 0,003/min** | JSON | idem |
| `gpt-live-transcribe` / `gpt-realtime-whisper` | **US$ 0,017/min** | transcrição *live* (streaming) | idem |
| Groq `whisper-large-v3-turbo` | **≈ US$ 0,00067/min** (US$ 0,04/h) | endpoint OpenAI-compatível `https://api.groq.com/openai/v1/audio/transcriptions`; preço só em fontes secundárias (divergência: US$ 0,0006/min em outra) | [console.groq.com/docs/speech-to-text](https://console.groq.com/docs/speech-to-text) · [tokenprice.fyi/speech-to-text](https://tokenprice.fyi/speech-to-text) (jul/2026) |
| `whisper-1` (OpenAI) | US$ 0,006/min (fontes secundárias) | **não aparece mais na página de preços atual** — provável descontinuação; não confirmada | [docs.routerbench.com/features/audio](https://docs.routerbench.com/features/audio) |

---

## 4. TTS de baixa latência

### Pesos abertos — ATENÇÃO ÀS LICENÇAS

| Modelo | Licença (código / **pesos**) | pt-BR | Latência / qualidade | Onde roda | Fonte |
|---|---|---|---|---|---|
| **Kokoro-82M** | Apache-2.0 / **Apache-2.0** (raro: permissiva nos dois) | **Sim (vozes brasileiras `pf`/`pm`; qualidade de entonação em pt-BR é apontada como irregular pela comunidade)** | 82M, CPU; ~489 ms até 1º áudio e 15,3x tempo real em M4 (medição de blog terceiro); 4–5x RT aquecido | CPU/local | [huggingface.co/hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) · [github.com/cool-japan/voirs (lista 9 idiomas incl. pt-BR)](https://github.com/cool-japan/voirs/blob/master/examples/KOKORO_EXAMPLES.md) · [github.com/remsky/Kokoro-FastAPI/issues/293](https://github.com/remsky/Kokoro-FastAPI/issues/293) |
| **Chatterbox Multilingual V3** (Resemble) | MIT / **MIT** (0,5B backbone Llama) | **Sim (pt-pt e pt-br; há fine-tune dedicado `ResembleAI/Chatterbox-Multilingual-pt-br`)** | 25 idiomas; zero-shot clonagem; marca d'água PerTh embutida; "Turbo" ~5,07 s até 1º áudio em M4/PyTorch (blog terceiro — bug MPS conhecido pode empurrar p/ CPU) | local (GPU melhor) | [github.com/resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) · [huggingface.co/ResembleAI/Chatterbox-Multilingual-pt-br](https://huggingface.co/ResembleAI/Chatterbox-Multilingual-pt-br) · [resemble.ai/learn/models/chatterbox-multilingual](https://www.resemble.ai/learn/models/chatterbox-multilingual) |
| **Orpheus-TTS** (Canopy) | **Apache-2.0** (repo) | inglês (multilingue não verificado) | 3B, LLM-backbone; streaming de áudio com tokens de latência baixa | GPU | [github.com/canopyai/Orpheus-TTS/blob/main/LICENSE](https://github.com/canopyai/Orpheus-TTS/blob/main/LICENSE) |
| **CSM-1B** (Sesame) | **Apache-2.0** | inglês | 1B, geração *conversacional* (condicionada em contexto de diálogo); HF com acesso gated | GPU | [github.com/SesameAILabs/csm](https://github.com/SesameAILabs/csm) · [huggingface.co/sesame/csm-1b](https://huggingface.co/sesame/csm-1b) |
| **Dia-1.6B** (Nari Labs) | **Apache-2.0** | inglês | diálogo multi-falante `[S1]/[S2]`, risos/efeitos | GPU | [huggingface.co/nari-labs/Dia-1.6B](https://huggingface.co/nari-labs/Dia-1.6B/blob/main/README.md) |
| **XTTS-v2** (Coqui) | código MPL-2.0 / **pesos: Coqui Public Model License — SOMENTE NÃO COMERCIAL. A Coqui fechou em jan/2024: licença comercial irrecuperável** | Sim (pt-BR entre os idiomas suportados — não conferido nesta rodada) | 17 idiomas, clonagem zero-shot | local/GPU | [huggingface.co/tts-hub/XTTS-v2/LICENSE.txt](https://huggingface.co/tts-hub/XTTS-v2/raw/main/LICENSE.txt) |
| **F5-TTS** | MIT / **pesos CC-BY-NC-4.0 (não comercial)** | não (zh/en principalmente) | não é tempo real: 0,09x RT em M4 (blog terceiro) | GPU | [github.com/SWivid/F5-TTS](https://github.com/SWivid/F5-TTS) · pesos: [michaelservices.net/notes/the-local-tts-license-trap](https://www.michaelservices.net/notes/the-local-tts-license-trap) (2026-08-25) |
| **Spark-TTS** | Apache-2.0 / **pesos CC-BY-NC-SA-4.0 (não comercial)** | não confirmado | 0,5B, controle de atributos | GPU | [github.com/SparkAudio/Spark-TTS/blob/main/LICENSE](https://github.com/SparkAudio/Spark-TTS/blob/main/LICENSE) · pesos: mesma fonte do blog acima |
| **Moshi/Mimi** (Kyutai) | **Apache-2.0** | não (inglês) | codec neural streaming (Mimi), full-duplex — ver seção 5 | CPU/GPU | [github.com/kyutai-labs/moshi](https://github.com/kyutai-labs/moshi/) |

Padrão de mercado 2026 (fonte secundária, conferir sempre): **código permissivo + pesos restritivos** — "leia a licença dos pesos, não o README" ([michaelservices.net/notes/the-local-tts-license-trap](https://www.michaelservices.net/notes/the-local-tts-license-trap), 2026-08-25).

### APIs de TTS

| API | Preço | Latência de 1º áudio | Observações | Fonte |
|---|---|---|---|---|
| OpenAI `tts-1` / `tts-1-hd` / `gpt-4o-mini-tts` | US$ 15 / US$ 30 por 1M caracteres; `gpt-4o-mini-tts` US$ 0,60/1M tokens texto + US$ 12/1M tokens áudio ≈ US$ 0,015/min | boa | **DEPRECIADOS em 01/10/2026, desligamento em 06/01/2027**; migração recomendada: `gpt-realtime-2.1-mini` (Realtime API, fora de `/audio/speech`) | [developers.openai.com/api/docs/guides/text-to-speech](https://developers.openai.com/api/docs/guides/text-to-speech) |
| ElevenLabs v4 / v4 Turbo | US$ 0,08 / US$ 0,04 por 1K caracteres | **~100 ms (v4 Turbo, autodeclarado)** | 90+ idiomas; Flash v2.5: preço divergente entre fontes (US$ 40–50/1M chars) | [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api) · [forasoft.com/blog/article/elevenlabs-alternatives](https://www.forasoft.com/blog/article/elevenlabs-alternatives) |
| Cartesia Sonic-3.6 | planos em créditos (Free 20K/mês; Pro US$ 5); **voice agents US$ 0,06/min**; preço por caractere divergente entre fontes (US$ 30–49/1M chars) | TTFA 199 ms (Sonic, self-serve, medida de terceiros) | — | [cartesia.ai/pricing](https://www.cartesia.ai/pricing) · [aidailypost.com/news/cartesias-sonic-36-tts-model](https://aidailypost.com/news/cartesias-sonic-36-tts-model-adds) · [apiscout.dev/guides/elevenlabs-vs-cartesia-voice-ai-api-2026](https://apiscout.dev/guides/elevenlabs-vs-cartesia-voice-ai-api-2026) |

---

## 5. Full-duplex, interrupções, backchannels — sistemas e frameworks

| Sistema / framework | Como trata turnos / interrupções / backchannel | Licença / acesso | Fonte |
|---|---|---|---|
| **Moshi** (Kyutai) | Modelo único speech-to-speech com **modelagem multi-stream** (tokens de Moshi + do usuário empilhados por passo de tempo): modela *overlap*, **backchanneling** e interrupções naturalmente, sem VAD/ASR/TTS separados — "no speaker turns anymore" | **Apache-2.0** (código e pesos) | [arxiv.org/abs/2410.00037](https://arxiv.org/abs/2410.00037) · [kyutai.org/blog/2024-09-18-moshi-release](https://kyutai.org/blog/2024-09-18-moshi-release/) |
| **OpenAI Realtime API** | VAD de servidor (`server_vad`) e `semantic_vad` (modelo de turnos + semântica); fala do usuário durante resposta dispara `input_audio_buffer.speech_started` → cancela resposta (`interrupt_response`); `conversation.item.truncate` corrige o transcrit do trecho não tocado. `gpt-realtime-2.1` áudio US$ 32/64 por 1M tokens; `2.1-mini` US$ 10/20 | API paga | [developers.openai.com/api/docs/guides/realtime-vad](https://developers.openai.com/api/docs/guides/realtime-vad) · [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing) |
| **Gemini Live API** | "Barge-in: users can interrupt the model at any time"; servidor sinaliza `server_content.interrupted=true` e o cliente deve parar áudio imediatamente; **proactive audio** (áudio nativo): "ignora conversas ambientes... entende quando ouvir e quando ficar em silêncio" — é o comportamento comercial mais próximo de backchanneling seletivo; 70 idiomas | API paga | [ai.google.dev/gemini-api/docs/live-api](https://ai.google.dev/gemini-api/docs/live-api) · [ai.google.dev/gemini-api/docs/live-api/best-practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices) |
| **Sesame** (Maya/Miles) | Companions conversacionais; CSM-1B aberto (Apache-2.0) é o modelo base divulgado; novo voice model em 06/10/2026 apenas no app fechado | produto fechado; CSM aberto | [sesame.com/journal/crossing-the-uncanny-valley-of-voice](https://www.sesame.com/journal/crossing-the-uncanny-valley-of-voice) · [artrealmai.com/article/sesame-october-update](https://artrealmai.com/article/sesame-october-update-new-voice-model-ios-android) (fonte secundária) |
| **pipecat** + **pipecat-backchannel** | Pipecat: barge-in cancela LLM+TTS em voo. **`pipecat-backchannel` (integração comunitária, "maisterr") implementa EXATAMENTE o pipeline desejado**: clipes curtos ("mhm", "yeah", "right") **pré-gerados uma vez pelo próprio TTS do bot e cacheados em disco** (`.clip_cache/`), disparados em pausas que o turn-analyzer lê como *incompletas*; sem chamada de LLM no playback; VAD próprio (start/stop 0,2 s) + analyzer ONNX; volume 0,6; cooldown 2,5 s; `fire_probability` 0,8; `min_speech_before_eligible` 0,7 s; gate desligável por sessão | pipecat (framework open source); extensão comunitária | [docs.pipecat.ai/api-reference/server/extensions/pipecat-backchannel](https://docs.pipecat.ai/api-reference/server/extensions/pipecat-backchannel) (atualizado 2026-10-19) |
| **LiveKit Agents** | Multi-camadas para fim de turno (VAD + TurnDetector, ver seção 2) e **interrupção adaptativa** (Python SDK ≥1.5): um modelo acústico treinado em conversas reais **distingue interrupção intencional (barge-in) de backchanneling** ("uh-huh", "okay", "right") e filtra o segundo para não trocar de turno; "funciona com qualquer idioma, melhor em inglês"; suporta modelos realtime que cedem o turn-taking ao cliente (OpenAI Realtime sim; Gemini Live não) | open source (SDK); modelo `v1` sob LiveKit Inference | [docs.livekit.io/agents/logic/turns/adaptive-interruption-handling](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/) |
| **vode** ("Vocode") | Framework de telefonia/voice agents — não aprofundado nesta rodada | — | ver "NÃO VERIFICADO" |

**Pesquisa acadêmica sobre backchannel prediction** (3+ referências):
1. Inokoj et al., *"Yeah, Un, Oh: Continuous and Real-time Backchannel Prediction with Fine-tuning of Voice Activity Projection"* — **NAACL 2025** (long). Prevê timing de backchannel continuamente em tempo real; base do modelo de backchannel do MaAI. [aclanthology.org/2025.naacl-long.367](https://aclanthology.org/2025.naacl-long.367.pdf) · [arxiv.org/abs/2410.15929](https://arxiv.org/html/2410.15929)
2. Ortega, Meyer, Schweitzer, Vu (Univ. Stuttgart), *"Modeling Speaker-Listener Interaction for Backchannel Prediction"* (2023) — modelagem de "yeah"/"uh-huh" (en) e equivalentes (de), com codificação de interação falante-ouvinte. [arxiv.org/abs/2304.04472](https://arxiv.org/abs/2304.04472)
3. *"Turn-taking and Backchannel Prediction with Acoustic and Large Language Model Fusion"* (2024) — fusão de modelo acústico + LLM, avaliação em Switchboard. [arxiv.org/html/2401.14717](https://arxiv.org/html/2401.14717)
4. (extra) *"Oh, Jeez! or Uh-huh? A Listener-aware Backchannel Predictor on ASR Transcriptions"* — ICASSP 2020, [doi.org/10.1109/ICASSP40776.2020.9054223](https://doi.org/10.1109/icassp40776.2020.9054223)

**Datasets**: Switchboard (2.438 conversas telefônicas, 260 h, EN — citado em [IWSDS 2017 KIT](https://isl.iar.kit.edu/downloads/IWSDS2017_BC.pdf)); **Easy-Turn Trainset** (1.145 h, com 10 h rotuladas como estado *backchannel* — [huggingface.co/datasets/ASLP-lab/Easy-Turn-Trainset](https://huggingface.co/datasets/ASLP-lab/Easy-Turn-Trainset)); datasets japoneses do MaAI (readme `vap_bc_JP.md`). **Não foi encontrado dataset de backchannel em pt-BR** nesta rodada.

---

## 6. Modelos omni (áudio entrada+saída) para o caminho principal

| Modelo | Streaming de fala? | Licença | pt-BR (fala) | Latência realista | Adequação | Fonte |
|---|---|---|---|---|---|---|
| **Qwen3-Omni-30B-A3B** | Sim (texto+fala em tempo real) | **Apache-2.0** | **sim (entrada e saída)** | 234 ms de latência total (áudio) teórica, 1 concorrência (relatório Qwen); na prática cresce com concorrência; exige GPU (MoE) | melhor candidato aberto para resposta de voz; via API DashScope/`Qwen-Omni-Realtime` ou vLLM | [github.com/QwenLM/Qwen3-Omni](https://github.com/QwenLM/Qwen3-Omni) · [arxiv.org/abs/2509.17765](https://arxiv.org/abs/2509.17765) |
| **Moshi** (7B-ish + Mimi) | Sim, full-duplex nativo (fala enquanto ouve) | **Apache-2.0** | não (inglês) | projeto para ~tempo real em GPU; implementações MLX/CPU existem (não medido aqui) | ótimo como *arquitetura de referência*, não para pt-BR | [github.com/kyutai-labs/moshi](https://github.com/kyutai-labs/moshi/) |
| **GLM-4-Voice** (Zhipu) | Sim (conversa de voz em tempo real; controle de emoção/velocidade) | código Apache-2.0; **pesos `glm-4-voice-9b` sob licença custom: livre para pesquisa; uso comercial exige registro no formulário da Zhipu** | não (zh/en) | GPU; demo local | útil só como referência | [github.com/zai-org/GLM-4-Voice](https://github.com/zai-org/GLM-4-Voice) · [huggingface.co/zai-org/glm-4-voice-9b/blob/main/LICENSE](https://huggingface.co/zai-org/glm-4-voice-9b/blob/main/LICENSE) |
| **MiniCPM-o 2.6** (8B) | Sim (real-time speech dialogue + multimodal live streaming) | metadados Apache-2.0, **PORÉM: decoder de fala inicializado a partir do ChatTTS (CC-BY-NC 4.0) — mantenedor confirmou que NÃO pode ser usado comercialmente com geração de fala habilitada** | não (zh/en) | roda "on your phone" (claim OpenBMB); latência de streaming citada em issue #788 sem números consolidados | cuidado com a licença | [huggingface.co/openbmb/MiniCPM-o-2_6](https://huggingface.co/openbmb/MiniCPM-o-2_6) · [github.com/OpenBMB/MiniCPM-o/issues/903](https://github.com/OpenBMB/MiniCPM-o/issues/903) |
| **CSM-1B** | geração de fala conversacional por segmentos (não é omni de entrada de áudio) | **Apache-2.0** | não (en) | GPU | componente de TTS conversacional, não backbone omni | [github.com/SesameAILabs/csm](https://github.com/SesameAILabs/csm) |

---

## NÃO VERIFICADO / INCERTO

1. **Licença do Easy-Turn** (modelo/trainset): não aparece no model card do HF (a página avisa de `config.json` inválido). Confirmar no repositório ASLP-lab antes de uso comercial.
2. **Canary-1B-v2**: licença não conferida (Parakeet v3 é CC-BY-4.0; presumir o mesmo é arriscado).
3. **WebRTC VAD**: não pesquisado nesta rodada (licença, limitações, manutenção).
4. **Latência do Moshi** (frequentemente citada como "160 ms"): não confirmada no texto da fonte primária desta rodada.
5. **`whisper-1`** ainda disponível na OpenAI? Não consta na página de preços atual; status de descontinuação não confirmado.
6. **Qwen3.5-Omni**: mencionado apenas por fonte secundária (AudioLab) como sucessor do Qwen3-Omni-Flash; não confirmado em fonte primária.
7. **Qwen3.8-Omni-Flash via OpenRouter**: modalidades de entrada incluem áudio; **streaming de saída de áudio por essa rota não foi confirmado** (confirmado só via "Qwen-Omni-Realtime" da Alibaba).
8. **XTTS-v2 em pt-BR** e qualidade: não conferidos nesta rodada (só a licença restritiva).
9. **Preços divergentes entre fontes secundárias**: ElevenLabs Flash (US$ 40 vs 50/1M chars); Cartesia por caractere (US$ 30 vs 49/1M chars); Groq turbo (US$ 0,0006 vs 0,00067/min). A página oficial da Groq não renderizou; Cartesia hoje publica preços em créditos, não por caractere.
10. **Vocode** (vode): estado atual do projeto, licença e capacidades de barge-in não verificados.
11. **MaAI em pt-BR**: o README lista EN/ZH/JA; o modelo de backchannel tem variantes "multilingual", mas não há evidência de treino em português — assumir **sem suporte pt-BR** até teste.
12. **Latências "M4"** do blog michaelservices.net e "TTFA" da Cartesia/ElevenLabs: medidas de terceiros/fabricantes, não reproduzidas aqui.