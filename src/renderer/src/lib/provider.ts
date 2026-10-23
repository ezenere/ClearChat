import { useState } from 'react'
import type { ProviderInput, ProviderTestResult } from '@shared/ipc'
import {
  inferProviderKind,
  PROVIDER_KIND_DEFAULT_URL,
  PROVIDER_KINDS,
  type ProviderKind
} from '@shared/providerKinds'
import { api, errorMessage } from './api'

export interface ProviderDraft {
  name: string
  kind: ProviderKind
  /** O usuário escolheu o tipo manualmente (ou é um provider existente): não inferir pela URL. */
  kindTouched?: boolean
  baseUrl: string
  apiKey: string
  headersText: string
}

const isDefaultUrl = (url: string): boolean => {
  const u = url.trim().replace(/\/+$/, '')
  return PROVIDER_KINDS.some((k) => PROVIDER_KIND_DEFAULT_URL[k] === u)
}

const KIND_NAME: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  elevenlabs: 'ElevenLabs'
}

/**
 * Troca de tipo: preenche a URL padrão se a atual estiver vazia ou for a padrão de outro tipo
 * (idem para o nome, se vazio ou igual ao nome padrão de outro tipo).
 */
export function draftWithKind(d: ProviderDraft, kind: ProviderKind): ProviderDraft {
  const baseUrl =
    !d.baseUrl.trim() || isDefaultUrl(d.baseUrl) ? PROVIDER_KIND_DEFAULT_URL[kind] : d.baseUrl
  const name =
    !d.name.trim() || Object.values(KIND_NAME).includes(d.name.trim()) ? KIND_NAME[kind] : d.name
  return { ...d, kind, kindTouched: true, baseUrl, name }
}

/** Edição da URL: em provider novo sem tipo escolhido manualmente, sugere o tipo pela URL. */
export function draftWithBaseUrl(d: ProviderDraft, baseUrl: string): ProviderDraft {
  return { ...d, baseUrl, kind: d.kindTouched ? d.kind : inferProviderKind(baseUrl) }
}

export function parseHeaders(text: string): Record<string, string> | string {
  if (!text.trim()) return {}
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Deve ser um objeto JSON'
    for (const [k, val] of Object.entries(v)) {
      if (typeof val !== 'string') return `O valor de "${k}" deve ser string`
    }
    return v as Record<string, string>
  } catch (err) {
    return errorMessage(err)
  }
}

export function draftToInput(d: ProviderDraft): ProviderInput | string {
  const headers = parseHeaders(d.headersText)
  if (typeof headers === 'string') return `Headers inválidos: ${headers}`
  if (!d.name.trim()) return 'Informe um nome'
  if (!/^https?:\/\//.test(d.baseUrl.trim()))
    return 'A base URL deve começar com http:// ou https://'
  return {
    name: d.name.trim(),
    kind: d.kind,
    baseUrl: d.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: d.apiKey.trim(),
    headers
  }
}

export function useProviderTest(): {
  testing: boolean
  result: ProviderTestResult | null
  test: (d: ProviderDraft) => Promise<void>
  reset: () => void
} {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const test = async (d: ProviderDraft): Promise<void> => {
    const input = draftToInput(d)
    if (typeof input === 'string') {
      setResult({ ok: false, error: input })
      return
    }
    setTesting(true)
    setResult(null)
    try {
      setResult(
        await api.providers.test({
          kind: input.kind,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          headers: input.headers
        })
      )
    } catch (err) {
      setResult({ ok: false, error: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }
  return { testing, result, test, reset: () => setResult(null) }
}
