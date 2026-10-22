// Compatibilidade modelo ↔ chat: o que o histórico enviado exige do modelo (imagem, PDF, áudio,
// tools) e se um modelo atende. Funções puras usadas pelo seletor de modelo (opções incompatíveis
// desabilitadas) e pelo composer (aviso antes de enviar). Ver SPEC.md → "Anexos" → Compatibilidade.
import type { ChatConfig, ContentPart, ModelInfo, StoredMessage } from './types'
import type { ProviderKind } from './providerKinds'
import { modalitySupport } from './attachments'
import { activeHistory, isDisplayOnly } from './context'

/** Capacidade que o histórico pode exigir do modelo. */
export type ChatCapability = 'image' | 'pdf' | 'audio' | 'tools'

/** Ordem fixa (mensagens/tooltips estáveis). */
export const CHAT_CAPABILITIES: readonly ChatCapability[] = ['image', 'pdf', 'audio', 'tools']

/** Tipo do part no fio → capacidade (o tipo é decidido no envio e fica gravado no histórico). */
const PART_CAPABILITY: Partial<Record<ContentPart['type'], ChatCapability>> = {
  image_url: 'image',
  file: 'pdf',
  input_audio: 'audio'
}

/**
 * O que o histórico que vai para a API exige do modelo — mesmo recorte de `buildRequest`: o caminho
 * ativo (`path`, como `messagesRepo.path` / `activePath`), da fronteira de compactação mais recente
 * em diante, sem mensagens só de exibição. Anexos antes da fronteira não contam (não são enviados).
 * - imagem / PDF / áudio: parts `image_url` / `file` / `input_audio` em qualquer mensagem
 *   (anexos do usuário e mídia de resultados de tool — read_file);
 * - tools: o histórico tem tool_calls/resultados nativos E o chat envia tools nativas
 *   (`nativeTools` + alguma habilitada) — a request leva o campo `tools`. No modo texto
 *   (`<tool_call>`) não exige nada.
 * Arquivos de texto vão como texto: não exigem nada.
 */
export function chatRequirements(
  path: readonly StoredMessage[],
  config: Pick<ChatConfig, 'nativeTools' | 'enabledTools'>
): ChatCapability[] {
  const found = new Set<ChatCapability>()
  let toolUse = false
  for (const m of activeHistory(path as StoredMessage[])) {
    if (isDisplayOnly(m.meta)) continue
    const msg = m.message
    if (msg.role === 'tool') toolUse = true
    if (msg.role === 'assistant') {
      if (msg.tool_calls?.length) toolUse = true
      continue
    }
    if (!Array.isArray(msg.content)) continue
    for (const p of msg.content) {
      const cap = PART_CAPABILITY[p.type]
      if (cap) found.add(cap)
    }
  }
  if (toolUse && config.nativeTools && config.enabledTools.length > 0) found.add('tools')
  return CHAT_CAPABILITIES.filter((c) => found.has(c))
}

export interface ModelCompat {
  /** Capacidades exigidas que o modelo declaradamente não tem (→ desabilitado / aviso). */
  missing: ChatCapability[]
  /** Exigidas mas o provider não informa (nunca bloqueia). */
  unknown: ChatCapability[]
}

/**
 * O modelo atende ao chat? Mesma fonte de capacidades dos anexos (`modalitySupport`:
 * `inputModalities` do /models + regras do adaptador — PDF no OpenRouter sempre passa pelo
 * file-parser; Anthropic nunca aceita áudio). Tools: `supportsTools === false` (OpenRouter
 * `supported_parameters` sem `tools`) → falta; ausente → desconhecido. Modelo sem metadados (fora
 * da lista, ID livre) → tudo desconhecido.
 */
export function modelCompat(
  required: readonly ChatCapability[],
  model: Pick<ModelInfo, 'inputModalities' | 'supportsTools'> | null | undefined,
  provider: ProviderKind
): ModelCompat {
  const missing: ChatCapability[] = []
  const unknown: ChatCapability[] = []
  for (const cap of required) {
    if (cap === 'tools') {
      if (model?.supportsTools === false) missing.push(cap)
      else if (model?.supportsTools !== true) unknown.push(cap)
      continue
    }
    const s = modalitySupport(cap, model, provider)
    if (s === 'unsupported') missing.push(cap)
    else if (s === 'unknown') unknown.push(cap)
  }
  return { missing, unknown }
}

/** "a, b e c" / "a, b nem c". */
function joinPt(items: string[], last: 'e' | 'nem'): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`
}

const HAS_LABEL: Record<Exclude<ChatCapability, 'tools'>, string> = {
  image: 'imagens',
  pdf: 'PDF',
  audio: 'áudio'
}
const NOUN: Record<ChatCapability, string> = {
  image: 'imagem',
  pdf: 'PDF',
  audio: 'áudio',
  tools: 'tools'
}

/** Rótulo curto (linha do seletor), ex.: "não aceita imagem nem PDF". */
export function compatLabel(missing: readonly ChatCapability[]): string {
  return `não aceita ${joinPt(
    missing.map((c) => NOUN[c]),
    'nem'
  )}`
}

/**
 * Motivo em pt-BR (sem ponto final), ex.: "Este chat tem imagens e PDF — o modelo não aceita imagem
 * nem PDF". `subject` = como chamar o modelo ("o modelo" no seletor, "o modelo atual" no composer).
 * Áudio na Anthropic não dá erro: o adaptador troca por um aviso em texto — a frase diz isso.
 * null = nada falta.
 */
export function compatReason(
  missing: readonly ChatCapability[],
  provider: ProviderKind,
  subject = 'o modelo'
): string | null {
  if (!missing.length) return null
  const media = missing.filter((c): c is Exclude<ChatCapability, 'tools'> => c !== 'tools')
  const has: string[] = []
  if (media.length)
    has.push(
      `tem ${joinPt(
        media.map((c) => HAS_LABEL[c]),
        'e'
      )}`
    )
  if (missing.includes('tools')) has.push('usa tools')
  let out = `Este chat ${has.join(' e ')} — ${subject} ${compatLabel(missing)}`
  if (provider === 'anthropic' && missing.includes('audio'))
    out += ' (o áudio seria trocado por um aviso em texto)'
  return out
}

/** Atalho: motivo para desabilitar o modelo neste chat (null = compatível ou desconhecido). */
export function incompatibility(
  required: readonly ChatCapability[],
  model: Pick<ModelInfo, 'inputModalities' | 'supportsTools'> | null | undefined,
  provider: ProviderKind,
  subject?: string
): string | null {
  if (!required.length) return null
  return compatReason(modelCompat(required, model, provider).missing, provider, subject)
}
