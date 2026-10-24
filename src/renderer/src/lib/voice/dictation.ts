// Ditado por voz (renderer): funções PURAS do rascunho de transcrição — ponto de inserção do texto
// final (onde estava o cursor quando o ditado começou, ajustado às edições feitas durante a
// gravação), espaçamento da inserção, a prévia "digitado + ditado" mostrada no campo durante a
// gravação, o desfecho do ditado (✓/×/enviar) e mensagens legíveis das falhas de captura. Sem
// DOM/React — testado em `e2e/voiceDictation.test.ts`.
//
// Durante a gravação o Composer troca a textarea por um ESPELHO somente-leitura (`voice-draft`)
// com o texto digitado (cor normal) + o ditado no ponto de inserção (translúcido — `voice-partial`;
// "Ouvindo…" em itálico enquanto nada foi transcrito). O valor da textarea não muda até o desfecho
// (nada de parcial dentro do texto editável — o bug antigo de rascunho corrompido não volta).
// No ✓ (ou ao soltar a tecla do PTT) o texto final é inserido no ponto de inserção com
// `insertDictationText` (o Composer usa `execCommand('insertText')`, que preserva o desfazer); o ×
// descarta; "Enviar" durante a gravação conclui e envia (`planDictationCommit`).

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

/** Espaços que a inserção precisa: antes, quando o anterior não é espaço; depois, quando o
 * seguinte não é espaço nem pontuação de fechamento. */
function dictationSpacing(before: string, after: string): { lead: string; trail: string } {
  return {
    lead: before && !/\s/.test(before) ? ' ' : '',
    trail: after && !/[\s.,;:!?)\]}…]/.test(after) ? ' ' : ''
  }
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
  const { lead, trail } = dictationSpacing(
    s > 0 ? value[s - 1] : '',
    e < value.length ? value[e] : ''
  )
  const insert = lead + text + trail
  return {
    value: value.slice(0, s) + insert + value.slice(e),
    insert,
    start: s,
    end: e,
    caret: s + insert.length
  }
}

/** Prévia do campo durante o ditado, em pedaços (o `spoken` é o trecho translúcido). */
export interface DictationPreview {
  /** Texto digitado antes do ponto de inserção (cor normal). */
  before: string
  /** Espaço de separação antes do ditado ('' ou ' '). */
  lead: string
  /** O que está sendo ditado (parcial) — ou o marcador ("Ouvindo…") quando ainda não há texto. */
  spoken: string
  /** Espaço de separação depois do ditado ('' ou ' '). */
  trail: string
  /** Texto digitado depois do ponto de inserção (a seleção do início some — será substituída). */
  after: string
}

/**
 * O que o campo mostra durante a gravação: o rascunho ATUAL com `spoken` no ponto de inserção (a
 * âncora do início do ditado, ajustada por `rebaseDictationAnchor`) e o mesmo espaçamento que
 * `insertDictationText` vai usar — `before + lead + spoken + trail + after` é exatamente o valor
 * que o ✓ produz com a mesma fala (o texto não "pula" ao concluir). `spoken` vazio → sem espaços.
 */
export function dictationPreview(
  value: string,
  anchor: DictationAnchor | null,
  spoken: string
): DictationPreview {
  const at = rebaseDictationAnchor(anchor, value)
  const s = Math.max(0, Math.min(value.length, at.start))
  const e = Math.max(s, Math.min(value.length, at.end))
  const text = spoken.trim()
  const { lead, trail } = text
    ? dictationSpacing(s > 0 ? value[s - 1] : '', e < value.length ? value[e] : '')
    : { lead: '', trail: '' }
  return { before: value.slice(0, s), lead, spoken: text, trail, after: value.slice(e) }
}

/** Como um fluxo de ditado terminou (`UseDictationOptions.onSettled`). */
export type DictationSettle =
  /** Transcrição final pronta (`onFinal` recebeu o texto). */
  | 'final'
  /** Nada foi transcrito (silêncio/sem áudio). */
  | 'empty'
  /** A final falhou (a parcial, se houver, fica recuperável). */
  | 'failed'
  /** × / Esc / bloqueio / troca de chat: tudo descartado. */
  | 'cancelled'

/** O que o Composer faz quando o ditado termina. */
export interface DictationCommitPlan {
  /** Texto a inserir no ponto de inserção (final, ou a parcial quando a final falhou ao enviar). */
  insert: string | null
  /** Envia o campo depois da inserção. */
  send: boolean
  /** Aviso visível (ex.: final falhou ao enviar — a parcial entrou, confira e envie). */
  note: string | null
}

/** A final falhou depois de "Enviar": a parcial entra no campo e NADA é enviado. */
export const SEND_FINAL_FAILED_NOTE =
  'A transcrição final falhou — o texto parcial entrou no campo. Confira e envie.'
/** A final demorou mais que o prazo do "Enviar": ela entra quando chegar, sem enviar sozinha. */
export const SEND_FINAL_SLOW_NOTE =
  'A transcrição está demorando — o texto entra no campo quando chegar. Confira e envie.'
/** Quanto "Enviar" durante a gravação espera a final antes de desistir de enviar sozinho. */
export const SEND_FINAL_TIMEOUT_MS = 10_000

/**
 * Desfecho do ditado no Composer (puro): `final` → o texto entra no ponto de inserção e, se o
 * usuário pediu "Enviar" (e o prazo não estourou), o campo inteiro (digitado + final) é enviado;
 * `empty` + "Enviar" → envia o que já estava digitado (se houver); `failed` + "Enviar" → a parcial
 * entra no campo com um aviso e NADA é enviado (nunca sai mensagem com a fala incompleta sem o
 * usuário ver); `failed` sem "Enviar" → o card de erro oferece "Inserir o texto parcial";
 * `cancelled` → nada muda.
 */
export function planDictationCommit(input: {
  settle: DictationSettle
  /** Texto final (`settle: 'final'`). */
  final?: string
  /** Última parcial (para `failed`). */
  partial?: string
  /** O usuário apertou "Enviar" (ou Enter) durante a gravação e o prazo ainda vale. */
  sendRequested: boolean
  /** Há algo para enviar além do ditado (texto digitado/anexos/skills). */
  hasOther: boolean
}): DictationCommitPlan {
  const { settle, sendRequested } = input
  if (settle === 'final') {
    const text = (input.final ?? '').trim()
    return { insert: text || null, send: sendRequested && (!!text || input.hasOther), note: null }
  }
  if (settle === 'empty') return { insert: null, send: sendRequested && input.hasOther, note: null }
  if (settle === 'failed') {
    const partial = (input.partial ?? '').trim()
    if (sendRequested && partial)
      return { insert: partial, send: false, note: SEND_FINAL_FAILED_NOTE }
    return { insert: null, send: false, note: null }
  }
  return { insert: null, send: false, note: null }
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
