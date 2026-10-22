// Ditado por voz (renderer): funções PURAS do rascunho de transcrição — composição do rascunho
// durante a gravação (parciais `onVoicePartial` + cursor `▌`), separação da edição do usuário e a
// mesclagem do texto final. Sem DOM/React — testado em `e2e/voiceDictation.test.ts`.
//
// O campo de texto continua uma textarea controlada simples: durante a gravação o *valor exibido*
// é `composeDictationDraft(textoDoUsuario, parcial)` (parcial acinzentada não é possível dentro de
// textarea; o sufixo `▌` marca o rascunho falado) e toda edição passa por `splitDictationEdit`,
// que devolve o texto do usuário sem o sufixo. No stop, `mergeDictationDraft` vira rascunho normal
// editável — o envio é SEMPRE manual.

/** Cursor visual do rascunho falado (parcial ao vivo ou texto gravado ainda não confirmado). */
export const DICTATION_CURSOR = '▌'

/**
 * Junta o texto falado ao rascunho digitado, com UM espaço de separação quando necessário
 * (a base acaba em espaço/quebra de linha ou está vazia → sem espaço extra). `spoken` vazio
 * devolve a base como está.
 */
export function mergeDictationDraft(base: string, spoken: string): string {
  if (!spoken) return base
  if (!base) return spoken
  return /\s$/.test(base) ? base + spoken : `${base} ${spoken}`
}

/** Texto exibido na textarea durante a gravação: rascunho + parcial + `▌` (parcial vazia → base). */
export function composeDictationDraft(base: string, partial: string): string {
  return partial ? mergeDictationDraft(base, partial) + DICTATION_CURSOR : base
}

/**
 * Interpreta uma edição do usuário sobre o valor composto: devolve o novo texto-base e a parcial
 * resultante. Se a edição preservou o sufixo conhecido (parcial + `▌`), só a base muda; se o
 * usuário mexeu na própria parcial (sufixo não casa), a parcial é descartada (a seguinte recompõe
 * do zero) e o `▌` órfão é removido.
 */
export function splitDictationEdit(
  value: string,
  partial: string,
  base: string
): { text: string; partial: string } {
  if (!partial) return { text: value, partial: '' }
  const sep = base === '' || /\s$/.test(base) ? '' : ' '
  const suffix = sep + partial + DICTATION_CURSOR
  if (value.endsWith(suffix)) {
    return { text: value.slice(0, value.length - suffix.length), partial }
  }
  return {
    text: value.endsWith(DICTATION_CURSOR) ? value.slice(0, -DICTATION_CURSOR.length) : value,
    partial: ''
  }
}

/**
 * Mensagem legível (pt-BR) para falhas de captura — permissão negada, microfone ausente/ocupado e
 * contexto sem `getUserMedia`. Mensagem não reconhecida volta como veio. Pura (testada em
 * `e2e/voiceDictation.test.ts`).
 */
export function captureErrorText(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('notallowederror') || m.includes('permission') || m.includes('negad'))
    return 'Permissão de microfone negada — libere o acesso ao microfone para o ClearChat nas configurações do sistema.'
  if (m.includes('notfounderror') || m.includes('notfound') || m.includes('nenhum microfone'))
    return 'Nenhum microfone encontrado — conecte um microfone e tente de novo.'
  if (m.includes('deviceinuse') || m.includes('in use') || m.includes('ocupado'))
    return 'Microfone em uso por outro aplicativo.'
  if (m.includes('indisponível neste contexto') || m.includes('indisponivel neste contexto'))
    return 'Captura de áudio indisponível neste contexto.'
  return message
}
