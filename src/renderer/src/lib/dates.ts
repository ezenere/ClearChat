// Hora/data das mensagens (estilo WhatsApp) — funções puras, fuso local do sistema, 24 h, pt-BR.
// Sem cache de Intl: o fuso é lido a cada chamada (os testes trocam `process.env.TZ`).

const pad = (n: number): string => String(n).padStart(2, '0')

/** Chave do dia local: "2026-10-16". */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "14:28" (24 h, fuso local). */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "16/10/2026 14:28:05" (tooltip da hora). */
export function formatFullDateTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Diferença em dias de calendário locais (now − ts): 0 = mesmo dia, 1 = ontem; imune a horário de verão. */
export function calendarDayDiff(ts: number, now: number): number {
  const a = new Date(ts)
  const b = new Date(now)
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((ub - ua) / 86_400_000)
}

/** Rótulo do separador de dia: "Hoje" / "Ontem" / "qui., 15 de out." / "qui., 15 de out. de 2025". */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const diff = calendarDayDiff(ts, now)
  if (diff === 0) return 'Hoje'
  if (diff === 1) return 'Ontem'
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear()
  return new Date(ts).toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

/**
 * Ids que abrem um dia novo numa sequência ordenada (o primeiro item sempre abre).
 * Recebe só os itens que de fato aparecem na lista.
 */
export function dayStarts(items: readonly { id: string; createdAt: number }[]): Set<string> {
  const out = new Set<string>()
  let prev: string | null = null
  for (const it of items) {
    const k = dayKey(it.createdAt)
    if (k !== prev) out.add(it.id)
    prev = k
  }
  return out
}

/** Milissegundos até a próxima meia-noite local (+ folga), para trocar "Hoje" → "Ontem". */
export function msUntilNextDay(now: number = Date.now()): number {
  const d = new Date(now)
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 1)
  return Math.max(1000, next.getTime() - now)
}
