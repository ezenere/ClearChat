// Ditado por voz (renderer): funções PURAS do rascunho de transcrição — ponto de inserção do texto
// final (onde estava o cursor quando o ditado começou, ajustado às edições feitas durante a
// gravação), espaçamento da inserção e mensagens legíveis das falhas de captura. Sem DOM/React —
// testado em `e2e/voiceDictation.test.ts`.
//
// A parcial ao vivo NÃO entra no texto editável: o Composer a mostra num "fantasma" fora da
// textarea (`voice-partial`). Assim o usuário pode digitar durante a gravação sem corromper o
// rascunho (antes a parcial + `▌` viviam dentro do valor e uma digitação no fim quebrava a
// separação). No stop, o texto final é inserido no ponto de inserção com `insertDictationText`
// (o Composer usa `execCommand('insertText')`, que preserva o desfazer) — o envio é SEMPRE manual.

/** Cursor visual do rascunho falado (parcial ao vivo, no fantasma do Composer). */
export const DICTATION_CURSOR = '▌'

/**
 * Junta o texto falado ao rascunho digitado, com UM espaço de separação quando necessário
 * (a base acaba em espaço/quebra de linha ou está vazia → sem espaço extra). `spoken` vazio
 * devolve a base como está. (Fallback quando não há ponto de inserção conhecido.)
 */
export function mergeDictationDraft(base: string, spoken: string): string {
  if (!spoken) return base
  if (!base) return spoken
  return /\s$/.test(base) ? base + spoken : `${base} ${spoken}`
}

/** Seleção/cursor da textarea quando o ditado começou (texto daquele momento + seleção). */
export interface DictationAnchor {
  text: string
  start: number
  end: number
}

/**
 * Leva uma posição do texto antigo para o texto novo (edição única detectada por prefixo e sufixo
 * comuns): antes da edição fica onde está; depois dela anda junto com o deslocamento; dentro da
 * região editada (ou exatamente no ponto de uma inserção — "gravidade à direita") vai para o fim do
 * trecho novo, sem cortar o que o usuário digitou.
 */
function mapPosition(oldText: string, newText: string, pos: number): number {
  const p = Math.max(0, Math.min(oldText.length, pos))
  if (oldText === newText) return p
  const max = Math.min(oldText.length, newText.length)
  let prefix = 0
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++
  let suffix = 0
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  )
    suffix++
  if (p < prefix) return p
  const oldEditEnd = oldText.length - suffix
  if (p >= oldEditEnd) return p + (newText.length - oldText.length)
  return newText.length - suffix
}

/**
 * Ponto de inserção do texto final no rascunho ATUAL: a seleção do início do ditado, ajustada às
 * edições feitas durante a gravação (ver `mapPosition`). Sem âncora → fim do texto.
 */
export function rebaseDictationAnchor(
  anchor: DictationAnchor | null,
  current: string
): { start: number; end: number } {
  if (!anchor) return { start: current.length, end: current.length }
  const start = mapPosition(anchor.text, current, anchor.start)
  const end = Math.max(start, mapPosition(anchor.text, current, anchor.end))
  return { start, end }
}

/**
 * Insere `spoken` em `value` substituindo `[start, end)`, com espaçamento natural: espaço antes
 * quando o caractere anterior não é espaço; espaço depois quando o seguinte não é espaço nem
 * pontuação de fechamento. Devolve o valor novo, o trecho inserido (para `execCommand`) e o cursor.
 */
export function insertDictationText(
  value: string,
  start: number,
  end: number,
  spoken: string
): { value: string; insert: string; start: number; end: number; caret: number } {
  const s = Math.max(0, Math.min(value.length, start))
  const e = Math.max(s, Math.min(value.length, end))
  const text = spoken.trim()
  if (!text) return { value, insert: '', start: s, end: e, caret: e }
  const before = s > 0 ? value[s - 1] : ''
  const after = e < value.length ? value[e] : ''
  const lead = before && !/\s/.test(before) ? ' ' : ''
  const trail = after && !/[\s.,;:!?)\]}…]/.test(after) ? ' ' : ''
  const insert = lead + text + trail
  return {
    value: value.slice(0, s) + insert + value.slice(e),
    insert,
    start: s,
    end: e,
    caret: s + insert.length
  }
}

/** Falha de captura com o `name` do DOMException (o `message` do OverconstrainedError vem vazio). */
export interface CaptureErrorLike {
  name?: string
  message?: string
  constraint?: string
}

/** Microfone salvo ausente: a captura caiu para o padrão do sistema (aviso único ao usuário). */
export const MIC_FALLBACK_NOTICE = 'Microfone salvo não encontrado — usando o padrão do sistema.'
/** O microfone sumiu no meio da gravação (faixa `ended`). */
export const MIC_LOST_TEXT =
  'O microfone foi desconectado durante a gravação — o que já tinha sido gravado foi transcrito.'

/** O erro é de dispositivo inexistente/inválido (vale tentar o microfone padrão). */
export function isMissingDeviceError(err: unknown): boolean {
  const name = errorName(err)
  return (
    name === 'OverconstrainedError' ||
    name === 'ConstraintNotSatisfiedError' ||
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError'
  )
}

function errorName(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as CaptureErrorLike).name === 'string')
    return (err as CaptureErrorLike).name as string
  return ''
}

/**
 * Mensagem legível (pt-BR) para falhas de captura — pelo `name` do DOMException quando houver
 * (`NotAllowedError`, `NotFoundError`, `OverconstrainedError`, `NotReadableError`…) e, para texto
 * solto, por palavras-chave (permissão negada, microfone ausente/ocupado, contexto sem
 * `getUserMedia`). Mensagem não reconhecida volta como veio. Pura (testada em
 * `e2e/voiceDictation.test.ts`).
 */
export function captureErrorText(input: string | CaptureErrorLike | null | undefined): string {
  const name = typeof input === 'string' ? '' : (input?.name ?? '')
  const message = typeof input === 'string' ? input : (input?.message ?? '')
  const m = `${name} ${message}`.toLowerCase()
  if (
    m.includes('notallowederror') ||
    m.includes('securityerror') ||
    m.includes('permissiondenied') ||
    m.includes('permission') ||
    m.includes('negad')
  )
    return 'Permissão de microfone negada — libere o acesso ao microfone para o ClearChat nas configurações do sistema.'
  if (m.includes('overconstrained') || m.includes('constraintnotsatisfied'))
    return 'O microfone escolhido não está disponível (desconectado ou trocado) — escolha outro no menu do microfone.'
  if (
    m.includes('notfounderror') ||
    m.includes('devicesnotfound') ||
    m.includes('notfound') ||
    m.includes('nenhum microfone')
  )
    return 'Nenhum microfone encontrado — conecte um microfone e tente de novo.'
  if (
    m.includes('notreadableerror') ||
    m.includes('trackstarterror') ||
    m.includes('deviceinuse') ||
    m.includes('in use') ||
    m.includes('ocupado')
  )
    return 'Não foi possível abrir o microfone — ele pode estar em uso por outro aplicativo ou ter sido desconectado.'
  if (m.includes('indisponível neste contexto') || m.includes('indisponivel neste contexto'))
    return 'Captura de áudio indisponível neste contexto.'
  if (!message.trim() && name) return `Falha ao abrir o microfone (${name}).`
  return message.replace(/^AudioCapture:\s*/, '') || 'Falha ao abrir o microfone.'
}
