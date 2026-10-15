// SOMENTE DESENVOLVIMENTO: window.api simulado para validar o design sem backend.
// Carregado apenas quando o renderer é buildado com VITE_CLEAR_MOCK=1 (ver main.tsx).
import { DEFAULT_CHAT_CONFIG } from '@shared/defaults'
import type { ClearApi } from '@shared/ipc'
import { copyName, sanitizePresetConfig } from '@shared/presets'
import type {
  AgentEvent,
  ApprovalRequest,
  Chat,
  ModelInfo,
  Preset,
  Provider,
  QueuedMessage,
  Session,
  StoredMessage
} from '@shared/types'

const HOME = '/home/dev'
const now = Date.now()
let seq = 0
const id = (p: string): string => `${p}-${++seq}`

export function createMockApi(scenario: string): ClearApi {
  const listeners = new Set<(e: AgentEvent) => void>()
  const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))

  const providers: Provider[] =
    scenario === 'onboarding'
      ? []
      : [
          {
            id: 'p1',
            name: 'OpenRouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'sk-or-v1-9f8e7d6c5b4a3f2e1d0c',
            headers: {},
            createdAt: now
          },
          {
            id: 'p2',
            name: 'Local (LM Studio)',
            baseUrl: 'http://localhost:1234/v1',
            apiKey: '',
            headers: {},
            createdAt: now
          }
        ]

  const models: ModelInfo[] = [
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Anthropic: Claude Sonnet 4.5',
      contextLength: 1_000_000,
      promptPrice: 0.000003,
      completionPrice: 0.000015,
      supportsTools: true
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      name: 'Anthropic: Claude Haiku 4.5',
      contextLength: 200_000,
      promptPrice: 0.000001,
      completionPrice: 0.000005
    },
    {
      id: 'openai/gpt-5',
      name: 'OpenAI: GPT-5',
      contextLength: 400_000,
      promptPrice: 0.00000125,
      completionPrice: 0.00001
    },
    {
      id: 'openai/gpt-5-mini',
      name: 'OpenAI: GPT-5 Mini',
      contextLength: 400_000,
      promptPrice: 0.00000025,
      completionPrice: 0.000002
    },
    {
      id: 'google/gemini-2.5-pro',
      name: 'Google: Gemini 2.5 Pro',
      contextLength: 1_048_576,
      promptPrice: 0.00000125,
      completionPrice: 0.00001
    },
    {
      id: 'deepseek/deepseek-chat-v3.1:free',
      name: 'DeepSeek: V3.1 (free)',
      contextLength: 163_840,
      promptPrice: 0,
      completionPrice: 0
    },
    {
      id: 'qwen/qwen3-coder',
      name: 'Qwen: Qwen3 Coder',
      contextLength: 262_144,
      promptPrice: 0.00000022,
      completionPrice: 0.00000095
    },
    {
      id: 'meta-llama/llama-4-maverick',
      name: 'Meta: Llama 4 Maverick',
      contextLength: 1_048_576,
      promptPrice: 0.00000015,
      completionPrice: 0.0000006
    }
  ]

  const cfg = DEFAULT_CHAT_CONFIG(`${HOME}/projetos/clearchat`, {
    providerId: 'p1',
    model: 'anthropic/claude-sonnet-4.5',
    baseUrl: 'https://openrouter.ai/api/v1'
  })
  cfg.params = { temperature: 0.7 }
  cfg.autoApprove = ['web_search', 'browse_url']

  const chats: Chat[] =
    scenario === 'onboarding'
      ? []
      : [
          {
            id: 'c1',
            title: 'Refatorar o parser de SSE',
            config: cfg,
            mainSessionId: 's1',
            createdAt: now - 3_600_000,
            updatedAt: now - 60_000
          },
          {
            id: 'c2',
            title: 'Ideias de nomes para o app',
            config: { ...cfg, model: 'openai/gpt-5' },
            mainSessionId: 's2',
            createdAt: now - 86_400_000,
            updatedAt: now - 7_200_000
          },
          {
            id: 'c3',
            title: 'Resumo do artigo sobre CRDTs',
            config: cfg,
            mainSessionId: 's3',
            createdAt: now - 3 * 86_400_000,
            updatedAt: now - 2 * 86_400_000
          },
          {
            id: 'c4',
            title: 'Script de backup com rsync',
            config: cfg,
            mainSessionId: 's4',
            createdAt: now - 6 * 86_400_000,
            updatedAt: now - 5 * 86_400_000
          }
        ]

  const sessions: Session[] = [
    {
      id: 's1',
      chatId: 'c1',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'awaiting_approval',
      createdAt: now - 3_600_000
    },
    {
      id: 's1a',
      chatId: 'c1',
      parentSessionId: 's1',
      parentToolCallId: 'tc3',
      depth: 1,
      model: 'anthropic/claude-haiku-4.5',
      title: 'Mapear usos do parser',
      task: 'Encontre todos os lugares em src/ que chamam parseSSE e liste arquivo:linha com um resumo de como o retorno é usado.',
      status: 'done',
      createdAt: now - 1_800_000
    },
    {
      id: 's2',
      chatId: 'c2',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: 'openai/gpt-5',
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: now
    },
    {
      id: 's3',
      chatId: 'c3',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: now
    },
    {
      id: 's4',
      chatId: 'c4',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: now
    }
  ]

  const msg = (
    sessionId: string,
    message: StoredMessage['message'],
    meta: StoredMessage['meta'] = {}
  ): StoredMessage => ({
    id: id('m'),
    sessionId,
    seq: ++seq,
    message,
    meta,
    createdAt: now
  })

  const messages: StoredMessage[] = [
    msg('s1', {
      role: 'user',
      content:
        'O parser de SSE em `src/main/agent/llm.ts` está engolindo a última linha quando o stream termina sem `\\n`. Pode investigar e corrigir?'
    }),
    msg(
      's1',
      {
        role: 'assistant',
        content: 'Vou dar uma olhada no arquivo primeiro.',
        reasoning:
          'O usuário relata perda da última linha. Provavelmente o buffer não é processado no final do stream. Preciso ler o arquivo.',
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"src/main/agent/llm.ts","offset":40,"limit":60}'
            }
          }
        ]
      },
      {
        usage: { promptTokens: 4210, completionTokens: 96, cachedTokens: 3890, cost: 0.0021 },
        model: cfg.model,
        durationMs: 2300
      }
    ),
    msg(
      's1',
      {
        role: 'tool',
        tool_call_id: 'tc1',
        content:
          '40\tfor await (const chunk of res.body) {\n41\t  buffer += decoder.decode(chunk, { stream: true })\n42\t  const lines = buffer.split("\\n")\n43\t  buffer = lines.pop() ?? ""\n44\t  for (const line of lines) handleLine(line)\n45\t}\n46\t// fim do stream\n47\treturn finish()'
      },
      { toolStatus: 'ok' }
    ),
    msg(
      's1',
      {
        role: 'assistant',
        content:
          "Encontrei o problema: quando o loop termina, o que sobrou em `buffer` nunca é processado. A correção é simples:\n\n```ts\nfor await (const chunk of res.body) {\n  buffer += decoder.decode(chunk, { stream: true })\n  const lines = buffer.split('\\n')\n  buffer = lines.pop() ?? ''\n  for (const line of lines) handleLine(line)\n}\n// processa o resto do buffer\nbuffer += decoder.decode()\nif (buffer.trim()) handleLine(buffer)\nreturn finish()\n```\n\nAntes de aplicar, vou delegar a um subagente o mapeamento dos outros usos do parser e rodar os testes.",
        tool_calls: [
          {
            id: 'tc3',
            type: 'function',
            function: {
              name: 'delegate_task',
              arguments:
                '{"title":"Mapear usos do parser","task":"Encontre todos os lugares em src/ que chamam parseSSE e liste arquivo:linha com um resumo de como o retorno é usado.","model":"anthropic/claude-haiku-4.5"}'
            }
          },
          {
            id: 'tc2',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"npm test -- --run src/main/agent"}' }
          }
        ]
      },
      {
        usage: {
          promptTokens: 4720,
          completionTokens: 312,
          cachedTokens: 4210,
          reasoningTokens: 0,
          cost: 0.0049
        },
        model: cfg.model,
        durationMs: 5100
      }
    ),
    msg(
      's1',
      {
        role: 'tool',
        tool_call_id: 'tc3',
        content:
          'Encontrei 2 usos:\n- src/main/agent/runner.ts:88 — consome eventos delta e acumula tool_calls\n- src/main/agent/preview.ts:12 — apenas tipagem'
      },
      { toolStatus: 'ok', subSessionId: 's1a' }
    ),
    msg('s1a', {
      role: 'user',
      content:
        'Encontre todos os lugares em src/ que chamam parseSSE e liste arquivo:linha com um resumo de como o retorno é usado.'
    }),
    msg(
      's1a',
      {
        role: 'assistant',
        content:
          'Encontrei 2 usos:\n- `src/main/agent/runner.ts:88` — consome eventos delta e acumula tool_calls\n- `src/main/agent/preview.ts:12` — apenas tipagem'
      },
      { usage: { promptTokens: 1200, completionTokens: 80 }, model: 'anthropic/claude-haiku-4.5' }
    )
  ]

  const approvals: ApprovalRequest[] =
    scenario === 'onboarding'
      ? []
      : [
          {
            id: 'a1',
            chatId: 'c1',
            sessionId: 's1',
            toolCallId: 'tc2',
            toolName: 'bash',
            args: { command: 'npm test -- --run src/main/agent' },
            createdAt: now
          },
          {
            id: 'a2',
            chatId: 'c4',
            sessionId: 's4',
            toolCallId: 'tcx',
            toolName: 'web_search',
            args: { query: 'rsync --link-dest exemplo' },
            createdAt: now
          }
        ]
  const queues: Record<string, QueuedMessage[]> = {
    s1: [
      {
        id: 'q1',
        sessionId: 's1',
        text: 'Depois adiciona um teste cobrindo stream sem \\n no final, por favor.',
        createdAt: now
      }
    ]
  }
  const presets: Preset[] = [
    {
      id: 'pr1',
      name: 'Padrão',
      description: 'Configuração padrão do app (Configurações → Novos chats).',
      icon: 'sparkles',
      config: {},
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'pr2',
      name: 'Revisor de código',
      description: 'Lê o projeto e aponta bugs, sem editar arquivos.',
      icon: '🧐',
      config: {
        model: 'openai/gpt-4.1',
        systemPrompt: 'Você é um revisor de código rigoroso. Aponte bugs e riscos.',
        enabledTools: ['list_dir', 'read_file', 'search_files', 'find_files']
      },
      createdAt: now,
      updatedAt: now
    }
  ]
  const settings: Record<string, unknown> = {
    defaultProviderId: 'p1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    defaultPresetId: 'pr1'
  }

  const files: Record<string, { name: string; isDir: boolean; size: number }[]> = {
    [`${HOME}/projetos/clearchat`]: [
      { name: 'src', isDir: true, size: 0 },
      { name: 'node_modules', isDir: true, size: 0 },
      { name: 'resources', isDir: true, size: 0 },
      { name: '.gitignore', isDir: false, size: 106 },
      { name: 'package.json', isDir: false, size: 2223 },
      { name: 'README.md', isDir: false, size: 2300 },
      { name: 'SPEC.md', isDir: false, size: 20903 },
      { name: 'tsconfig.json', isDir: false, size: 107 },
      { name: 'electron.vite.config.ts', isDir: false, size: 967 }
    ]
  }

  const delay = <T>(v: T, ms = 60): Promise<T> =>
    new Promise((r) => setTimeout(() => r(structuredClone(v)), ms))

  return {
    providers: {
      list: () => delay(providers),
      create: async (p) => {
        const np = { ...p, id: id('p'), createdAt: Date.now() }
        providers.push(np)
        return delay(np)
      },
      update: async (pid, patch) => {
        const p = providers.find((x) => x.id === pid)!
        Object.assign(p, patch)
        return delay(p)
      },
      delete: async (pid) => {
        providers.splice(
          providers.findIndex((x) => x.id === pid),
          1
        )
      },
      listModels: () => delay(models, 300),
      test: () => delay({ ok: true, modelCount: 342 }, 600)
    },
    settings: {
      get: <T>(k: string) => delay((settings[k] ?? null) as T | null),
      set: async (k, v) => {
        settings[k] = v
      }
    },
    chats: {
      list: () => delay(chats),
      get: (cid) => delay(chats.find((c) => c.id === cid) ?? null),
      create: async (input) => {
        const sid = id('s')
        const chat: Chat = {
          id: id('c'),
          title: input.title ?? 'Novo chat',
          config: { ...DEFAULT_CHAT_CONFIG(HOME), ...input.config },
          mainSessionId: sid,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        chats.unshift(chat)
        sessions.push({
          id: sid,
          chatId: chat.id,
          parentSessionId: null,
          parentToolCallId: null,
          depth: 0,
          model: chat.config.model,
          title: 'Principal',
          task: null,
          status: 'idle',
          createdAt: Date.now()
        })
        return delay(chat)
      },
      update: async (cid, patch) => {
        const c = chats.find((x) => x.id === cid)!
        if (patch.title) c.title = patch.title
        if (patch.config) c.config = { ...c.config, ...patch.config }
        return delay(c)
      },
      delete: async (cid) => {
        chats.splice(
          chats.findIndex((x) => x.id === cid),
          1
        )
      }
    },
    sessions: {
      list: (cid) => delay(sessions.filter((s) => s.chatId === cid)),
      messages: (sid) => delay(messages.filter((m) => m.sessionId === sid))
    },
    messages: {
      update: async (mid, m) => {
        const sm = messages.find((x) => x.id === mid)!
        sm.message = m
        emit({ type: 'message-updated', message: sm })
        return delay(sm)
      },
      delete: async (mid) => {
        const i = messages.findIndex((x) => x.id === mid)
        const [sm] = messages.splice(i, 1)
        emit({ type: 'message-deleted', sessionId: sm.sessionId, messageId: mid })
      }
    },
    agent: {
      send: async (sid, text, atts) => {
        const m = msg(sid, {
          role: 'user',
          content: atts?.length
            ? [
                ...atts.map((a) => ({
                  type: 'image_url' as const,
                  image_url: { url: `clearchat-attachment://${a.file}` },
                  _attachment: a
                })),
                { type: 'text' as const, text }
              ]
            : text
        })
        messages.push(m)
        emit({ type: 'message-added', message: m })
        return { queued: false }
      },
      forceSend: async () => {},
      removeQueued: async (qid) => {
        for (const k of Object.keys(queues)) {
          queues[k] = queues[k].filter((q) => q.id !== qid)
          emit({ type: 'queue-updated', sessionId: k, queue: queues[k] })
        }
      },
      getQueue: (sid) => delay(queues[sid] ?? []),
      stop: async () => {},
      regenerate: async () => {},
      approve: async (rid) => {
        emit({ type: 'approval-resolved', id: rid })
      },
      pendingApprovals: () => delay(approvals),
      previewRequest: async (sid) => {
        const s = sessions.find((x) => x.id === sid)!
        const c = chats.find((x) => x.id === s.chatId)!
        const sys = `${c.config.systemPrompt}\n\n<environment>\nroot: ${c.config.cwd}\nos: linux (Arch Linux)\nshell: bash\n</environment>`
        return delay({
          url: 'https://openrouter.ai/api/v1/chat/completions',
          headers: {
            Authorization: 'Bearer sk-or-v1-9f8e…0c',
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://clearchat.app',
            'X-Title': 'ClearChat'
          },
          body: {
            model: c.config.model,
            messages: [
              {
                role: 'system',
                content: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }]
              },
              ...messages.filter((m) => m.sessionId === sid).map((m) => m.message)
            ],
            stream: true,
            stream_options: { include_usage: true },
            tools: ['list_dir', 'read_file'].map((n) => ({
              type: 'function',
              function: { name: n }
            })),
            ...Object.fromEntries(
              Object.entries(c.config.params).filter(([k]) => k !== 'extraBody')
            ),
            usage: { include: true }
          }
        })
      },
      runningSessions: () => delay([]),
      compact: () => delay({ scheduled: false })
    },
    fs: {
      listDir: (p) =>
        delay(
          (
            files[p] ?? [
              { name: 'index.ts', isDir: false, size: 1834 },
              { name: 'utils', isDir: true, size: 0 }
            ]
          ).map((f) => ({ ...f, path: `${p}/${f.name}`, mtime: now }))
        ),
      readFile: (p) =>
        delay({
          content: p.endsWith('.json')
            ? '{\n  "name": "clearchat",\n  "version": "0.1.0",\n  "main": "./out/main/index.js"\n}\n'
            : '# ClearChat\n\nChat desktop minimalista (Electron + React + TypeScript + Tailwind v4)\npara qualquer endpoint OpenAI-compatible.\n',
          truncated: false,
          binary: false
        }),
      pickDirectory: () => delay(`${HOME}/projetos/outro`),
      homeDir: () => delay(HOME),
      mkdir: (p) => delay(p)
    },
    app: {
      capabilities: () => delay({ bwrap: true, ripgrep: true })
    },
    presets: {
      list: () => delay(presets),
      create: async (input) => {
        const p: Preset = {
          id: id('pr'),
          name: input.name || 'Persona',
          description: input.description ?? '',
          icon: input.icon ?? '',
          config: sanitizePresetConfig(input.config),
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        presets.push(p)
        return delay(p)
      },
      update: async (pid, patch) => {
        const p = presets.find((x) => x.id === pid)!
        Object.assign(p, patch, patch.config ? { config: sanitizePresetConfig(patch.config) } : {})
        p.updatedAt = Date.now()
        return delay(p)
      },
      delete: async (pid) => {
        presets.splice(
          presets.findIndex((x) => x.id === pid),
          1
        )
        if (settings.defaultPresetId === pid) delete settings.defaultPresetId
      },
      duplicate: async (pid) => {
        const src = presets.find((x) => x.id === pid)!
        const p = { ...structuredClone(src), id: id('pr'), name: copyName(src.name, presets) }
        presets.push(p)
        return delay(p)
      }
    },
    attachments: {
      pick: () =>
        delay({
          items: [
            {
              sha256: 'a'.repeat(64),
              name: 'diagrama.png',
              mime: 'image/png',
              size: 48_213,
              kind: 'image' as const,
              file: `${'a'.repeat(64)}.png`
            }
          ],
          errors: []
        }),
      add: (input) =>
        delay({
          sha256: 'b'.repeat(64),
          name: input.name,
          mime: input.mime || 'application/octet-stream',
          size: input.data.byteLength,
          kind: 'text' as const,
          file: `${'b'.repeat(64)}.txt`
        })
    },
    onEvent: (cb) => {
      listeners.add(cb)
      if (scenario === 'reasoning') {
        // Raciocínio longo: uma resposta já salva + um segundo turno ainda "pensando".
        const s2 = sessions.find((x) => x.id === 's2')!
        const u1 = msg('s2', {
          role: 'user',
          content: 'Qual a melhor forma de paginar uma lista enorme no SQLite?'
        })
        const a1 = msg(
          's2',
          {
            role: 'assistant',
            content:
              'Use **keyset pagination** (`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 50`) com um índice composto — o custo por página fica constante, ao contrário de `OFFSET`.',
            reasoning: LONG_REASONING
          },
          {
            usage: {
              promptTokens: 812,
              completionTokens: 1460,
              reasoningTokens: 1210,
              cost: 0.0042
            },
            model: 'openai/gpt-5',
            durationMs: 18_400
          }
        )
        const u2 = msg('s2', {
          role: 'user',
          content: 'E se a ordenação puder mudar (por título, por data…)?'
        })
        messages.push(u1, a1)
        let i = 0
        setTimeout(() => {
          s2.status = 'running'
          emit({ type: 'session-updated', session: { ...s2 } })
          emit({ type: 'message-added', message: a1 })
          emit({ type: 'message-added', message: u2 })
          const t = setInterval(() => {
            i = Math.min(LONG_REASONING.length, i + 6)
            emit({
              type: 'draft',
              sessionId: 's2',
              draft: { reasoning: LONG_REASONING.slice(0, i), content: '', toolCalls: [] }
            })
            if (i >= LONG_REASONING.length) clearInterval(t)
          }, 30)
        }, 200)
      }
      if (scenario === 'stream') {
        const s2 = sessions.find((x) => x.id === 's2')!
        const um = msg('s2', {
          role: 'user',
          content:
            'Me dá 3 ideias de nome curtas para um app de chat minimalista, com uma frase de justificativa cada.'
        })
        messages.push(um)
        const full =
          'Aqui vão três opções:\n\n1. **Lumen** — sugere clareza e leveza, combina com uma interface limpa.\n2. **Quill** — remete à escrita, curto e fácil de lembrar.\n3. **Hush** — transmite calma e foco, sem ruído visual.'
        let i = 0
        setTimeout(() => {
          s2.status = 'running'
          emit({ type: 'session-updated', session: { ...s2 } })
          emit({ type: 'message-added', message: um })
          const t = setInterval(() => {
            i = Math.min(full.length, i + 9)
            emit({
              type: 'draft',
              sessionId: 's2',
              draft: {
                reasoning:
                  'O usuário quer nomes curtos e evocativos. Vou priorizar palavras de uma ou duas sílabas.',
                content: full.slice(0, i),
                toolCalls: []
              }
            })
            if (i >= full.length * 0.7) clearInterval(t)
          }, 40)
        }, 200)
      }
      if (scenario === 'markdown') {
        // Markdown difícil: cercas aninhadas, LaTeX em todos os delimitadores, preços; e um
        // rascunho em streaming parado no meio de um bloco aninhado e de uma fórmula.
        const s2 = sessions.find((x) => x.id === 's2')!
        const um = msg('s2', { role: 'user', content: 'Mostra um README e umas fórmulas.' })
        const am = msg('s2', { role: 'assistant', content: MARKDOWN_SAMPLE }, { model: cfg.model })
        const u2 = msg('s2', { role: 'user', content: 'E em streaming?' })
        messages.push(um, am, u2)
        setTimeout(() => {
          s2.status = 'running'
          emit({ type: 'session-updated', session: { ...s2 } })
          emit({
            type: 'draft',
            sessionId: 's2',
            draft: { reasoning: '', content: MARKDOWN_STREAM, toolCalls: [] }
          })
        }, 200)
      }
      return () => listeners.delete(cb)
    }
  }
}

