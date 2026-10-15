import {
  APP_SIGNATURES,
  normalizeAppSignatureId,
  resolveAppSignatureHeaders
} from '@shared/appSignatures'
import { ApiInfo, C } from './ui/Tooltip'
import { Select } from './ui/Select'

type Custom = { referer: string; title: string }

export function AppSignatureInfo({
  id,
  custom,
  side = 'left'
}: {
  id: string
  custom?: Custom
  side?: 'top' | 'left' | 'right' | 'bottom'
}): React.JSX.Element {
  const headers = resolveAppSignatureHeaders(id, custom)
  const empty = Object.keys(headers).length === 0
  return (
    <ApiInfo
      title="Assinatura do app"
      side={side}
      code={
        empty
          ? ''
          : Object.entries(headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')
      }
      codeLabel={empty ? 'Nenhum header de atribuição será enviado:' : 'Headers exatos:'}
    >
      <p>
        Enviada como <strong className="text-fg">headers HTTP</strong> de cada{' '}
        <C>POST /chat/completions</C> (não vai no body nem no prompt): <C>HTTP-Referer</C> e{' '}
        <C>X-Title</C>. O OpenRouter usa esses headers para atribuir o uso a um app; outros
        endpoints normalmente os ignoram.
      </p>
      <p className="text-subtle">
        Campos vazios não são enviados. &quot;Nenhuma&quot; omite os dois headers.
      </p>
    </ApiInfo>
  )
}

export function AppSignatureField({
  value,
  custom,
  onChange,
  compact
}: {
  value: string | undefined
  custom: Custom | undefined
  onChange: (patch: { appSignature?: string; appSignatureCustom?: Custom }) => void
  compact?: boolean
}): React.JSX.Element {
  const id = normalizeAppSignatureId(value)
  const c = custom ?? { referer: '', title: '' }
  return (
    <div className="space-y-2">
      <Select
        value={id}
        onChange={(v) => onChange({ appSignature: v })}
        options={APP_SIGNATURES.map((s) => ({
          value: s.id,
          label: s.label,
          description: s.id === 'custom' ? 'Referer e título definidos por você' : s.referer
        }))}
      />
      {id === 'custom' && (
        <div className={compact ? 'grid grid-cols-2 gap-2' : 'space-y-2'}>
          <input
            className="field font-mono text-[12px]"
            spellCheck={false}
            placeholder="HTTP-Referer (ex.: https://meuapp.dev)"
            value={c.referer}
            onChange={(e) => onChange({ appSignatureCustom: { ...c, referer: e.target.value } })}
          />
          <input
            className="field text-[12.5px]"
            placeholder="X-Title (ex.: Meu App)"
            value={c.title}
            onChange={(e) => onChange({ appSignatureCustom: { ...c, title: e.target.value } })}
          />
        </div>
      )}
    </div>
  )
}
