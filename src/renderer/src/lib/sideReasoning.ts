// Hooks das chamadas laterais (juiz, resumidor, título): política de raciocínio do modelo escolhido
// e a request exata para o (i) "Enviado à API". Mesma lógica do main (@shared/sideReasoning).
import { useEffect } from 'react'
import { providerKind } from '@shared/providerKinds'
import {
  planSideCall,
  sideAnthropicPreviewBody,
  sideChatBody,
  sideReasoning,
  type SideReasoning
} from '@shared/sideReasoning'
import { sideCacheNote, sideWireMessages, type SideMessage } from '@shared/sideCache'
import { useStore } from '../store'

/** Política de raciocínio da chamada lateral para o par provedor + modelo (null = sem modelo). */
export function useSideReasoning(
  providerId: string | null | undefined,
  model: string | null | undefined
): SideReasoning | null {
  const provider = useStore((s) => s.providers.find((p) => p.id === providerId))
  const info = useStore((s) =>
    providerId && model ? s.models[providerId]?.list.find((m) => m.id === model) : undefined
  )
  const loaded = useStore((s) => (providerId ? !!s.models[providerId] : true))
  const loadModels = useStore((s) => s.loadModels)
  // metadados do /models (OpenRouter: reasoning.mandatory/supported_efforts) — mesmo cache do seletor
  useEffect(() => {
    if (provider && !loaded) void loadModels(provider.id)
  }, [provider, loaded, loadModels])
  if (!provider || !model?.trim()) return null
  return sideReasoning({ kind: providerKind(provider), model, info })
}

/**
 * Request exata (url + body + notas) de uma chamada lateral, para o (i) "Enviado à API": mesma
 * política e mesmo filtro do main (planSideCall; body nativo da Anthropic conferido nos testes).
 */
export function useSideRequestPreview(input: {
  providerId: string | null | undefined
  model: string | null | undefined
  messages: SideMessage[]
  /** "Cache do prompt" (juiz/resumidor). */
  cache?: boolean
  maxTokens: number
  temperature?: number
  thinkingTokens?: number | null
  defaultThinkingTokens: number
}): { url: string; body: Record<string, unknown>; notes: string[] } {
  const { providerId, messages } = input
  const model = input.model?.trim() || '<modelo>'
  const provider = useStore((s) => s.providers.find((p) => p.id === providerId))
  const info = useStore((s) =>
    providerId ? s.models[providerId]?.list.find((m) => m.id === model) : undefined
  )
  const kind = provider ? providerKind(provider) : 'openai'
  const plan = planSideCall({ ...input, kind, model, info })
  const endpoint = kind === 'anthropic' ? 'messages' : 'chat/completions'
  const wire = sideWireMessages(messages, { cache: !!input.cache, kind, model })
  const cacheNote = sideCacheNote(wire)
  return {
    url: provider
      ? `${provider.baseUrl.replace(/\/+$/, '')}/${endpoint}`
      : '<provedor>/chat/completions',
    body:
      kind === 'anthropic'
        ? sideAnthropicPreviewBody(model, wire, plan)
        : sideChatBody(kind, model, wire, plan.send),
    notes: cacheNote ? [...plan.notes, cacheNote] : plan.notes
  }
}
