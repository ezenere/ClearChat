// Áudio/voz — contratos da feature: configuração do DITADO (100% global, settings `audioInput`,
// `sttSettings`, `ttsSettings`) e da CHAMADA DE VOZ (por persona/chat em `ChatConfig.voice`, com os
// padrões globais herdados na setting `voiceCallDefaults`). Tudo JSON-serializável (nunca
// `undefined` nos writers) e pronto para sincronizar — o sync dessas configurações entra no
// protocolo 1.5.0 (fatia futura). A UI, a captura de áudio e os backends STT/TTS entram em fatias
// futuras. Ver SPEC.md → "Áudio".
import {
  normalizeToolList,
  type Chat,
  type ChatConfig,
  type ChatParams,
  type ToolName
} from './types'
import { planVoiceReasoning, type VoiceReasoningRules } from './voiceCallParams'

// ---------------- settings keys (tabela `settings`, JSON; ver SPEC → Banco) ----------------

/** Ditado: microfone, push-to-talk, silêncio e idioma (100% global). */
export const AUDIO_INPUT_SETTING = 'audioInput'
/** Transcrição de voz em texto (STT): modo, endpoint de API e motor local. */
export const STT_SETTINGS_SETTING = 'sttSettings'
/** Síntese de fala (TTS): backend, endpoint de API e motor local. */
export const TTS_SETTINGS_SETTING = 'ttsSettings'
/** Padrões globais da chamada de voz, herdados quando `ChatConfig.voice` tem null. */
export const VOICE_CALL_DEFAULTS_SETTING = 'voiceCallDefaults'

// ---------------- ditado: entrada de áudio (settings `audioInput`) ----------------

export interface AudioInputSettings {
  /** Microfone (deviceId do sistema); null = padrão do sistema. */
  deviceId: string | null
  /** Push-to-talk: a captura só corre enquanto a tecla (ou o botão) estiver pressionada (padrão true). */
  pttEnabled: boolean
  /** Tecla do push-to-talk (ex.: 'Ctrl+Shift+Space'); null = sem tecla (só clique/segurar no botão). */
  pttKey: string | null
  /** Encerra a captura sozinha quando o usuário para de falar (padrão true). */
  silenceStopEnabled: boolean
  /** Milissegundos de silêncio que encerram a captura (padrão 5000; 0 = ignora o limite). */
  silenceStopMs: number
  /** Idioma do ditado (seletor multilingue, ex.: 'pt-BR'; padrão 'pt-BR'). */
  language: string
}

export const DEFAULT_AUDIO_INPUT: AudioInputSettings = {
  deviceId: null,
  pttEnabled: true,
  pttKey: null,
  silenceStopEnabled: true,
  silenceStopMs: 5000,
  language: 'pt-BR'
}

// ---------------- transcrição (settings `sttSettings`) ----------------

/** Onde transcrever: API remota, motor local ou híbrido (API com fallback local). */
export type SttMode = 'api' | 'local' | 'hybrid'
export const STT_MODES: readonly SttMode[] = ['api', 'local', 'hybrid']

/** Motor de transcrição local. */
export type SttLocalEngine = 'whisper.cpp' | 'vosk' | 'nemotron'
export const STT_LOCAL_ENGINES: readonly SttLocalEngine[] = ['whisper.cpp', 'vosk', 'nemotron']

/** Endpoint de transcrição (API), no formato OpenAI `/audio/transcriptions`. */
export interface SttEndpointConfig {
  /** Provedor salvo (id de `providers`); null = endpoint avulso (baseUrl + apiKey). */
  providerId: string | null
  /** Base da API (padrão Groq: 'https://api.groq.com/openai/v1'). */
  baseUrl: string
  /** Chave da API (guardada no JSON da setting; a UI mostra mascarada). */
  apiKey: string
  /** Modelo de transcrição (padrão Groq: 'whisper-large-v3-turbo'). */
  model: string
}

export interface SttLocalConfig {
  /** Motor local (padrão ao instalar: 'whisper.cpp'). */
  engine: SttLocalEngine
  /** Modelo do motor (livre; vazio = o padrão do motor). */
  model: string
  /** O app detectou o motor instalado. */
  installed: boolean
}

export interface SttSettings {
  /** Onde transcrever (padrão 'api'). */
  mode: SttMode
  /** Endpoint de API (padrão: Groq `whisper-large-v3-turbo`). */
  api: SttEndpointConfig
  /** Motor local; null = nenhum instalado. */
  local: SttLocalConfig | null
  /** Transcrição ao vivo melhor-esforço enquanto o usuário fala (padrão true). */
  livePartials: boolean
  /**
   * Ditado: quando a última parcial já cobre a fala inteira (uma transcrição só do trecho final,
   * sem áudio falado depois dela), ela vira a final na hora — sem a request final (padrão true;
   * desligado = a final sempre transcreve o trecho de novo, um pouco mais preciso). A chamada de
   * voz sempre reaproveita (latência).
   */
  reusePartialFinal?: boolean
}

export const DEFAULT_STT_API: SttEndpointConfig = {
  providerId: null,
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  model: 'whisper-large-v3-turbo'
}

/**
 * Teto de tamanho do modelo local (whisper.cpp) para as parciais ao vivo por janelas: até o
 * `ggml-base` (~148 MB) cada janela volta em centenas de ms; do `small` para cima cada parcial custa
 * segundos de CPU e atrasaria a final — o runtime desliga as parciais e a UI avisa ("parciais
 * desligadas para este modelo"). SPEC → "Áudio → Runtime local de STT".
 */
export const STT_LOCAL_PARTIAL_MAX_MODEL_BYTES = 160_000_000

/** Aviso (pt-BR) de parciais locais desligadas para o modelo escolhido (sessão → UI). */
export const STT_LOCAL_PARTIALS_OFF_NOTICE =
  'Parciais ao vivo desligadas para este modelo local (grande demais para transcrever enquanto você fala) — o texto aparece nas pausas e quando você parar. Para ver o texto ao vivo, use o ggml-base ou o ggml-tiny.'

