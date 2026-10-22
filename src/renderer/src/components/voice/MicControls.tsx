// Botão de microfone do composer (ditado por voz): clique inicia/para a gravação; a seta abre o
// menu de seleção de microfone (lista com marcação do atual + "Padrão do sistema", atualiza em
// hotplug, grava `audioInput.deviceId`) e o atalho para Configurações → Áudio.
import { Check, ChevronDown, Mic, Settings2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { DictationControls } from '../../lib/voice/useDictation'
import { useInputDevices } from '../../lib/voice/useInputDevices'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Popover } from '../ui/layers'
import { Tip } from '../ui/Tooltip'

/** Botão Mic + chevron do menu de microfone (esconde-se sem `window.api.voice`). */
export function MicButton({
  dictation
}: {
  dictation: DictationControls
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const recording = dictation.state === 'recording'
  if (!dictation.available) return null
  return (
    <>
      <Tip label={recording ? 'Parar gravação' : 'Ditar por voz'}>
        <button
          type="button"
          ref={anchor}
          data-testid="voice-mic-button"
          onClick={(e) => {
            e.stopPropagation()
            void (recording ? dictation.stop() : dictation.start())
          }}
          aria-label={recording ? 'Parar gravação' : 'Ditar por voz'}
          aria-pressed={recording}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg',
            recording &&
              'bg-accent/15 text-accent-strong hover:bg-accent/25 hover:text-accent-strong'
          )}
        >
          <Mic className={cn('size-4', recording && 'animate-pulse-soft')} />
        </button>
      </Tip>
      <Tip label="Escolher microfone">
        <button
          type="button"
          data-testid="voice-mic-menu-button"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          aria-label="Escolher microfone"
          className={cn(
            '-ml-1.5 flex size-5 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg',
            open && 'bg-hover text-fg'
          )}
        >
          <ChevronDown className="size-3" />
        </button>
      </Tip>
      {open && (
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchor={anchor}
          width={300}
          maxHeight={360}
        >
          <MicMenu dictation={dictation} onClose={() => setOpen(false)} />
        </Popover>
      )}
    </>
  )
}

function MicMenu({
  dictation,
  onClose
}: {
  dictation: DictationControls
  onClose: () => void
}): React.JSX.Element {
  const devices = useInputDevices()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const current = dictation.settings.deviceId
  const pick = (deviceId: string | null): void => {
    void dictation.updateSettings({ deviceId })
    onClose()
  }
  return (
    <div data-testid="voice-mic-menu" onClick={(e) => e.stopPropagation()}>
      <p className="border-b border-border px-3 py-2 text-[11px] text-subtle">
        Microfone do ditado (padrão: o escolhido em Configurações → Áudio)
      </p>
      <div className="max-h-[260px] overflow-y-auto p-1">
        <MenuItem
          testId="voice-mic-option-system"
          label="Padrão do sistema"
          checked={current === null}
          onClick={() => pick(null)}
        />
        {devices.map((d, i) => (
          <MenuItem
            key={d.deviceId}
            testId="voice-mic-option-device"
            label={d.label || `Microfone ${i + 1}`}
            checked={current === d.deviceId}
            onClick={() => pick(d.deviceId)}
          />
        ))}
        {devices.length === 0 && (
          <p className="px-2.5 py-2 text-[11.5px] text-subtle">
            Nenhum microfone encontrado (ou permissão ainda não concedida).
          </p>
        )}
      </div>
      <button
        type="button"
        data-testid="voice-settings-link"
        onClick={() => {
          onClose()
          setSettingsOpen(true, 'audio')
        }}
        className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <Settings2 className="size-3.5" />
        Configurações → Áudio…
      </button>
    </div>
  )
}

function MenuItem({
  label,
  checked,
  onClick,
  testId
}: {
  label: string
  checked: boolean
  onClick: () => void
  testId: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-checked={checked ? 'true' : 'false'}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover',
        checked ? 'text-fg' : 'text-muted'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check className="size-3.5 shrink-0 text-accent-strong" />}
    </button>
  )
}
