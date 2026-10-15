import { CircleAlert, CircleCheck, Eye, EyeOff, PlugZap } from 'lucide-react'
import { useState } from 'react'
import type { ProviderTestResult } from '@shared/ipc'
import { PROVIDER_KIND_LABEL, PROVIDER_KINDS, type ProviderKind } from '@shared/providerKinds'
import { draftWithBaseUrl, draftWithKind, parseHeaders, type ProviderDraft } from '../lib/provider'
import { cn } from '../lib/format'
import { Button, Label } from './ui/controls'
import { Select } from './ui/Select'
import { ApiInfo, C } from './ui/Tooltip'

const KIND_DESCRIPTION: Record<ProviderKind, string> = {
  openai: 'Qualquer API compatível com /chat/completions da OpenAI',
  openrouter: 'OpenAI-compatible + extras (custo, reasoning, cache, PDF em qualquer modelo)',
  anthropic: 'POST /messages nativo: PDF, prompt caching, x-api-key'
}

function BaseUrlHelp({ kind }: { kind: ProviderKind }): React.JSX.Element {
  if (kind === 'anthropic')
    return (
      <p>
        API nativa da Anthropic: as requests vão para <C>POST {'{baseUrl}'}/messages</C> (streaming
        SSE, headers <C>x-api-key</C> e <C>anthropic-version</C>), com suporte a PDF (bloco{' '}
        <C>document</C>) e prompt caching (<C>cache_control</C>). A lista de modelos vem de{' '}
        <C>GET {'{baseUrl}'}/models</C>.
      </p>
    )
  if (kind === 'openrouter')
    return (
      <p>
        As requests vão para <C>POST {'{baseUrl}'}/chat/completions</C> (streaming SSE) com os
        extras do OpenRouter (<C>usage.include</C>, <C>reasoning</C>, <C>cache_control</C>, PDF via
        file-parser) e a lista de modelos (com modalidades e preços) vem de{' '}
        <C>GET {'{baseUrl}'}/models</C>.
      </p>
    )
  return (
    <p>
      As requests vão para <C>POST {'{baseUrl}'}/chat/completions</C> (streaming SSE) e a lista de
      modelos vem de <C>GET {'{baseUrl}'}/models</C>.
    </p>
  )
}

export function SecretInput({
  value,
  onChange,
  placeholder,
  autoFocus
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        autoFocus={autoFocus}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="field pr-9 font-mono text-[12.5px]"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Ocultar chave' : 'Mostrar chave'}
        className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg"
      >
        {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  )
}

export function TestResult({
  result
}: {
  result: ProviderTestResult | null
}): React.JSX.Element | null {
  if (!result) return null
  return (
    <div
      className={cn(
        'flex animate-slide-up items-start gap-2 rounded-lg border px-3 py-2 text-xs',
        result.ok
          ? 'border-success/20 bg-success/[0.06] text-success'
          : 'border-danger/25 bg-danger/[0.06] text-danger'
      )}
    >
      {result.ok ? (
        <CircleCheck className="mt-px size-3.5 shrink-0" />
      ) : (
        <CircleAlert className="mt-px size-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">
        {result.ok
          ? `Conexão ok${result.modelCount != null ? ` · ${result.modelCount} modelos disponíveis` : ''}`
          : result.error || 'Falha na conexão'}
      </span>
    </div>
  )
}

export function ProviderFields({
  draft,
  onChange,
  showHeaders = true,
  autoFocusKey
}: {
  draft: ProviderDraft
  onChange: (d: ProviderDraft) => void
  showHeaders?: boolean
  autoFocusKey?: boolean
}): React.JSX.Element {
  const headersErr = typeof parseHeaders(draft.headersText) === 'string'
  return (
    <div className="space-y-4">
      <div>
        <Label>Nome</Label>
        <input
          className="field"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </div>
      <div>
        <Label
          info={
            <ApiInfo title="Tipo / API">
              <p>
                Define o adaptador usado para falar com o provedor (formato da request, headers e
                recursos como PDF e cache).
              </p>
            </ApiInfo>
          }
        >
          Tipo / API
        </Label>
        <Select<ProviderKind>
          value={draft.kind}
          options={PROVIDER_KINDS.map((k) => ({
            value: k,
            label: PROVIDER_KIND_LABEL[k],
            description: KIND_DESCRIPTION[k]
          }))}
          onChange={(k) => onChange(draftWithKind(draft, k))}
        />
      </div>
      <div>
        <Label
          info={
            <ApiInfo title="Base URL">
              <BaseUrlHelp kind={draft.kind} />
            </ApiInfo>
          }
        >
          Base URL
        </Label>
        <input
          className="field font-mono text-[12.5px]"
          spellCheck={false}
          value={draft.baseUrl}
          onChange={(e) => onChange(draftWithBaseUrl(draft, e.target.value))}
        />
      </div>
      <div>
        <Label
          info={
            <ApiInfo title="API key">
              <p>
                Enviada no header{' '}
                {draft.kind === 'anthropic' ? (
                  <C>x-api-key: {'<chave>'}</C>
                ) : (
                  <C>Authorization: Bearer {'<chave>'}</C>
                )}{' '}
                de cada request. Fica salva apenas no banco local; nos previews de request aparece
                mascarada.
              </p>
            </ApiInfo>
          }
        >
          API key
        </Label>
        <SecretInput
          value={draft.apiKey}
          autoFocus={autoFocusKey}
          placeholder={draft.kind === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
          onChange={(apiKey) => onChange({ ...draft, apiKey })}
        />
      </div>
      {showHeaders && (
        <div>
          <Label
            info={
              <ApiInfo title="Headers extras">
                <p>
                  Objeto JSON de strings mesclado aos headers HTTP de todas as requests deste
                  provedor (depois dos headers de autenticação e <C>Content-Type</C>).
                </p>
              </ApiInfo>
            }
            hint={headersErr ? <span className="text-danger">JSON inválido</span> : 'opcional'}
          >
            Headers extras
          </Label>
          <textarea
            className={cn(
              'field min-h-[64px] font-mono text-[12px]',
              headersErr && 'border-danger/50'
            )}
            spellCheck={false}
            placeholder='{ "X-Custom": "valor" }'
            value={draft.headersText}
            onChange={(e) => onChange({ ...draft, headersText: e.target.value })}
          />
        </div>
      )}
    </div>
  )
}

export function TestButton({
  testing,
  onClick
}: {
  testing: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      variant="secondary"
      loading={testing}
      icon={<PlugZap className="size-3.5" />}
      onClick={onClick}
    >
      Testar conexão
    </Button>
  )
}