export const DEFAULT_STT_SETTINGS: SttSettings = {
  mode: 'api',
  api: { ...DEFAULT_STT_API },
  local: null,
  livePartials: true,
  reusePartialFinal: true
}

// ---------------- fala (settings `ttsSettings`) ----------------

/** Motor de síntese local. */
export type TtsLocalEngine = 'kokoro' | 'chatterbox'
export const TTS_LOCAL_ENGINES: readonly TtsLocalEngine[] = ['kokoro', 'chatterbox']

/** Endpoint de síntese (API). */
export interface TtsEndpointConfig {
  /** Provedor salvo (id de `providers`); null = endpoint avulso (baseUrl + apiKey). */
  providerId: string | null
  /** Base da API (padrão: vazia — endpoint não configurado até a UI preencher). */
  baseUrl: string
  /** Chave da API (guardada no JSON da setting; a UI mostra mascarada). */
  apiKey: string
  /** Modelo de síntese (padrão: vazio — não configurado). */
  model: string
  /** Voz pedida à API; null = a voz padrão da API. */
  voice: string | null
  /**
   * Tipo do provedor salvo (`providerId`), preenchido SÓ pelo main ao resolver o endpoint
   * (`getVoiceSettings`) — nunca gravado nem enviado ao renderer. `'elevenlabs'` = ElevenLabs
   * direta (REST `/v1/text-to-speech` + WebSocket na chamada — `voice/elevenlabs*.ts`).
   */
  providerKind?: string
}

export interface TtsLocalConfig {
  /** Motor local (padrão ao instalar: 'kokoro'). */
  engine: TtsLocalEngine
  /** Voz do motor (vazia/ausente → `DEFAULT_TTS_LOCAL.voice`). */
  voice: string
  /** O app detectou o motor instalado. */
  installed: boolean
}

export interface TtsSettings {
  /** Onde sintetizar (padrão 'local' — Kokoro). */
  backend: 'api' | 'local'
  /** Endpoint de API (padrão: não configurado). */
  api: TtsEndpointConfig
  /** Motor local (padrão: Kokoro não instalado); null = o usuário limpou explicitamente. */
  local: TtsLocalConfig | null
}

export const DEFAULT_TTS_API: TtsEndpointConfig = {
  providerId: null,
  baseUrl: '',
  apiKey: '',
  model: '',
  voice: null
}

/**
 * Motor local padrão: Kokoro, ainda não instalado (`installed: false` → a UI oferece o download).
 * Voz `'pf_dora'` CONFIRMADA (fatia de TTS): id da voz pt-BR feminina do Kokoro v1.0, conferido em
 * `hexgrad/Kokoro-82M` VOICES.md (as demais pt-BR são `pm_alex`/`pm_santa`).
 */
export const DEFAULT_TTS_LOCAL: TtsLocalConfig = {
  engine: 'kokoro',
  voice: 'pf_dora',
  installed: false
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  backend: 'local',
  api: { ...DEFAULT_TTS_API },
  local: { ...DEFAULT_TTS_LOCAL }
}

// ---------------- chamada de voz (persona/chat — `ChatConfig.voice`) ----------------

/** Classes de interjeição falada que o modo voz pode soltar na fala do usuário. */
export type InterjectionClass = 'ACK' | 'AGREEMENT' | 'ENCOURAGEMENT' | 'THINKING'
export const INTERJECTION_CLASSES: readonly InterjectionClass[] = [
  'ACK',
  'AGREEMENT',
  'ENCOURAGEMENT',
  'THINKING'
]

export interface InterjectionPolicy {
  /** Liga as interjeições (padrão true). */
  enabled: boolean
  /** Modo sombra: o app decide mas não toca áudio (padrão false) — calibra as regras sem interromper. */
  shadow: boolean
  /** Intervalo mínimo entre interjeições, em ms (padrão 5000 — backchannel discreto). */
  cooldownMs: number
  /** Probabilidade de disparar quando as regras deixam (0–1; padrão 0.5). */
  fireProbability: number
  /** Fala do usuário (ms) antes de uma interjeição poder sair (padrão 700). */
  minSpeechMs: number
  /** Pausa do usuário (ms) em que a interjeição pode entrar (padrão 450). */
  minPauseMs: number
  /**
   * Classes permitidas (padrão: só `ACK` — "Uhum."/"Aham." no meio da fala; as demais ficam
   * opcionais). Lista vazia volta ao padrão.
   */
  classes: InterjectionClass[]
  /** Volume relativo do clipe de interjeição (0–1, multiplica o volume da chamada; padrão 0.6). */
  volume: number
}

/** Classes padrão das interjeições: só o backchannel neutro (`ACK` = "Uhum."/"Aham."). */
export const DEFAULT_INTERJECTION_CLASSES: readonly InterjectionClass[] = ['ACK']

export const DEFAULT_INTERJECTION_POLICY: InterjectionPolicy = {
  enabled: true,
  shadow: false,
  cooldownMs: 5000,
  fireProbability: 0.5,
  minSpeechMs: 700,
  minPauseMs: 450,
  classes: [...DEFAULT_INTERJECTION_CLASSES],
  volume: 0.6
}

/** Falas preenchidoras ("ãh", "só um minutinho…") enquanto o modelo pensa. */
export interface VoiceFillers {
  /** Liga as falas preenchidoras (padrão true). */
  enabled: boolean
  /** Prompt das falas preenchidoras; null = o padrão. */
  prompt: string | null
}

/**
 * Contexto do turno do usuário que escolhe o preâmbulo (filler) — `classifyFillerContext` em
 * `@shared/voicePolicy`: pergunta, comando/tarefa com tool, correção/interrupção ("não", "peraí"),
 * pedido longo/complexo ou genérico.
 */
export type FillerContext = 'question' | 'command' | 'correction' | 'complex' | 'generic'
export const FILLER_CONTEXTS: readonly FillerContext[] = [
  'question',
  'command',
  'correction',
  'complex',
  'generic'
]

