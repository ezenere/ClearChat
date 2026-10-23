// Botão de microfone do composer (ditado por voz): clique inicia/para a gravação; a seta abre o
// menu de seleção de microfone (`role="menu"` com itens `menuitemradio` — "Padrão do sistema" +
// dispositivos reais; as entradas sintéticas do Chromium "Default"/"Communications" ficam de fora
// e o nome do padrão atual vai no rótulo do "Padrão do sistema"; microfone salvo que sumiu aparece
// marcado como desconectado), atualiza em hotplug, grava `audioInput.deviceId` e tem o atalho para
// Configurações → Áudio. O foco entra no item marcado ao abrir; ↑/↓ navegam, Esc fecha.
import { Check, ChevronDown, Mic, Settings2, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DictationControls } from '../../lib/voice/useDictation'
import { useInputDeviceList } from '../../lib/voice/useInputDevices'
import { menuInputDevices } from '../../lib/audio/devices'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Popover } from '../ui/layers'
import { Tip } from '../ui/Tooltip'

/** Botão Mic + chevron do menu de microfone (esconde-se sem `window.api.voice`). */
export function MicButton({
  dictation,
  compact
}: {
  dictation: DictationControls
  /** Barra apertada: só o botão do mic (sem o chevron do menu). */
  compact?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const recording = dictation.state === 'recording'
  if (!dictation.available) return null
  const close = (): void => {
    setOpen(false)
    menuButton.current?.focus()
  }
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
      {!compact && (
        <Tip label="Escolher microfone">
          <button
            type="button"
            ref={menuButton}
            data-testid="voice-mic-menu-button"
            onClick={(e) => {
              e.stopPropagation()
              setOpen((o) => !o)
            }}
            aria-label="Escolher microfone"
            aria-haspopup="menu"
            aria-expanded={open}
            className={cn(
              '-ml-1.5 flex h-7 w-5 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg',
              open && 'bg-hover text-fg'
            )}
          >
            <ChevronDown className="size-3.5" />
          </button>
        </Tip>
      )}
      {open && (
        <Popover open={open} onClose={close} anchor={anchor} width={300} maxHeight={360}>
          <MicMenu dictation={dictation} onClose={close} />
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
  const { devices: all, loaded } = useInputDeviceList()
  const { systemLabel, devices } = menuInputDevices(all)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const current = dictation.settings.deviceId
  // microfone salvo que não está na lista (desconectado): fica visível, marcado, com aviso
  // (lista sem permissão vem com deviceIds vazios — aí não dá para saber, não marca)
  const missing =
    loaded &&
    current !== null &&
    all.every((d) => !!d.deviceId) &&
    !all.some((d) => d.deviceId === current)
  const menuRef = useRef<HTMLDivElement>(null)
  const pick = (deviceId: string | null): void => {
    void dictation.updateSettings({ deviceId })
    onClose()
  }
  // foco no item marcado ao abrir (ou no primeiro)
  useEffect(() => {
    const root = menuRef.current
    if (!root) return
    const target =
      root.querySelector<HTMLElement>('[role=menuitemradio][aria-checked=true]') ??
      root.querySelector<HTMLElement>('[role=menuitemradio]')
    target?.focus()
  }, [all.length])
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role^=menuitem]') ?? [])
    ].filter((el) => !(el as HTMLButtonElement).disabled)
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % items.length
            : (i - 1 + items.length) % items.length
    items[next]?.focus()
  }
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Microfone do ditado"
      data-testid="voice-mic-menu"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <p className="border-b border-border px-3 py-2 text-[11px] text-subtle">
        Microfone do ditado (o mesmo de Configurações → Áudio)
      </p>
      <div className="max-h-[260px] overflow-y-auto p-1">
        <MenuItem
          testId="voice-mic-option-system"
          label={systemLabel ? `Padrão do sistema (${systemLabel})` : 'Padrão do sistema'}
          checked={current === null}
          onClick={() => pick(null)}
        />
        {missing && (
          <MenuItem
            testId="voice-mic-option-missing"
            label="Microfone salvo (desconectado)"
            hint="Não encontrado — a gravação usa o padrão do sistema"
            checked
            warning
            onClick={() => pick(null)}
          />
        )}
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
        role="menuitem"
        data-testid="voice-settings-link"
        onClick={() => {
          onClose()
          setSettingsOpen(true, 'audio')
        }}
        className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:outline-none"
      >
        <Settings2 className="size-3.5" />
        Configurações → Áudio…
      </button>
    </div>
  )
}

function MenuItem({
  label,
  hint,
  checked,
  warning,
  onClick,
  testId
}: {
  label: string
  hint?: string
  checked: boolean
  warning?: boolean
  onClick: () => void
  testId: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-testid={testId}
      data-checked={checked ? 'true' : 'false'}
      title={hint}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none',
        checked ? 'text-fg' : 'text-muted',
        warning && 'text-warning'
      )}
    >
      {warning && <TriangleAlert className="size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block truncate text-[10.5px] text-subtle">{hint}</span>}
      </span>
      {checked && !warning && <Check className="size-3.5 shrink-0 text-accent-strong" />}
    </button>
  )
}
