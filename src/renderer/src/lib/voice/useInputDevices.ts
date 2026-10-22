// Microfones de entrada disponíveis no renderer, com hotplug (`devicechange`) — hook fino sobre
// `lib/audio/devices.ts` para os componentes de voz (menu do composer e Configurações → Áudio).
import { useEffect, useState } from 'react'
import type { InputDevice } from '../audio/devices'
import { listInputDevices, onDeviceChange } from '../audio/devices'

/** Microfones disponíveis, com hotplug (re-renderiza quando alguém pluga/despluga). */
export function useInputDevices(): InputDevice[] {
  const [devices, setDevices] = useState<InputDevice[]>([])
  useEffect(() => {
    let alive = true
    void listInputDevices().then((d) => alive && setDevices(d))
    const off = onDeviceChange((d) => alive && setDevices(d))
    return () => {
      alive = false
      off()
    }
  }, [])
  return devices
}