const LONG_REASONING = `O usuário quer paginar uma lista grande no SQLite. A resposta óbvia é LIMIT/OFFSET, mas OFFSET fica linear: para pular 100 mil linhas o SQLite precisa percorrer 100 mil linhas do índice antes de devolver a primeira. Em listas que crescem, a página 2000 vira um gargalo.

Alternativa: keyset pagination (seek method). Guardo a última chave vista (created_at, id) e peço "as próximas 50 depois desta chave". Com um índice composto em (created_at DESC, id DESC) isso vira um range scan que começa exatamente no ponto certo — custo constante por página.

Detalhes que importam:
- O desempate por id é obrigatório; created_at sozinho não é único e linhas com o mesmo timestamp seriam puladas ou repetidas.
- A comparação de tupla (created_at, id) < (?, ?) é suportada pelo SQLite desde a 3.15 (row values). Em versões antigas, expandir para created_at < ? OR (created_at = ? AND id < ?).
- Conferir com EXPLAIN QUERY PLAN que aparece "SEARCH ... USING INDEX" e não "SCAN".
- Para "voltar uma página", inverter a comparação e a ordem, e depois reverter o resultado no cliente.
- Contar o total (COUNT(*)) continua caro; melhor mostrar "carregar mais" do que números de página.

Também vale lembrar do WAL: leituras longas não bloqueiam escritas, então paginar durante inserções é seguro, mas a página pode "andar" se linhas novas entrarem antes do cursor — com keyset isso não duplica itens, ao contrário do OFFSET, que repete o último item quando algo é inserido no topo.

Se a ordenação for por uma coluna não única (título, por exemplo), o mesmo princípio vale: chave composta (title, id) e um índice correspondente. Se o usuário puder escolher a ordenação livremente, um índice por ordenação suportada; colunas sem índice ficam com OFFSET mesmo, mas limitadas.

Resposta final: recomendar keyset com índice composto, mostrar a query, mencionar o desempate e o EXPLAIN QUERY PLAN. Manter curto.`

