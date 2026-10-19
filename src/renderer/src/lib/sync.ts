// Rótulos do estado do sync (renderer).
import type { SyncStatus } from '@shared/sync'

export function connectionLabel(s: SyncStatus): {
  text: string
  tone: 'ok' | 'busy' | 'off' | 'err'
} {
  if (s.protocolError) return { text: 'Protocolo incompatível', tone: 'err' }
  if (s.phase === 'locked') return { text: 'Bloqueado', tone: 'off' }
  if (s.phase !== 'ready') return { text: 'Não conectado', tone: 'off' }
  if (s.error) return { text: 'Erro de sincronização', tone: 'err' }
  if (s.connection === 'offline') return { text: 'Offline', tone: 'off' }
  if (s.connection === 'connecting') return { text: 'Conectando…', tone: 'busy' }
  if (s.pending > 0)
    return { text: `Enviando ${s.pending} mudança${s.pending > 1 ? 's' : ''}`, tone: 'busy' }
  return { text: 'Sincronizado', tone: 'ok' }
}