/** Uma frase do pool de preâmbulos (vira o clipe `FILLER_<n>` — n = posição 1-based no pool). */
export interface FillerPhrase {
  /** Texto falado (pt-BR por extenso — nada de "Hmm": o TTS soletra/anglicaniza). */
  text: string
  /** Contextos em que a frase cabe (lista vazia = `generic`). */
  contexts: FillerContext[]
}

/** Máximo de frases no pool de preâmbulos (= máximo de clipes `FILLER_<n>`). */
export const FILLER_POOL_MAX = 16

/**
 * Pool padrão de preâmbulos (~0,6–1,4 s cada, pronunciáveis por Kokoro e ElevenLabs — o benchmark
 * mostrou que "Hum, deixa eu ver." funciona nos dois e "Hum…"/"Hmm" soltos não). A chamada toca UM
 * logo depois do turno (ponte até a 1ª frase da resposta), escolhido pelo contexto, sem repetir
 * nenhum dos últimos `FILLER_RECENT_WINDOW` usados.
 */
export const DEFAULT_FILLER_POOL: readonly FillerPhrase[] = [
  { text: 'Hum, deixa eu ver aqui.', contexts: ['question', 'generic'] },
  { text: 'Boa pergunta, deixa eu pensar.', contexts: ['question'] },
  { text: 'Hum, deixa eu ver.', contexts: ['question', 'generic'] },
  { text: 'Beleza, só um minutinho.', contexts: ['command'] },
  { text: 'Tá, deixa eu ver isso.', contexts: ['command', 'generic'] },
  { text: 'Certo, já vejo isso.', contexts: ['command'] },
  { text: 'Ah, tá, peraí.', contexts: ['correction'] },
  { text: 'Entendi, deixa eu rever.', contexts: ['correction'] },
  { text: 'Ah, entendi, um instante.', contexts: ['correction'] },
  { text: 'Deixa eu ver isso com calma.', contexts: ['complex'] },
  { text: 'Então, deixa eu ver.', contexts: ['complex', 'generic'] },
  { text: 'Um instante.', contexts: ['command', 'generic'] }
]

/** Padrões GLOBAIS dos fillers (`voiceCallDefaults.fillers`): o pool e o tempo valem para todos os chats. */
export interface VoiceFillerDefaults extends VoiceFillers {
  /**
   * Espera entre o turno enviado e o preâmbulo (ms; padrão 250, 0 = já): se a 1ª frase da resposta
   * ficar pronta antes disso, o preâmbulo nem sai.
   */
  delayMs: number
  /** Pool de preâmbulos; null = `DEFAULT_FILLER_POOL` (mudou → os clipes são regerados). */
  pool: FillerPhrase[] | null
}

/** Espera padrão do preâmbulo depois do turno enviado (ms). */
export const DEFAULT_FILLER_DELAY_MS = 250

/** Modelo próprio da chamada de voz (null = herda o modelo do chat). */
export interface VoiceCallModelConfig {
  /** Provedor (id de `providers`). */
  providerId: string
  /** Modelo de chat usado na conversa por voz. */
  model: string
  /** Params do modelo (mesma semântica de `ChatParams`; chaves desconhecidas são preservadas). */
  params: ChatParams
}

/** Tools da chamada de voz (null em cada campo = igual ao chat). */
export interface VoiceCallToolsConfig {
  /** Tools liberadas; null = as do chat (alias antigos mapeados, sem duplicatas). */
  enabledTools: ToolName[] | null
  /** Teto de caracteres do resultado de cada tool; null = o do chat. */
  maxToolOutputChars: number | null
}

/**
 * Configuração da chamada de voz por persona/chat (`ChatConfig.voice`). Cada campo `null` herda o
 * padrão: `enabled`/`fillers`/`interjections` de `voiceCallDefaults` (global); `model`/`tools` do
 * chat. Ausente = tudo null (= segue os padrões). Ver SPEC → "Áudio → Chamada de voz".
 */
export interface VoiceCallConfig {
  /** Liga a chamada de voz; null = segue o padrão global (`voiceCallDefaults.enabled`). */
  enabled: boolean | null
  /** Modelo próprio da chamada de voz; null = herda o modelo do chat. */
  model: VoiceCallModelConfig | null
  /** Tools próprias da chamada de voz; null = igual ao chat. */
  tools: VoiceCallToolsConfig | null
  /** Prompt do modo voz (fala, estilo…); null = sem prompt próprio (o modo diz como compõe). */
  voicePrompt: string | null
  /**
   * Como o prompt do modo voz compõe com o system prompt do chat/persona nos turnos da chamada;
   * null/ausente = herda (persona → `'append'`). Ver `VoiceCallPromptMode`.
   */
  promptMode?: VoiceCallPromptMode | null
  /** Falas preenchidoras; null = segue o padrão global. */
  fillers: VoiceFillers | null
  /** Política de interjeições; null = segue o padrão global. */
  interjections: InterjectionPolicy | null
}

/**
 * Composição do prompt nos turnos de voz (o prompt-base global entra em `append` e `replace`,
 * salvo desligado em Configurações → Áudio; nunca em `none`):
 * - `append` (complementar, padrão): system prompt do chat + prompt-base + prompt do modo voz;
 * - `replace` (substituto): prompt-base + prompt do modo voz NO LUGAR do system prompt do chat
 *   (prompt do modo voz vazio → nada a pôr no lugar: vale como `append`);
 * - `none` (nenhum): só o system prompt do chat — sem prompt-base nem prompt do modo voz.
 */
export type VoiceCallPromptMode = 'append' | 'replace' | 'none'
export const VOICE_CALL_PROMPT_MODES: readonly VoiceCallPromptMode[] = ['append', 'replace', 'none']

/**
 * Padrões GLOBAIS da chamada de voz (setting `voiceCallDefaults`). Por padrão a chamada está
 * **disponível** (ligada aqui, com interjeições e fillers): dá para desligar globalmente nestes
 * padrões ou por chat/persona em `VoiceCallConfig.enabled: false`.
 */
