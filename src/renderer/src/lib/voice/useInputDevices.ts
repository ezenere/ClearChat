// Microfones de entrada disponíveis no renderer, com hotplug (`devicechange`) — hook fino sobre
// `lib/audio/devices.ts` para os componentes de voz (menu do composer e Configurações → Áudio).
import { useEffect, useState } from 'react'
import type { InputDevice } from '../audio/devices'
import { listInputDevices, onDeviceChange } from '../audio/devices'

/** Microfones disponíveis + se a primeira enumeração já terminou (re-renderiza no hotplug). */
export function useInputDeviceList(): { devices: InputDevice[]; loaded: boolean } {
  const [state, setState] = useState<{ devices: InputDevice[]; loaded: boolean }>({
    devices: [],
    loaded: false
  })
  useEffect(() => {
    let alive = true
    const set = (devices: InputDevice[]): void => {
      if (alive) setState({ devices, loaded: true })
    }
    void listInputDevices()
      .then(set)
      .catch(() => set([]))
    const off = onDeviceChange(set)
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

/** Microfones disponíveis, com hotplug (re-renderiza quando alguém pluga/despluga). */
export function useInputDevices(): InputDevice[] {
  return useInputDeviceList().devices
}
