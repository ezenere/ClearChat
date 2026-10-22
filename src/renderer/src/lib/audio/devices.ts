// Dispositivos de entrada de áudio (renderer): listagem, hotplug (`devicechange`), labels e
// resolução do "padrão do sistema". Sem IPC — usa `navigator.mediaDevices` diretamente.
// As funções toleram runtime sem `mediaDevices` (contexto não seguro): devolvem lista vazia.

/** Um microfone disponível. */
export interface InputDevice {
  /** deviceId do sistema; `'default'` é a entrada sintética do "padrão do sistema" (Chrome). */
  deviceId: string
  /** Nome legível; vazio quando a permissão de microfone ainda não foi concedida. */
  label: string
  /** Este dispositivo é o "padrão do sistema" (entrada sintética `default` quando existe). */
  isDefault: boolean
}

function mediaDevices(): MediaDevices | undefined {
  return typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
}

async function enumerateInputs(): Promise<MediaDeviceInfo[]> {
  const md = mediaDevices()
  if (!md?.enumerateDevices) return []
  const devices = await md.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput')
}

function toInputDevice(info: MediaDeviceInfo): InputDevice {
  return {
    deviceId: info.deviceId,
    label: info.label,
    isDefault: info.deviceId === 'default'
  }
}

/**
 * Lista os microfones disponíveis. Quando a lista vier vazia ou com labels vazios (permissão ainda
 * não concedida — o Electron esconde os dispositivos até o primeiro `getUserMedia`), abre uma faixa
 * só para liberar a lista/labels, encerra imediatamente e enumera de novo — se a permissão for
 * negada, devolve o que tiver (possivelmente vazio) sem lançar.
 */
export async function listInputDevices(): Promise<InputDevice[]> {
  const md = mediaDevices()
  if (!md?.enumerateDevices) return []
  let infos = await enumerateInputs()
  if (infos.length === 0 || infos.some((d) => !d.label)) {
    try {
      const stream = await md.getUserMedia({ audio: true, video: false })
      stream.getTracks().forEach((t) => t.stop())
      infos = await enumerateInputs()
    } catch {
      // permissão negada: mantém a lista como veio (labels vazios ou lista vazia)
    }
  }
  return infos.map(toInputDevice)
}

/**
 * Assina mudanças na lista de dispositivos (hotplug: microfone plugado/desconectado). O listener
 * recebe a lista nova já resolvida; devolve a função de cancelamento da assinatura.
 */
export function onDeviceChange(listener: (devices: InputDevice[]) => void): () => void {
  const md = mediaDevices()
  if (!md?.addEventListener) return () => {}
  const handler = (): void => {
    void listInputDevices().then(listener)
  }
  md.addEventListener('devicechange', handler)
  return () => md.removeEventListener('devicechange', handler)
}

/**
 * Resolve o dispositivo a usar para `AudioCapture.start()`: `deviceId` explícito passa direto;
 * `null` (padrão do sistema) vira o deviceId concreto da entrada `default`, ou o primeiro
 * microfone da lista quando o runtime não expõe a entrada sintética (ou `null` se não há nenhum).
 */
export function resolveInputDeviceId(
  deviceId: string | null,
  devices: readonly InputDevice[]
): string | null {
  if (deviceId) return deviceId
  const def = devices.find((d) => d.isDefault)
  return def?.deviceId ?? devices[0]?.deviceId ?? null
}
