// Classificação de falhas de conectividade (rede) vs. erros do provider. Puro (main e testes).
// Ver SPEC.md → "Falha de conexão (nova tentativa)".

/**
 * Erro de conectividade (não do modelo): conexão cortada no meio do stream (undici "terminated" /
 * "other side closed"), DNS/rede indisponível, reset, suspensão do computador, timeout sem resposta.
 * Só olha o texto — use `isConnectionFailure` para um erro lançado (exclui erros do provider).
 */
export function isNetworkError(error: string): boolean {
  return /\bterminated\b|fetch failed|Falha de rede|other side closed|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|UND_ERR_|network (?:error|changed)|Sem resposta do provider/i.test(
    error
  )
}

interface ErrLike {
  message?: unknown
  code?: unknown
  status?: unknown
  cause?: unknown
}

/** Mensagem + causas (message/code), sem repetir. */
function chain(e: unknown): string[] {
  const out: string[] = []
  let cur: unknown = e
  for (let i = 0; i < 4 && cur != null; i++) {
    if (typeof cur === 'string') {
      out.push(cur)
      break
    }
    if (typeof cur !== 'object') {
      out.push(String(cur))
      break
    }
    const o = cur as ErrLike
    if (typeof o.message === 'string' && o.message) out.push(o.message)
    if (typeof o.code === 'string' && o.code) out.push(o.code)
    cur = o.cause
  }
  return out.filter((s, i) => out.findIndex((x) => x.includes(s) || s.includes(x)) === i)
}

/**
 * Erro lançado pela chamada ao modelo é falha de REDE? Erros HTTP (objeto com `status` numérico,
 * texto "Erro HTTP …") e erros vindos do provider no stream ("Erro do provider …") nunca são.
 */
export function isConnectionFailure(e: unknown): boolean {
  if (e && typeof e === 'object' && typeof (e as ErrLike).status === 'number') return false
  const parts = chain(e)
  const first = parts[0] ?? ''
  if (/^Erro HTTP \d|Erro do provider/i.test(first)) return false
  return isNetworkError(parts.join(' '))
}

/** Erro persistido quando o app fecha com o card de falha de conexão aberto. */
export const RETRY_APP_CLOSED_SUFFIX = '(interrompido: o app foi fechado)'
export const retryAppClosedText = (error?: string): string =>
  `Falha de conexão com o provedor${error ? `: ${error}` : ''} ${RETRY_APP_CLOSED_SUFFIX}`

/** Texto curto do erro de rede para o card (mensagem + causa), ≤ 300 caracteres. */
export function connectionErrorText(e: unknown): string {
  const parts = chain(e)
  const [head, ...rest] = parts
  const s = (rest.length ? `${head ?? ''} (${rest.join(' · ')})` : (head ?? 'erro de rede'))
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}