export interface VoiceCallDefaults {
  /** Chamada de voz ligada por padrão (padrão true). */
  enabled: boolean
  /** Política de interjeições padrão. */
  interjections: InterjectionPolicy
  /** Falas preenchidoras padrão (+ pool de preâmbulos e espera — globais). */
  fillers: VoiceFillerDefaults
  /** Turnos da chamada (silêncio que encerra a fala do usuário; fim de turno adaptativo). */
  turn: VoiceCallTurnConfig
  /**
   * Modelo da chamada padrão (provider/model/params) para chats/personas sem modelo próprio na
   * chamada; null = o modelo do próprio chat. O `max_tokens` dos turnos de voz só existe aqui (nos
   * params), como qualquer parâmetro do modelo — a chamada não impõe teto próprio.
   */
  model: VoiceCallModelConfig | null
  /** Prompt-base do modo voz somado ao system prompt (ligado por padrão). */
  basePromptEnabled: boolean
  /** Texto do prompt-base; null = `DEFAULT_VOICE_BASE_PROMPT`. */
  basePrompt: string | null
}

/**
 * Turnos da chamada de voz (setting `voiceCallDefaults.turn`). `silenceStopMs: 0` é tratado como
 * `null` (na chamada o turno SEMPRE tem limite de silêncio — sem limite não há turnos).
 *
 * **Fim de turno adaptativo** (`adaptive`, padrão ligado): aos `speculativeAtMs` de pausa o app
 * transcreve o que já foi dito (transcrição especulativa — motor local; API só com
 * `speculativeApi`) e o silêncio exigido passa a depender de como a fala termina
 * (`classifyUtteranceEnd` em `@shared/voiceTurn`): completa (pergunta/comando/fecho) →
 * `completeSilenceMs`; afirmação → `statementSilenceMs`; inacabada (conectivo, vírgula,
 * hesitação) → `unfinishedSilenceMs`. Sem transcrição especulativa vale `silenceStopMs`. A
 * transcrição especulativa vira a final quando o usuário não voltou a falar (sem 2ª chamada).
 */
export interface VoiceCallTurnConfig {
  /**
   * Ms de silêncio contínuo que ENCERRAM a fala do usuário quando NÃO há transcrição especulativa
   * (adaptativo desligado/indisponível). `null` = o padrão (`DEFAULT_TURN_SILENCE_MS`) —
   * independente do auto-stop do ditado (`audioInput.silenceStopMs`, 5 s, longo demais para turno).
   */
  silenceStopMs: number | null
  /** Fim de turno adaptativo com transcrição especulativa (padrão true). */
  adaptive: boolean
  /** Pausa (ms) em que a transcrição especulativa dispara (padrão 250). */
  speculativeAtMs: number
  /** Silêncio (ms) que fecha uma fala COMPLETA — pergunta, comando, fecho (padrão 600). */
  completeSilenceMs: number
  /** Silêncio (ms) que fecha uma AFIRMAÇÃO (ponto final do STT — pode ser história no meio; padrão 1200). */
  statementSilenceMs: number
  /** Silêncio (ms) que fecha uma fala INACABADA — conectivo/vírgula/hesitação; é o teto (padrão 1500). */
  unfinishedSilenceMs: number
  /** Permite a transcrição especulativa pela API no modo 'api' (custa 1 request por pausa; padrão false). */
  speculativeApi: boolean
}

/** Silêncio de turno padrão da chamada sem transcrição especulativa (ms). */
export const DEFAULT_TURN_SILENCE_MS = 1000

export const DEFAULT_VOICE_CALL_TURN: VoiceCallTurnConfig = {
  silenceStopMs: null,
  adaptive: true,
  speculativeAtMs: 250,
  completeSilenceMs: 600,
  statementSilenceMs: 1200,
  unfinishedSilenceMs: 1500,
  speculativeApi: false
}

/**
 * Prompt-base do modo voz (somado ao system prompt nos turnos da chamada, antes do `voicePrompt`
 * do chat): respostas curtas, sem markdown, sem narrar falhas internas, e o aviso de que a fala
 * vem de transcrição automática (maiúsculas/acentos podem estar errados — "SRC" pode ser "src").
 */
export const DEFAULT_VOICE_BASE_PROMPT = [
  'Você está numa conversa por voz: sua resposta será lida em voz alta.',
  'A primeira frase tem no máximo 10 palavras e vai direto ao ponto. No máximo 3 frases curtas no total.',
  'Sem markdown, listas, títulos, tabelas, emojis ou blocos de código — escreva como se fala.',
  'Não narre tentativas internas nem erros de ferramentas em detalhe: se algo falhar, diga em uma frase curta o que houve e o que vai fazer.',
  'A fala do usuário vem de transcrição automática e pode ter maiúsculas, acentos ou palavras erradas (ex.: "SRC" pode ser a pasta "src"); interprete pela intenção e, em nomes de arquivos e pastas, tente a grafia em minúsculas antes de concluir que não existe.'
].join(' ')

export const DEFAULT_VOICE_CALL_DEFAULTS: VoiceCallDefaults = {
  enabled: true,
  interjections: { ...DEFAULT_INTERJECTION_POLICY, classes: [...DEFAULT_INTERJECTION_CLASSES] },
  fillers: { enabled: true, prompt: null, delayMs: DEFAULT_FILLER_DELAY_MS, pool: null },
  turn: { ...DEFAULT_VOICE_CALL_TURN },
  model: null,
  basePromptEnabled: true,
  basePrompt: null
}

/** Config "vazia": tudo null = herda os padrões globais (`voiceCallDefaults`) e o próprio chat. */
export const DEFAULT_VOICE_CALL_CONFIG: VoiceCallConfig = {
  enabled: null,
  model: null,
  tools: null,
  voicePrompt: null,
  fillers: null,
  interjections: null
}

// ---------------- normalizadores ----------------

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** String não vazia, aparada; vazio/não-string → null. */
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/** String não vazia, aparada; vazio/não-string → o padrão. */
const strOr = (v: unknown, def: string): string =>
  typeof v === 'string' && v.trim() ? v.trim() : def

