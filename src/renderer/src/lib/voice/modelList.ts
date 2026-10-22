// Helpers PUROS da lista de modelos locais de áudio (SPEC → "Áudio → Componentes locais"): tamanho
// legível (KB/MB/GB), idiomas e o mapeamento estado → ação do painel Configurações → Áudio
// (botão, badge e aviso). Sem DOM, sem React — testado em `e2e/voiceModelsUi.test.ts`.
import type { VoiceModelState } from '@shared/ipc'

/** "31.0" → "31"; "1.51" → "1,51" (vírgula decimal pt-BR, sem zero supérfluo). */
const brNum = (n: number, decimals: number): string =>
  n.toFixed(decimals).replace(/\.0+$/, '').replace('.', ',')

/**
 * Tamanho legível do modelo: unidades binárias rotuladas B/KB/MB/GB (1 KB = 1024 B), uma casa
 * decimal em KB/MB e duas em GB. Ex.: 77.691.713 → '74,1 MB'; 1.624.555.275 → '1,51 GB'.
 */
export function formatModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const b = Math.floor(bytes)
  if (b < 1024) return `${b} B`
  const kb = b / 1024
  if (kb < 1024) return `${brNum(kb, 1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${brNum(mb, 1)} MB`
  return `${brNum(mb / 1024, 2)} GB`
}

const LANGUAGE_LABELS: Record<string, string> = {
  mul: 'Multilíngue',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  en: 'Inglês',
  'en-US': 'Inglês (EUA)'
}

/** Idiomas do modelo para a UI: `'mul'` → 'Multilíngue', códigos conhecidos por extenso. */
export function formatModelLanguages(languages: readonly string[]): string {
  if (!languages.length) return '—'
  return languages.map((l) => LANGUAGE_LABELS[l] ?? l).join(', ')
}

/** O que o painel mostra/faz para um modelo, segundo o estado em disco. */
export interface LocalModelAction {
  /** Ação do botão principal (`null` = sem ação possível — placeholder sem download). */
  action: 'download' | 'retry' | 'remove' | 'cancel' | null
  /** Rótulo do botão principal. */
  label: string
  /** Rótulo do badge de estado. */
  badge: string
  /** Aviso do estado (ex.: arquivo corrompido); null = sem aviso. */
  warning: string | null
}

/**
 * Estado → ação do painel de modelos locais: `notInstalled` → "Baixar", `downloading` → "Cancelar",
 * `installed` → "Remover", `corrupt` → "Baixar novamente" (com aviso). Sem URL de download
 * (placeholder de TTS) a ação fica `null` — a UI mostra o botão desabilitado com a nota da fatia.
 */
export function modelAction(state: VoiceModelState, hasDownload: boolean): LocalModelAction {
  switch (state) {
    case 'installed':
      return { action: 'remove', label: 'Remover', badge: 'instalado', warning: null }
    case 'downloading':
      return { action: 'cancel', label: 'Cancelar', badge: 'baixando…', warning: null }
    case 'corrupt':
      return {
        action: hasDownload ? 'retry' : null,
        label: 'Baixar novamente',
        badge: 'corrompido',
        warning: 'arquivo divergente ou incompleto — baixe novamente'
      }
    default:
      return {
        action: hasDownload ? 'download' : null,
        label: 'Baixar',
        badge: 'não instalado',
        warning: null
      }
  }
}
