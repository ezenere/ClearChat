// Título automático — ligação com o app: config em `settings`, banco, eventos e memórias. O runner
// agenda a geração quando um chat novo recebe a 1ª mensagem digitada (sem esperar: o turno do
// agente não atrasa); o header do chat pede "Gerar título" (IPC chats.generateTitle).
// Ver SPEC.md → "Título automático".
import {
  AUTO_TITLE_DEFAULTS,
  AUTO_TITLE_MEMORY_HEADER,
  AUTO_TITLE_SETTING,
  autoTitleEnabled,
  normalizeAutoTitleSettings,
  type AutoTitleSettings
} from '@shared/autoTitle'
import { contentText, messageAttachments, messageSkills } from '@shared/attachments'
import { splitInterChatText } from '@shared/interChat'
import type { Chat, MessageMeta, StoredMessage } from '@shared/types'
import { emit } from './events'
import { chatsRepo, messagesRepo, providersRepo, settingsRepo } from './repo'
import { memoryService } from './memory'
import { runAutoTitle, type AutoTitleDeps, type AutoTitleJob } from './agent/autoTitle'

export function getAutoTitleSettings(): AutoTitleSettings {
  return normalizeAutoTitleSettings(settingsRepo.get(AUTO_TITLE_SETTING))
}

/** Índice compacto das memórias ativas do chat (sessão principal); null = memória desligada. */
function memoryText(chat: Chat): string | null {
  const svc = memoryService()
  const am = svc.active(chat, { depth: 0 })
  if (!am.active) return null
  return svc.renderIndex(am, {
    maxChars: AUTO_TITLE_DEFAULTS.memoryChars,
    header: AUTO_TITLE_MEMORY_HEADER
  })
}

const deps: AutoTitleDeps = {
  settings: getAutoTitleSettings,
  chat: (id) => chatsRepo.get(id),
  provider: (id) => providersRepo.get(id),
  memory: memoryText,
  setTitle: (chatId, title) => {
    const { chat } = chatsRepo.update(chatId, { title })
    emit({ type: 'chat-updated', chat })
  },
  record: (messageId, rec) => {
    const m = messagesRepo.get(messageId)
    if (!m) return
    const updated = messagesRepo.update(m.id, m.message, { ...m.meta, autoTitle: rec })
    emit({ type: 'message-updated', message: updated })
  }
}

/**
 * Mensagem digitada pelo usuário (não de outro chat, callback, sintética…) — a mesma regra de
 * `isBranchEditable` (@shared/branches) para mensagens `user` da principal.
 */
export const isTypedFirstMessage = (meta: MessageMeta): boolean =>
  !meta.synthetic && (!meta.kind || meta.kind === 'queued' || meta.kind === 'forced')

/**
 * Runner: a 1ª mensagem digitada de um chat novo acabou de virar o título provisório. Com modelo
 * escolhido, gera o título em segundo plano (próximo tick; nunca lança). Sem modelo: nada.
 */
export function scheduleAutoTitle(job: Omit<AutoTitleJob, 'trigger'>): void {
  let enabled = false
  try {
    enabled = autoTitleEnabled(getAutoTitleSettings())
  } catch (e) {
    console.error('[clearchat] título automático (config)', e)
  }
  if (!enabled) return
  setTimeout(() => {
    runAutoTitle({ ...job, trigger: 'auto' }, deps).catch((e) =>
      console.error('[clearchat] título automático', e)
    )
  }, 0)
}

/** 1ª mensagem do usuário no caminho ativo da principal (digitada; senão qualquer prompt). */
function firstUserMessage(chat: Chat): StoredMessage | null {
  const path = chat.mainSessionId ? messagesRepo.path(chat.mainSessionId) : []
  const users = path.filter((m) => m.message.role === 'user' && m.meta.kind !== 'compaction')
  return (
    users.find((m) => isTypedFirstMessage(m.meta)) ??
    users.find((m) => !m.meta.synthetic || m.meta.kind === 'inter-chat') ??
    null
  )
}

/** Texto e nomes de anexos/skills de uma mensagem do usuário (o que vai para o modelo do título). */
export function titleSource(m: StoredMessage): { text: string; attachments: string[] } {
  const raw = m.message.role === 'user' ? contentText(m.message.content) : ''
  return {
    text: m.meta.kind === 'inter-chat' ? splitInterChatText(raw).body : raw,
    attachments: [
      ...messageAttachments(m.message).map((a) => a.name),
      ...messageSkills(m.message).map((s) => `Skill ${s.name}`)
    ]
  }
}

const inflight = new Map<string, Promise<Chat>>()

/**
 * "Gerar título" (header do chat): gera de novo a partir da 1ª mensagem e troca o título (se ele
 * não mudar enquanto isso). Erros legíveis (o usuário pediu). Local: o título sincroniza como sempre.
 */
export function generateTitleNow(chatId: string): Promise<Chat> {
  const cur = inflight.get(chatId)
  if (cur) return cur
  const p = (async (): Promise<Chat> => {
    if (!autoTitleEnabled(getAutoTitleSettings()))
      throw new Error('Escolha o “Modelo para o título” em Configurações → Novos chats.')
    const chat = chatsRepo.get(chatId)
    if (!chat) throw new Error('Chat não encontrado.')
    const first = firstUserMessage(chat)
    if (!first) throw new Error('O chat ainda não tem mensagem para dar nome.')
    const out = await runAutoTitle(
      {
        chatId,
        ...titleSource(first),
        expectTitle: chat.title,
        messageId: first.id,
        trigger: 'manual'
      },
      deps
    )
    if (out.status === 'error') throw new Error(`Não foi possível gerar o título: ${out.error}`)
    if (out.status === 'kept' && out.reason === 'renamed')
      throw new Error('O chat foi renomeado enquanto o título era gerado — mantido o seu.')
    const updated = chatsRepo.get(chatId)
    if (!updated) throw new Error('Chat não encontrado.')
    return updated
  })().finally(() => inflight.delete(chatId))
  inflight.set(chatId, p)
  return p
}