const boolOr = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)

/** Inteiro ≥ 0 (0 válido — significado próprio, ex. `silenceStopMs: 0` = ignora o limite); inválido → padrão. */
const intOr = (v: unknown, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  return Number.isNaN(n) || n < 0 ? def : n
}

/** Inteiro ≥ 0 ou null (null = "igual ao chat"); inválido → null. */
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  return Number.isNaN(n) ? null : Math.max(0, n)
}

/** Texto de prompt (sem CR); vazio/não-string → null. */
const promptOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.replace(/\r/g, '') : null

/** Probabilidade em [0, 1] (0 válido); inválida → o padrão. */
const probabilityOr = (v: unknown, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : NaN
  return Number.isNaN(n) ? def : Math.min(1, Math.max(0, n))
}

/** Params como em `presets.ts` (`cleanParams`): só valores definidos (≠ null/NaN); chaves desconhecidas preservadas. */
const cleanParams = (v: unknown): ChatParams => {
  const out: Record<string, unknown> = {}
  const src = asObject(v)
  if (!src) return out
  for (const [k, val] of Object.entries(src)) {
    if (val === undefined || val === null || (typeof val === 'number' && Number.isNaN(val)))
      continue
    out[k] = val
  }
  return out as ChatParams
}

/** Config completa de entrada de áudio (ausente/inválido → `DEFAULT_AUDIO_INPUT`). */
export function normalizeAudioInput(v: unknown): AudioInputSettings {
  const src = asObject(v)
  if (!src) return { ...DEFAULT_AUDIO_INPUT }
  return {
    deviceId: strOrNull(src.deviceId),
    pttEnabled: boolOr(src.pttEnabled, DEFAULT_AUDIO_INPUT.pttEnabled),
    pttKey: strOrNull(src.pttKey),
    silenceStopEnabled: boolOr(src.silenceStopEnabled, DEFAULT_AUDIO_INPUT.silenceStopEnabled),
    // 0 é válido ("ignora o limite") e é preservado
    silenceStopMs: intOr(src.silenceStopMs, DEFAULT_AUDIO_INPUT.silenceStopMs),
    language: strOr(src.language, DEFAULT_AUDIO_INPUT.language)
  }
}

/** Settings completas de transcrição (ausente/inválido → `DEFAULT_STT_SETTINGS`). */
export function normalizeSttSettings(v: unknown): SttSettings {
  const src = asObject(v)
  const api = asObject(src?.api)
  const local = asObject(src?.local)
  return {
    mode:
      src && (STT_MODES as readonly string[]).includes(src.mode as string)
        ? (src.mode as SttMode)
        : DEFAULT_STT_SETTINGS.mode,
    api: {
      providerId: strOrNull(api?.providerId),
      baseUrl: strOr(api?.baseUrl, DEFAULT_STT_API.baseUrl),
      apiKey: typeof api?.apiKey === 'string' ? api.apiKey.trim() : DEFAULT_STT_API.apiKey,
      model: strOr(api?.model, DEFAULT_STT_API.model)
    },
    // null = nenhum motor instalado (objeto inválido também cai em null)
    local: local
      ? {
          engine: (STT_LOCAL_ENGINES as readonly string[]).includes(local.engine as string)
            ? (local.engine as SttLocalEngine)
            : 'whisper.cpp',
          model: typeof local.model === 'string' ? local.model.trim() : '',
          installed: local.installed === true
        }
      : null,
    livePartials: boolOr(src?.livePartials, DEFAULT_STT_SETTINGS.livePartials),
    reusePartialFinal: boolOr(src?.reusePartialFinal, true)
  }
}

/**
 * Settings completas de fala (ausente/inválido → `DEFAULT_TTS_SETTINGS`). `local: null` salvo é
 * preservado (= o usuário limpou explicitamente); `local` ausente/lixo → o padrão (Kokoro não
 * instalado) e objeto parcial é completado com `DEFAULT_TTS_LOCAL`.
 */
export function normalizeTtsSettings(v: unknown): TtsSettings {
  const src = asObject(v)
  const api = asObject(src?.api)
  const local = asObject(src?.local)
  return {
    backend: src?.backend === 'api' ? 'api' : DEFAULT_TTS_SETTINGS.backend,
    api: {
      providerId: strOrNull(api?.providerId),
      baseUrl: strOr(api?.baseUrl, DEFAULT_TTS_API.baseUrl),
      apiKey: typeof api?.apiKey === 'string' ? api.apiKey.trim() : DEFAULT_TTS_API.apiKey,
      model: strOr(api?.model, DEFAULT_TTS_API.model),
      voice: strOrNull(api?.voice)
    },
    // null explícito = limpo pelo usuário; ausente/lixo → o motor padrão (Kokoro)
    local:
      src && 'local' in src && src.local === null
        ? null
        : {
            engine:
              local && (TTS_LOCAL_ENGINES as readonly string[]).includes(local.engine as string)
                ? (local.engine as TtsLocalEngine)
                : DEFAULT_TTS_LOCAL.engine,
            voice: strOr(local?.voice, DEFAULT_TTS_LOCAL.voice),
            installed: local?.installed === true
          }
  }
}

/** Política completa de interjeições (ausente/inválido → `DEFAULT_INTERJECTION_POLICY`). */
export function normalizeInterjectionPolicy(v: unknown): InterjectionPolicy {
  const src = asObject(v)
  const d = DEFAULT_INTERJECTION_POLICY
  if (!src) return { ...d, classes: [...d.classes] }
  const classes = Array.isArray(src.classes)
    ? INTERJECTION_CLASSES.filter((c) => (src.classes as unknown[]).includes(c))
    : [...d.classes]
  return {
    enabled: boolOr(src.enabled, d.enabled),
    shadow: boolOr(src.shadow, d.shadow),
    cooldownMs: intOr(src.cooldownMs, d.cooldownMs),
    fireProbability: probabilityOr(src.fireProbability, d.fireProbability),
    minSpeechMs: intOr(src.minSpeechMs, d.minSpeechMs),
    minPauseMs: intOr(src.minPauseMs, d.minPauseMs),
    // lista vazia (ou só classes desconhecidas) volta ao padrão (só ACK)
    classes: classes.length ? classes : [...d.classes],
    volume: probabilityOr(src.volume, d.volume)
  }
}

