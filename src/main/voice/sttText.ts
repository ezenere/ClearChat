// Limpeza PURA do texto devolvido pelo whisper.cpp (sem dependências — importado pelo processo do
// motor `sttWorker.ts`). O whisper escreve anotações de não-fala entre colchetes/parênteses quando
// ouve silêncio, ruído ou música ("[MÚSICA DE FUNDO]", "[música]", "(risos)") e créditos de
// legenda decorados do treino ("Legendas pela comunidade Amara.org"). Nada disso é fala ditada: sai
// do texto (parcial e final). Ver SPEC → "Áudio → Runtime local de STT".

/** Palavras de anotação de não-fala (pt/en) que o whisper põe entre parênteses. */
const NON_SPEECH_WORDS =
  /^(?:m[uú]sica(?: de fundo)?|risos?|risadas?|aplausos?|sil[eê]ncio|ru[ií]do|barulho|tosse|suspiros?|inaud[ií]vel|som(?: de [^)]*)?|music|laughs?|laughter|applause|noise|silence|coughs?|inaudible|blank_audio)$/i

/** Créditos de legenda que o whisper alucina em silêncio (nunca são fala ditada). */
const SUBTITLE_CREDITS = /\b(?:legendas?|legendado|transcri[çc][aã]o)\b[^.!?]*\bamara\.org\b[.!]?/gi

/**
 * Tira do texto do whisper as anotações de não-fala: qualquer trecho `[...]` (o whisper só usa
 * colchetes para isso), `(...)` cujo conteúdo é uma anotação conhecida ("(música)", "(risos)"),
 * notas musicais e créditos de legenda do Amara.org; normaliza os espaços. Texto só de anotação →
 * string vazia.
 */
export function cleanWhisperText(text: string): string {
  return text
    .replace(/\[[^\]\n]{0,80}\]/g, ' ')
    .replace(/\(([^)\n]{1,40})\)/g, (all, inner: string) =>
      NON_SPEECH_WORDS.test(inner.trim().replace(/[.!…]+$/, '')) ? ' ' : all
    )
    .replace(/[♪♫]+/g, ' ')
    .replace(SUBTITLE_CREDITS, ' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:…-]+(?=\S)/, '')
    .replace(/^[\p{P}\s]+$/u, '')
    .trim()
}
