// Suporte do modelo atual a anexos (composer, clipe e overlay de arrastar). Ver SPEC.md → "Anexos".
import { useEffect } from 'react'
import { acceptedKinds, modalitySupport, type ModalitySupport } from '@shared/attachments'
import { sessionProviderId } from '@shared/models'
import { providerKind } from '@shared/providerKinds'
import type { AttachmentInfo, AttachmentKind, Session } from '@shared/types'
import { useStore } from '../../store'

const ACCEPT_LABEL: Record<AttachmentKind, string> = {
  image: 'imagens',
  pdf: 'PDF',
  audio: 'áudio (wav/mp3)',
  text: 'texto/código'
}
const REJECT_LABEL: Record<AttachmentKind, string> = {
  image: 'imagens',
  pdf: 'PDF',
  audio: 'áudio',
  text: 'texto'
}

/** "a, b e c" / "a, b nem c". */
function joinPt(items: string[], last: 'e' | 'nem'): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`
}

export interface AttachmentSupport {
  /** Suporte do modelo a um anexo (para os avisos/chips). */
  supportOf: (a: Pick<AttachmentInfo, 'kind'>) => ModalitySupport
  /** O modelo declara as modalidades (senão: desconhecido → aceita tudo com aviso). */
  known: boolean
  /** Tipos aceitos com certeza ('text' sempre). */
  accepted: AttachmentKind[]
  /** Tipos que o modelo declaradamente não aceita (vazio se desconhecido). */
  rejected: AttachmentKind[]
  /** Tooltip do clipe. */
  tooltip: string
  /** Linha de tipos do overlay de arrastar (sem o limite de tamanho). */
  dropText: string
}

/** Suporte do modelo da sessão (inputModalities do /models + adaptador do provider). */
export function useAttachmentSupport(session: Session | undefined): AttachmentSupport {
  const chat = useStore((s) => (session ? s.chats.find((c) => c.id === session.chatId) : undefined))
  const providerId = chat && session ? sessionProviderId(chat.config, session) : ''
  const provider = useStore((s) => s.providers.find((p) => p.id === providerId))
  const models = useStore((s) => s.models[providerId])
  const loadModels = useStore((s) => s.loadModels)
  useEffect(() => {
    if (providerId) void loadModels(providerId)
  }, [providerId, loadModels])
  const model = session ? models?.list.find((m) => m.id === session.model) : undefined
  const pk = provider ? providerKind(provider) : 'openai'
  const known = !!model?.inputModalities
  const accepted = acceptedKinds(model, pk)
  const rejected = known
    ? (['image', 'pdf', 'audio'] as AttachmentKind[]).filter((k) => !accepted.includes(k))
    : []

  let tooltip: string
  let dropText: string
  if (!known) {
    tooltip = 'Anexar arquivos (imagens, PDF, áudio, texto) — ou arraste/cole'
    dropText = 'Imagens, PDF, áudio (wav/mp3) e arquivos de texto'
  } else if (accepted.length === 1) {
    const no = `este modelo não aceita ${joinPt(
      rejected.map((k) => REJECT_LABEL[k]),
      'nem'
    )}`
    tooltip = `Anexar arquivos de texto/código (${no}) — ou arraste/cole`
    dropText = `Arquivos de texto/código (${no})`
  } else {
    const yes = joinPt(
      accepted.map((k) => ACCEPT_LABEL[k]),
      'e'
    )
    const no = rejected.length
      ? ` · não aceita ${joinPt(
          rejected.map((k) => REJECT_LABEL[k]),
          'nem'
        )}`
      : ''
    tooltip = `Anexar arquivos (${accepted.map((k) => ACCEPT_LABEL[k]).join(', ')})${no} — ou arraste/cole`
    dropText = `Este modelo aceita ${yes}${no}`
  }

  return {
    supportOf: (a) => modalitySupport(a.kind, model, pk),
    known,
    accepted,
    rejected,
    tooltip,
    dropText
  }
}