/** Pool de preâmbulos normalizado: frases válidas (texto aparado ≤ 80 chars), no máximo `FILLER_POOL_MAX`; vazio/lixo → null. */
export function normalizeFillerPool(v: unknown): FillerPhrase[] | null {
  if (!Array.isArray(v)) return null
  const out: FillerPhrase[] = []
  for (const item of v) {
    const o = asObject(item)
    const text = typeof o?.text === 'string' ? o.text.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    if (!text) continue
    const contexts = Array.isArray(o?.contexts)
      ? FILLER_CONTEXTS.filter((c) => (o!.contexts as unknown[]).includes(c))
      : []
    out.push({ text, contexts })
    if (out.length >= FILLER_POOL_MAX) break
  }
  return out.length ? out : null
}

/** Pool efetivo (null → `DEFAULT_FILLER_POOL`). */
export function resolveFillerPool(pool: FillerPhrase[] | null | undefined): FillerPhrase[] {
  const p = normalizeFillerPool(pool ?? null)
  return p ?? DEFAULT_FILLER_POOL.map((f) => ({ text: f.text, contexts: [...f.contexts] }))
}

/** Turnos completos (ausente/lixo → `DEFAULT_VOICE_CALL_TURN`); 0 em `silenceStopMs` vira null. */
export function normalizeVoiceCallTurn(v: unknown): VoiceCallTurnConfig {
  const t = asObject(v)
  const d = DEFAULT_VOICE_CALL_TURN
  const turnMs = intOrNull(t?.silenceStopMs)
  const pos = (x: unknown, def: number): number => {
    const n = intOr(x, def)
    return n > 0 ? n : def
  }
  return {
    // null = o padrão da chamada (DEFAULT_TURN_SILENCE_MS); 0 não faz sentido aqui (sem limite =
    // sem turnos) e vira null
    silenceStopMs: turnMs && turnMs > 0 ? turnMs : null,
    adaptive: boolOr(t?.adaptive, d.adaptive),
    speculativeAtMs: pos(t?.speculativeAtMs, d.speculativeAtMs),
    completeSilenceMs: pos(t?.completeSilenceMs, d.completeSilenceMs),
    statementSilenceMs: pos(t?.statementSilenceMs, d.statementSilenceMs),
    unfinishedSilenceMs: pos(t?.unfinishedSilenceMs, d.unfinishedSilenceMs),
    speculativeApi: boolOr(t?.speculativeApi, d.speculativeApi)
  }
}

/**
 * Config completa da chamada de voz a partir de qualquer valor salvo (ausente/inválido →
 * `DEFAULT_VOICE_CALL_CONFIG` = tudo herda). Campos `null` são preservados (null ≠ false: null
 * herda o padrão global); chaves desconhecidas são descartadas (como nos demais normalizadores) e
 * `model.params` preserva as chaves que não conhece (como `cleanParams` em presets.ts).
 */
/** Modelo da chamada (provider + model + params) ou null (sem provider/model válidos). */
export function normalizeVoiceCallModel(v: unknown): VoiceCallModelConfig | null {
  const model = asObject(v)
  const providerId = strOrNull(model?.providerId)
  const modelName = strOrNull(model?.model)
  return model && providerId && modelName
    ? { providerId, model: modelName, params: cleanParams(model.params) }
    : null
}

const promptModeOrNull = (v: unknown): VoiceCallPromptMode | null =>
  VOICE_CALL_PROMPT_MODES.includes(v as VoiceCallPromptMode) ? (v as VoiceCallPromptMode) : null

export function normalizeVoiceCallConfig(v: unknown): VoiceCallConfig {
  const src = asObject(v)
  if (!src) return { ...DEFAULT_VOICE_CALL_CONFIG }
  const tools = asObject(src.tools)
  const fillers = asObject(src.fillers)
  const interjections = asObject(src.interjections)
  const promptMode = promptModeOrNull(src.promptMode)
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : null,
    model: normalizeVoiceCallModel(src.model),
    tools: tools
      ? {
          enabledTools: normalizeToolList(tools.enabledTools) ?? null,
          maxToolOutputChars: intOrNull(tools.maxToolOutputChars)
        }
      : null,
    voicePrompt: promptOrNull(src.voicePrompt),
    // aditivo: só gravado quando escolhido (ausente = herda → complementar)
    ...(promptMode ? { promptMode } : {}),
    // objeto presente = override do global; `enabled` ausente completa com o padrão (ligado)
    fillers: fillers
      ? {
          enabled: boolOr(fillers.enabled, DEFAULT_VOICE_CALL_DEFAULTS.fillers.enabled),
          prompt: promptOrNull(fillers.prompt)
        }
      : null,
    interjections: interjections ? normalizeInterjectionPolicy(interjections) : null
  }
}

/** Padrões globais completos da chamada de voz (ausente/inválido → `DEFAULT_VOICE_CALL_DEFAULTS`). */
export function normalizeVoiceCallDefaults(v: unknown): VoiceCallDefaults {
  const src = asObject(v)
  const fillers = asObject(src?.fillers)
  const d = DEFAULT_VOICE_CALL_DEFAULTS
  return {
    enabled: boolOr(src?.enabled, d.enabled),
    interjections: normalizeInterjectionPolicy(src?.interjections),
    fillers: {
      enabled: boolOr(fillers?.enabled, d.fillers.enabled),
      prompt: promptOrNull(fillers?.prompt),
      // 0 é válido (preâmbulo já, sem esperar)
      delayMs: Math.min(5000, intOr(fillers?.delayMs, d.fillers.delayMs)),
      pool: normalizeFillerPool(fillers?.pool)
    },
    turn: normalizeVoiceCallTurn(src?.turn),
    // `maxTokens` (teto antigo dos turnos de voz) saiu: o max_tokens vive nos params do modelo da
    // chamada — um valor gravado é descartado aqui
    model: normalizeVoiceCallModel(src?.model),
    basePromptEnabled: boolOr(src?.basePromptEnabled, d.basePromptEnabled),
    basePrompt: promptOrNull(src?.basePrompt)
  }
}

