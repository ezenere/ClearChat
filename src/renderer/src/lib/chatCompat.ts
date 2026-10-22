// Compatibilidade modelo ↔ chat no renderer (@shared/modelCompat): capacidades exigidas pelo
// histórico de uma sessão (seletor de modelo) e o motivo de o modelo atual não atender (composer).
import { useEffect, useMemo } from 'react'
import { activePath } from '@shared/branches'
import { sessionProviderId } from '@shared/models'
import { chatRequirements, incompatibility, type ChatCapability } from '@shared/modelCompat'
import { providerKind } from '@shared/providerKinds'
import type { Session } from '@shared/types'
import { useStore } from '../store'

const NONE: ChatCapability[] = []

/**
 * Capacidades que o histórico enviado da sessão exige (caminho ativo dos ramos, desde a última
 * compactação). Carrega as mensagens da sessão se ainda não estiverem no store. Chat vazio → [].
 */
export function useChatRequirements(session: Session | undefined): readonly ChatCapability[] {
  const sid = session?.id ?? ''
  const chat = useStore((s) => (session ? s.chats.find((c) => c.id === session.chatId) : undefined))
  const msgs = useStore((s) => (sid ? s.messages[sid] : undefined))
  const loadMessages = useStore((s) => s.loadMessages)
  const loaded = !!msgs
  useEffect(() => {
    if (sid && !loaded) void loadMessages(sid)
  }, [sid, loaded, loadMessages])
  const nativeTools = chat?.config.nativeTools ?? true
  const enabledTools = chat?.config.enabledTools
  const branchSel = session?.branchSel
  const key = useMemo(() => {
    if (!msgs?.length) return ''
    const path = activePath(msgs, branchSel)
    return chatRequirements(path, { nativeTools, enabledTools: enabledTools ?? [] }).join(',')
  }, [msgs, branchSel, nativeTools, enabledTools])
  return useMemo(() => (key ? (key.split(',') as ChatCapability[]) : NONE), [key])
}

/**
 * Motivo (pt-BR, sem ponto) de o modelo atual da sessão não atender ao histórico — ex.: o modelo
 * foi trocado por outro dispositivo/IPC sem passar pelo seletor. null = compatível ou desconhecido.
 */
export function useHistoryIncompatibility(session: Session | undefined): string | null {
  const required = useChatRequirements(session)
  const chat = useStore((s) => (session ? s.chats.find((c) => c.id === session.chatId) : undefined))
  const providerId = chat && session ? sessionProviderId(chat.config, session) : ''
  const provider = useStore((s) => s.providers.find((p) => p.id === providerId))
  const model = useStore((s) =>
    providerId && session
      ? s.models[providerId]?.list.find((m) => m.id === session.model)
      : undefined
  )
  if (!required.length || !provider || !session) return null
  return incompatibility(required, model, providerKind(provider), 'o modelo atual')
}
