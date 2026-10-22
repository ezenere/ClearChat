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
}

export const DEFAULT_STT_API: SttEndpointConfig = {
  providerId: null,
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  model: 'whisper-large-v3-turbo'
}

export const DEFAULT_STT_SETTINGS: SttSettings = {
  mode: 'api',
  api: { ...DEFAULT_STT_API },
  local: null,
  livePartials: true
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
  /** Intervalo mínimo entre interjeições, em ms (padrão 2500). */
  cooldownMs: number
  /** Probabilidade de disparar quando as regras deixam (0–1; padrão 0.8). */
  fireProbability: number
  /** Fala do usuário (ms) antes de uma interjeição poder sair (padrão 700). */
  minSpeechMs: number
  /** Pausa do usuário (ms) em que a interjeição pode entrar (padrão 450). */
  minPauseMs: number
  /** Classes permitidas (padrão: todas). Lista vazia volta ao padrão. */
  classes: InterjectionClass[]
}

export const DEFAULT_INTERJECTION_POLICY: InterjectionPolicy = {
  enabled: true,
  shadow: false,
  cooldownMs: 2500,
  fireProbability: 0.8,
  minSpeechMs: 700,
  minPauseMs: 450,
  classes: [...INTERJECTION_CLASSES]
}

/** Falas preenchidoras ("ãh", "só um minutinho…") enquanto o modelo pensa. */
export interface VoiceFillers {
  /** Liga as falas preenchidoras (padrão true). */
  enabled: boolean
  /** Prompt das falas preenchidoras; null = o padrão. */
  prompt: string | null
}

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
  /** Acréscimo ao system prompt no modo voz (fala, estilo…); null = sem acréscimo. */
  voicePrompt: string | null
  /** Falas preenchidoras; null = segue o padrão global. */
  fillers: VoiceFillers | null
  /** Política de interjeições; null = segue o padrão global. */
  interjections: InterjectionPolicy | null
}

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
  /** Falas preenchidoras padrão. */
  fillers: VoiceFillers
  /** Turnos da chamada (silêncio que encerra a fala do usuário). */
  turn: VoiceCallTurnConfig
}

/**
 * Turnos da chamada de voz (setting `voiceCallDefaults.turn`). `silenceStopMs: 0` é tratado como
 * `null` (na chamada o turno SEMPRE tem limite de silêncio — sem limite não há turnos).
 */
export interface VoiceCallTurnConfig {
  /**
   * Ms de silêncio contínuo que ENCERRAM a fala do usuário (turno). `null` = segue `audioInput`
   * (`silenceStopMs`, quando `silenceStopEnabled` e > 0; senão `DEFAULT_TURN_SILENCE_MS`).
   */
  silenceStopMs: number | null
}

/** Fallback do silêncio de turno quando `audioInput` está com auto-stop desligado/zerado. */
export const DEFAULT_TURN_SILENCE_MS = 2000

export const DEFAULT_VOICE_CALL_TURN: VoiceCallTurnConfig = { silenceStopMs: null }

export const DEFAULT_VOICE_CALL_DEFAULTS: VoiceCallDefaults = {
  enabled: true,
  interjections: { ...DEFAULT_INTERJECTION_POLICY, classes: [...INTERJECTION_CLASSES] },
  fillers: { enabled: true, prompt: null },
  turn: { ...DEFAULT_VOICE_CALL_TURN }
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
    livePartials: boolOr(src?.livePartials, DEFAULT_STT_SETTINGS.livePartials)
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
    // lista vazia (ou só classes desconhecidas) volta ao padrão: todas
    classes: classes.length ? classes : [...d.classes]
  }
}

/**
 * Config completa da chamada de voz a partir de qualquer valor salvo (ausente/inválido →
 * `DEFAULT_VOICE_CALL_CONFIG` = tudo herda). Campos `null` são preservados (null ≠ false: null
 * herda o padrão global); chaves desconhecidas são descartadas (como nos demais normalizadores) e
 * `model.params` preserva as chaves que não conhece (como `cleanParams` em presets.ts).
 */