// ---------------- resolução da chamada de voz (herança persona→chat→global) ----------------

/**
 * Silêncio que encerra a fala do usuário na chamada (ms): `turn.silenceStopMs` quando definido;
 * senão `DEFAULT_TURN_SILENCE_MS` (na chamada o turno SEMPRE tem limite — sem limite não há
 * turnos). O auto-stop do ditado (`audioInput`) NÃO é herdado: o padrão dele (5 s) é longo demais
 * para turno de conversa. `audioInput` segue aceito por compatibilidade com os chamadores.
 */
export function resolveTurnSilenceMs(
  turn: VoiceCallTurnConfig | null | undefined,
  audioInput?: Pick<AudioInputSettings, 'silenceStopEnabled' | 'silenceStopMs'>
): number {
  void audioInput
  const explicit = turn?.silenceStopMs
  if (typeof explicit === 'number' && explicit > 0) return Math.round(explicit)
  return DEFAULT_TURN_SILENCE_MS
}

/**
 * Tempos efetivos do fim de turno (renderer: `AdaptiveTurnGate`). Coerentes por construção:
 * `completeMs ≤ statementMs ≤ unfinishedMs` e `fallbackMs` (sem transcrição especulativa) dentro
 * de `[completeMs, unfinishedMs]`; `speculativeAtMs` < `completeMs`.
 */
export interface TurnTiming {
  adaptive: boolean
  speculativeAtMs: number
  completeMs: number
  statementMs: number
  unfinishedMs: number
  fallbackMs: number
  /**
   * Silêncio exigido enquanto a especulação está pendente; ausente = `unfinishedMs` (o teto). A
   * chamada põe `fallbackMs` quando a especulação vai pela API (lenta: 1–3 s no OpenRouter) — o
   * turno fecha no silêncio fixo e a final reaproveita a especulação em voo.
   */
  pendingMs?: number
}

export function resolveTurnTiming(turn: VoiceCallTurnConfig | null | undefined): TurnTiming {
  const t = normalizeVoiceCallTurn(turn ?? null)
  const fallbackMs = resolveTurnSilenceMs(t)
  const unfinishedMs = Math.max(t.unfinishedSilenceMs, fallbackMs, t.statementSilenceMs)
  const completeMs = Math.min(t.completeSilenceMs, fallbackMs, t.statementSilenceMs)
  const statementMs = Math.min(Math.max(t.statementSilenceMs, completeMs), unfinishedMs)
  return {
    adaptive: t.adaptive,
    speculativeAtMs: Math.min(t.speculativeAtMs, Math.max(1, completeMs - 100)),
    completeMs,
    statementMs,
    unfinishedMs,
    fallbackMs
  }
}

export const DEFAULT_TURN_TIMING: TurnTiming = resolveTurnTiming(DEFAULT_VOICE_CALL_TURN)

/**
 * Camadas chat → persona da chamada de voz: cada campo `null`/ausente do chat herda o da persona
 * de origem (`ChatConfig.presetId`, lida AO VIVO). A persona também entra por snapshot na criação
 * do chat (`applyPreset`), então os dois coincidem até alguém mudar um dos lados; um campo que o
 * chat devolveu a "★ padrão" (null) segue a persona atual. Persona ausente → o próprio chat.
 */
export function layerVoiceCallConfig(
  chat: VoiceCallConfig | null | undefined,
  persona: VoiceCallConfig | null | undefined
): VoiceCallConfig {
  const c = normalizeVoiceCallConfig(chat ?? null)
  if (!persona) return c
  const p = normalizeVoiceCallConfig(persona)
  const mode = c.promptMode ?? p.promptMode ?? null
  return {
    enabled: c.enabled ?? p.enabled,
    model: c.model ?? p.model,
    tools: c.tools ?? p.tools,
    voicePrompt: c.voicePrompt ?? p.voicePrompt,
    ...(mode ? { promptMode: mode } : {}),
    fillers: c.fillers ?? p.fillers,
    interjections: c.interjections ?? p.interjections
  }
}

/** De onde vem o `enabled` efetivo (o tooltip do telefone explica quem desligou). */
export type VoiceCallSource = 'chat' | 'persona' | 'global'

/**
 * Chamada liberada? Precedência chat > persona > global. Com o snapshot da persona o chat costuma
 * ter o mesmo valor dela — valor igual ao da persona conta como "da persona" (o motivo exibido).
 */
export function resolveVoiceCallEnabled(
  chat: VoiceCallConfig | null | undefined,
  persona: VoiceCallConfig | null | undefined,
  defaults: VoiceCallDefaults | null | undefined
): { enabled: boolean; source: VoiceCallSource } {
  const c = normalizeVoiceCallConfig(chat ?? null).enabled
  const p = persona ? normalizeVoiceCallConfig(persona).enabled : null
  if (c !== null) return { enabled: c, source: p === c ? 'persona' : 'chat' }
  if (p !== null) return { enabled: p, source: 'persona' }
  return { enabled: normalizeVoiceCallDefaults(defaults ?? null).enabled, source: 'global' }
}

/**
 * `VoiceCallConfig` resolvido: campos null herdam o padrão (chat → persona via
 * `layerVoiceCallConfig`; aqui → global). `model` = chat > persona > global (`voiceCallDefaults
 * .model`) > null (o modelo do próprio chat); `tools` continua `null` sem override.
 */