const MARKDOWN_SAMPLE = [
  'Aqui está o README:',
  '',
  '```markdown',
  '# Projeto',
  '',
  '## Instalação',
  '',
  '```bash',
  'npm install',
  '```',
  '',
  '## Uso',
  '',
  '```',
  'npm start',
  '```',
  '```',
  '',
  'A energia é \\(E = mc^2\\) e a média é $\\bar{x} = \\frac{1}{n}\\sum_i x_i$. O plano custa $5 e o extra $10.',
  '',
  '\\[',
  '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
  '\\]',
  '',
  '$$',
  'f(x) = \\sum_{k=0}^{\\infty} \\frac{f^{(k)}(a)}{k!}(x-a)^k + \\underbrace{a_0 + a_1 x + a_2 x^2 + a_3 x^3 + a_4 x^4 + a_5 x^5 + a_6 x^6 + a_7 x^7 + a_8 x^8}_{\\text{bem larga}}',
  '$$',
  '',
  '- Em lista: \\(\\alpha + \\beta\\)',
  '  \\[ \\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\varepsilon_0} \\]',
  '- TeX inválido: $\\frac{1}{$ e \\(\\badcommand{x}\\)',
  '',
  'Código inline fica intacto: `\\(x\\)` e `$5`.'
].join('\n')

const MARKDOWN_STREAM = [
  'Claro:',
  '',
  '```markdown',
  '# Outro',
  '',
  '```python',
  'print("oi")',
  '```',
  '```',
  '',
  'Fórmula:',
  '',
  '\\[',
  '\\frac{a}{b'
].join('\n')