export function normalizeVoiceCallConfig(v: unknown): VoiceCallConfig {
  const src = asObject(v)
  if (!src) return { ...DEFAULT_VOICE_CALL_CONFIG }
  const model = asObject(src.model)
  const tools = asObject(src.tools)
  const fillers = asObject(src.fillers)
  const interjections = asObject(src.interjections)
  const providerId = strOrNull(model?.providerId)
  const modelName = strOrNull(model?.model)
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : null,
    model:
      model && providerId && modelName
        ? { providerId, model: modelName, params: cleanParams(model.params) }
        : null,
    tools: tools
      ? {
          enabledTools: normalizeToolList(tools.enabledTools) ?? null,
          maxToolOutputChars: intOrNull(tools.maxToolOutputChars)
        }
      : null,
    voicePrompt: promptOrNull(src.voicePrompt),
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
  const turn = asObject(src?.turn)
  const turnMs = intOrNull(turn?.silenceStopMs)
  return {
    enabled: boolOr(src?.enabled, DEFAULT_VOICE_CALL_DEFAULTS.enabled),
    interjections: normalizeInterjectionPolicy(src?.interjections),
    fillers: {
      enabled: boolOr(fillers?.enabled, DEFAULT_VOICE_CALL_DEFAULTS.fillers.enabled),
      prompt: promptOrNull(fillers?.prompt)
    },
    // null = segue `audioInput`; 0 não faz sentido aqui (sem limite = sem turnos) e vira null
    turn: { silenceStopMs: turnMs && turnMs > 0 ? turnMs : null }
  }
}

// ---------------- resolução da chamada de voz (herança persona→chat→global) ----------------

/**
 * Silêncio que encerra a fala do usuário na chamada (ms): `turn.silenceStopMs` quando definido;
 * senão `audioInput` (`silenceStopMs` com auto-stop ligado e > 0); senão `DEFAULT_TURN_SILENCE_MS`
 * (na chamada o turno SEMPRE tem limite — sem limite não há turnos).
 */
export function resolveTurnSilenceMs(
  turn: VoiceCallTurnConfig | null | undefined,
  audioInput: Pick<AudioInputSettings, 'silenceStopEnabled' | 'silenceStopMs'>
): number {
  const explicit = turn?.silenceStopMs
  if (typeof explicit === 'number' && explicit > 0) return Math.round(explicit)
  if (audioInput.silenceStopEnabled && audioInput.silenceStopMs > 0)
    return Math.round(audioInput.silenceStopMs)
  return DEFAULT_TURN_SILENCE_MS
}

/**
 * `VoiceCallConfig` resolvido: campos null herdam o padrão (como `memory`/`skills` — a herança
 * persona→chat é snapshot na criação do chat; aqui resolve-se chat→global). `model`/`tools`
 * continuam `null` quando não há override (o chamador usa o modelo/tools do próprio chat).
 */
export interface ResolvedVoiceCall {
  /** Chamada de voz liberada (para UI/envio). */
  enabled: boolean
  /** Modelo próprio da chamada (provider/model/params); null = o modelo do chat. */
  model: VoiceCallModelConfig | null
  /** Tools próprias (campos null = os do chat); null = igual ao chat. */
  tools: VoiceCallToolsConfig | null
  /** Acréscimo ao system prompt no modo voz; null = sem acréscimo. */
  voicePrompt: string | null
  /** Falas preenchidoras efetivas (consumidas pela chamada — ver SPEC → "Fillers"). */
  fillers: VoiceFillers
  /** Interjeições efetivas (consumidas pela chamada — ver SPEC → "Interjeições (regras)"). */
  interjections: InterjectionPolicy
}

/** Resolução completa (aceita lixo/null; `enabled: null` herda o global — null ≠ false). */
export function resolveVoiceCallConfig(
  config: VoiceCallConfig | null | undefined,
  defaults: VoiceCallDefaults | null | undefined
): ResolvedVoiceCall {
  const c = normalizeVoiceCallConfig(config ?? null)
  const d = normalizeVoiceCallDefaults(defaults ?? null)
  return {
    enabled: c.enabled ?? d.enabled,
    model: c.model,
    tools: c.tools,
    voicePrompt: c.voicePrompt,
    fillers: c.fillers ?? d.fillers,
    interjections: c.interjections ?? d.interjections
  }
}

/**
 * Chat efetivo de um turno de voz (cópia): a config do chat com os overrides da chamada aplicados
 * (`voice.model` → params; `voice.tools` → enabledTools/maxToolOutputChars; `voicePrompt` →
 * acréscimo ao system prompt). Função pura — o runner usa a cópia só nas requests/tools do turno;
 * o chat salvo nunca muda (o histórico de um turno de voz é idêntico ao de um turno de texto).
 */
export function applyVoiceCallChat(chat: Chat, call: ResolvedVoiceCall): Chat {
  const cfg = chat.config
  const out: ChatConfig = { ...cfg }
  if (call.model) out.params = { ...call.model.params }
  if (call.tools?.enabledTools != null) out.enabledTools = [...call.tools.enabledTools]
  if (call.tools?.maxToolOutputChars != null) out.maxToolOutputChars = call.tools.maxToolOutputChars
  if (call.voicePrompt) {
    out.systemPrompt = cfg.systemPrompt
      ? `${cfg.systemPrompt}\n\n${call.voicePrompt}`
      : call.voicePrompt
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
  /** Silêncio que encerra o turno, em ms (resolvido em `voice:call:start`). */
  turnSilenceMs: number
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
  pendingText: '',
  error: null
}