export interface ResolvedVoiceCall {
  /** Chamada de voz liberada (para UI/envio). */
  enabled: boolean
  /** Modelo próprio da chamada (provider/model/params); null = o modelo do chat. */
  model: VoiceCallModelConfig | null
  /** Tools próprias (campos null = os do chat); null = igual ao chat. */
  tools: VoiceCallToolsConfig | null
  /** Prompt do modo voz; null = sem prompt próprio. */
  voicePrompt: string | null
  /** Composição do prompt nos turnos de voz (padrão `'append'`). */
  promptMode: VoiceCallPromptMode
  /** Falas preenchidoras efetivas (consumidas pela chamada — ver SPEC → "Fillers"). */
  fillers: VoiceFillers
  /** Interjeições efetivas (consumidas pela chamada — ver SPEC → "Interjeições (regras)"). */
  interjections: InterjectionPolicy
  /** Prompt-base do modo voz (global); null = desligado. */
  basePrompt: string | null
}

/**
 * Resolução completa (aceita lixo/null; `enabled: null` herda o global — null ≠ false). `persona`
 * (opcional) = a config de voz da persona de origem do chat (`presetId`), lida ao vivo.
 */
export function resolveVoiceCallConfig(
  config: VoiceCallConfig | null | undefined,
  defaults: VoiceCallDefaults | null | undefined,
  persona?: VoiceCallConfig | null
): ResolvedVoiceCall {
  const c = layerVoiceCallConfig(config ?? null, persona ?? null)
  const d = normalizeVoiceCallDefaults(defaults ?? null)
  return {
    enabled: c.enabled ?? d.enabled,
    model: c.model ?? d.model,
    tools: c.tools,
    voicePrompt: c.voicePrompt,
    promptMode: c.promptMode ?? 'append',
    fillers: c.fillers ?? { enabled: d.fillers.enabled, prompt: d.fillers.prompt },
    interjections: c.interjections ?? d.interjections,
    basePrompt: d.basePromptEnabled ? (d.basePrompt ?? DEFAULT_VOICE_BASE_PROMPT) : null
  }
}

/**
 * System prompt dos turnos de voz pelo modo (ver `VoiceCallPromptMode`): `append` = system +
 * prompt-base + prompt do modo voz; `replace` = prompt-base + prompt do modo voz no lugar do system
 * (sem prompt do modo voz → como `append`); `none` = só o system. Separados por linha em branco.
 */
export function voiceSystemPrompt(
  systemPrompt: string,
  call: Pick<ResolvedVoiceCall, 'basePrompt' | 'voicePrompt' | 'promptMode'>
): string {
  const join = (parts: (string | null | undefined)[]): string =>
    parts.filter((x): x is string => !!x?.trim()).join('\n\n')
  const mode = call.promptMode ?? 'append'
  if (mode === 'none') return systemPrompt
  if (mode === 'replace' && call.voicePrompt?.trim())
    return join([call.basePrompt, call.voicePrompt])
  return join([systemPrompt, call.basePrompt, call.voicePrompt])
}

/**
 * Chat efetivo de um turno de voz (cópia): a config do chat com os overrides da chamada aplicados
 * (`model` → params; `tools` → enabledTools/maxToolOutputChars; prompt pelo `promptMode`) e o
 * raciocínio do modelo da chamada desligado/mínimo quando os params da chamada não o definem
 * (`planVoiceReasoning` — com `rules`, que o runner passa com o tipo do provedor e o /models). Sem
 * teto de tokens próprio (o `max_tokens` só vem dos params). Função pura — o chat salvo nunca muda
 * (o histórico de um turno de voz é idêntico ao de um turno de texto).
 */
export function applyVoiceCallChat(
  chat: Chat,
  call: ResolvedVoiceCall,
  rules?: VoiceReasoningRules
): Chat {
  const cfg = chat.config
  const out: ChatConfig = { ...cfg }
  if (call.model) out.params = { ...call.model.params }
  if (call.tools?.enabledTools != null) out.enabledTools = [...call.tools.enabledTools]
  if (call.tools?.maxToolOutputChars != null) out.maxToolOutputChars = call.tools.maxToolOutputChars
  const sys = voiceSystemPrompt(cfg.systemPrompt ?? '', call)
  if (sys !== (cfg.systemPrompt ?? '')) out.systemPrompt = sys
  if (rules) {
    const model = call.model?.model ?? cfg.model
    // "configurado no modelo da chamada" = reasoning_effort nos params da chamada; os params do
    // chat (texto) não contam — a chamada sem modelo próprio usa o raciocínio desligado/mínimo
    const explicit = call.model?.params.reasoning_effort != null
    out.params = planVoiceReasoning({
      params: out.params ?? {},
      explicit,
      kind: rules.kind,
      model,
      info: rules.info
    }).params
  }
  return { ...chat, config: out }
}

// ---------------- estado da chamada de voz (main → store/UI; canais `voice:call:*`) ----------------

/** Fase do turno de voz mostrada na UI ("Ouvindo…/Transcrevendo…/Pensando…/Falando…"). */
export type VoiceCallPhase = 'listening' | 'transcribing' | 'thinking' | 'speaking'

/**
 * Estado da chamada de voz ativa (evento `voice:call:state`; retorno dos canais `voice:call:*`).
 * `error` é a última falha legível (ex.: TTS); limpa na próxima transição bem-sucedida.
 */
export interface VoiceCallState {
  active: boolean
  chatId: string | null
  sessionId: string | null
  phase: VoiceCallPhase
  muted: boolean
  /** Silêncio que encerra o turno sem transcrição especulativa, em ms (resolvido em `voice:call:start`). */
  turnSilenceMs: number
  /** Tempos do fim de turno adaptativo (resolvidos em `voice:call:start`). */
  turnTiming: TurnTiming
  /** Fala já transcrita aguardando o próximo turno (máx. 1; '' = nenhuma). */
  pendingText: string
  error: string | null
}

/** Estado "desligado" (retorno de `voice:call:stop` / inicial do store). */
export const VOICE_CALL_INACTIVE: VoiceCallState = {
  active: false,
  chatId: null,
  sessionId: null,
  phase: 'listening',
  muted: false,
  turnSilenceMs: DEFAULT_TURN_SILENCE_MS,
  turnTiming: DEFAULT_TURN_TIMING,
  pendingText: '',
  error: null
}
