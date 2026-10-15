import { useEffect, useMemo } from 'react'
import {
  compactThreshold,
  contextUsage,
  hasCompactableHistory,
  resolveContextWindow,
  type ContextUsage
} from '@shared/context'
import { sessionProviderId } from '@shared/models'
import type { Chat, Session } from '@shared/types'
import { selectMessages, useStore } from '../store'

export interface ContextInfo {
  usage: ContextUsage | null
  window: number | null
  /** De onde veio a janela. */
  source: 'override' | 'model' | null
  pct: number | null
  threshold: number
  canCompact: boolean
}

/** Uso de contexto da sessão: última usage (ou estimativa pós-compactação) ÷ janela. */
export function useContextInfo(chat: Chat, session: Session): ContextInfo {
  const messages = useStore(selectMessages(session.id))
  const providerId = sessionProviderId(chat.config, session)
  const models = useStore((s) => s.models[providerId]?.list)
  const loadModels = useStore((s) => s.loadModels)
  useEffect(() => {
    if (providerId) void loadModels(providerId)
  }, [providerId, loadModels])
  return useMemo(() => {
    const usage = contextUsage(messages)
    const window = resolveContextWindow(chat.config, session, models)
    const fromModel = models?.find((m) => m.id === session.model)?.contextLength
    const override = chat.config.contextWindow && chat.config.contextWindow > 0
    const source: ContextInfo['source'] = !window
      ? null
      : session.depth === 0
        ? override
          ? 'override'
          : 'model'
        : fromModel
          ? 'model'
          : 'override'
    return {
      usage,
      window,
      source,
      pct: usage && window ? usage.used / window : null,
      threshold: compactThreshold(chat.config),
      canCompact: hasCompactableHistory(messages)
    }
  }, [messages, models, chat.config, session])
}
