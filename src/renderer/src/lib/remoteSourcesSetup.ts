// Liga a fonte remota de arquivos (lib/remoteFiles.ts) ao app: IPC do main (comandos fs.* pelo
// sync, "Salvar como…" / "Abrir no app" com os bytes) e o store (registro de present_file,
// dispositivo local, host do chat). Chamado uma vez no boot (main.tsx), depois do mock/preload.
import { api } from './api'
import { localFileSource, registerRemoteSources } from './fileSources'
import { createRemoteSources } from './remoteFiles'
import { useStore } from '../store'

export function setupRemoteSources(): void {
  const remote = createRemoteSources(
    {
      listDir: (chatId, path) => api.sync.remoteListDir(chatId, path),
      readChunk: (chatId, path, offset, length) =>
        api.sync.remoteReadFile(chatId, path, offset, length),
      saveBytes: (name, bytes) => api.viewer.saveBytes(name, bytes),
      openBytes: (name, bytes) => api.viewer.openBytes(name, bytes)
    },
    {
      presented: (_chatId, messageId) => {
        for (const list of Object.values(useStore.getState().messages)) {
          const m = list?.find((x) => x.id === messageId)
          if (m) return m.meta.presentFiles ?? null
        }
        return null
      },
      myDeviceId: () => useStore.getState().sync?.device?.id ?? null,
      host: (chatId) => {
        const h = useStore.getState().chatHosts[chatId]?.host
        return h ? { deviceId: h.deviceId, name: h.name } : null
      },
      local: localFileSource
    }
  )
  registerRemoteSources({ file: remote.file, dir: remote.dir })
}
