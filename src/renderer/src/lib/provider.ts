import { useState } from 'react'
import type { ProviderInput, ProviderTestResult } from '@shared/ipc'
import { api, errorMessage } from './api'

export interface ProviderDraft {
  name: string
  baseUrl: string
  apiKey: string
  headersText: string
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
