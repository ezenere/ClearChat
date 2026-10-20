// Mock do visualizador de arquivos (VITE_CLEAR_MOCK): chat "Relatório trimestral de vendas" em que
// o assistente apresentou arquivos com present_file (md com título+descrição, png só com descrição,
// zip só com título — tipo sem prévia — e, numa 2ª chamada, txt sem nenhum dos dois) + a API
// `viewer` (bytes falsos: data URL para a imagem, textos fixos). Usado por e2e/file-viewer-ui.spec.ts.
import type {
  ChatConfig,
  Chat,
  PresentedFile,
  Session,
  StoredMessage,
  ViewerKind
} from '@shared/types'
import type { ClearApi, ViewerFile } from '@shared/ipc'
import {
  codeLanguage,
  detectViewerKind,
  fileNameOf,
  viewerMime,
  viewerTypeLabel
} from '@shared/fileViewer'

export const VIEWER_CHAT_ID = 'cpf'
export const VIEWER_SESSION_ID = 'spf'

const CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#14141a"/><g fill="#8b5cf6"><rect x="60" y="200" width="70" height="120"/><rect x="170" y="150" width="70" height="170"/><rect x="280" y="110" width="70" height="210"/><rect x="390" y="70" width="70" height="250"/></g><text x="60" y="50" fill="#e6e6ea" font-family="sans-serif" font-size="24">Vendas por trimestre</text></svg>`
const CHART_URL = `data:image/svg+xml;base64,${btoa(CHART_SVG)}`

const REPORT_MD = `# Relatório trimestral de vendas

As vendas cresceram **18%** no trimestre, puxadas pela região Sul.

| Região | T1 | T2 | Variação |
|---|---:|---:|---:|
| Sul | 1.240 | 1.610 | +30% |
| Sudeste | 3.900 | 4.300 | +10% |
| Nordeste | 870 | 950 | +9% |

## Próximos passos

- Revisar a meta do Sudeste
- Repetir a campanha do Sul no Nordeste

\`\`\`ts
const crescimento = (t2 - t1) / t1
\`\`\`
`

const NOTES_TXT =
  'Notas da reunião\n\n- dados extraídos do ERP em 30/09\n- valores em milhares de reais\n'

const SIZES: Record<string, number> = {
  'relatorio.md': REPORT_MD.length,
  'grafico-vendas.png': 48_213,
  'dados-brutos.zip': 2_481_920,
  'notas.txt': NOTES_TXT.length
}

const kindOf = (name: string): ViewerKind =>
  name.endsWith('.png') ? 'image' : detectViewerKind(name, new TextEncoder().encode('texto'))

/** Seeds do chat com present_file (chamado pelo mockApi). */
export function seedViewerScenario(o: {
  home: string
  cfg: ChatConfig
  chats: Chat[]
  sessions: Session[]
  messages: StoredMessage[]
  files: Record<string, { name: string; isDir: boolean; size: number }[]>
  msg: (
    sessionId: string,
    message: StoredMessage['message'],
    meta?: StoredMessage['meta'],
    createdAt?: number
  ) => StoredMessage
}): void {
  const root = `${o.home}/projetos/vendas`
  const now = Date.now()
  o.chats.push({
    id: VIEWER_CHAT_ID,
    title: 'Relatório trimestral de vendas',
    config: { ...o.cfg, cwd: root },
    mainSessionId: VIEWER_SESSION_ID,
    createdAt: now - 600_000,
    updatedAt: now - 30_000
  })
  o.sessions.push({
    id: VIEWER_SESSION_ID,
    chatId: VIEWER_CHAT_ID,
    parentSessionId: null,
    parentToolCallId: null,
    depth: 0,
    model: o.cfg.model,
    title: 'Principal',
    task: null,
    status: 'idle',
    createdAt: now - 600_000
  })
  o.files[root] = [
    { name: 'relatorio.md', isDir: false, size: SIZES['relatorio.md'] },
    { name: 'grafico-vendas.png', isDir: false, size: SIZES['grafico-vendas.png'] },
    { name: 'dados-brutos.zip', isDir: false, size: SIZES['dados-brutos.zip'] },
    { name: 'notas.txt', isDir: false, size: SIZES['notas.txt'] }
  ]
  const file = (name: string, extra: Partial<PresentedFile> = {}): PresentedFile => ({
    path: `${root}/${name}`,
    name,
    size: SIZES[name],
    kind: kindOf(name),
    ...extra
  })
  const first: PresentedFile[] = [
    file('relatorio.md', {
      title: 'Relatório do trimestre',
      description: 'Resumo das vendas por região, com a variação T1 → T2.'
    }),
    file('grafico-vendas.png', { description: 'Gráfico de barras das vendas por trimestre.' }),
    file('dados-brutos.zip', { title: 'Dados brutos (ERP)' })
  ]
  const args1 = {
    files: first.map((f) => ({
      path: f.name,
      ...(f.title ? { title: f.title } : {}),
      ...(f.description ? { description: f.description } : {})
    }))
  }
  o.messages.push(
    o.msg(
      VIEWER_SESSION_ID,
      { role: 'user', content: 'Gere o relatório trimestral de vendas com um gráfico.' },
      {},
      now - 120_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      {
        role: 'assistant',
        content: 'Pronto — gerei o relatório, o gráfico e o pacote com os dados brutos:',
        tool_calls: [
          {
            id: 'tpf1',
            type: 'function',
            function: { name: 'present_file', arguments: JSON.stringify(args1) }
          }
        ]
      },
      { model: o.cfg.model, usage: { promptTokens: 5200, completionTokens: 140 } },
      now - 100_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      {
        role: 'tool',
        tool_call_id: 'tpf1',
        content: 'Apresentado ao usuário: relatorio.md, grafico-vendas.png, dados-brutos.zip'
      },
      { toolStatus: 'ok', presentFiles: { files: first } },
      now - 99_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      {
        role: 'assistant',
        content: 'E as notas da reunião que usei como fonte:',
        tool_calls: [
          {
            id: 'tpf2',
            type: 'function',
            function: {
              name: 'present_file',
              arguments: JSON.stringify({ files: [{ path: 'notas.txt' }] })
            }
          }
        ]
      },
      { model: o.cfg.model, usage: { promptTokens: 5400, completionTokens: 40 } },
      now - 60_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      { role: 'tool', tool_call_id: 'tpf2', content: 'Apresentado ao usuário: notas.txt' },
      { toolStatus: 'ok', presentFiles: { files: [file('notas.txt')] } },
      now - 59_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      { role: 'assistant', content: 'Quer que eu envie o resumo por e-mail também?' },
      { model: o.cfg.model, usage: { promptTokens: 5500, completionTokens: 20 } },
      now - 58_000
    )
  )
}

/** API `viewer` do mock: concessões em memória; chamadas de SO ficam em window.__mockViewerCalls. */
export function createMockViewer(o: {
  messages: () => StoredMessage[]
  delay: <T>(v: T, ms?: number) => Promise<T>
}): ClearApi['viewer'] {
  // mensagens do mock + as que os E2E injetam por evento (só existem no store)
  const all = (): StoredMessage[] => {
    const st = (
      window as unknown as {
        __clearStore?: { getState(): { messages: Record<string, StoredMessage[]> } }
      }
    ).__clearStore?.getState()
    return [...o.messages(), ...Object.values(st?.messages ?? {}).flat()]
  }
  const tokens = new Map<string, string>()
  const calls: string[] = []
  ;(window as unknown as { __mockViewerCalls?: string[] }).__mockViewerCalls = calls
  const grant = (path: string): ViewerFile => {
    const name = fileNameOf(path)
    const token = [...path]
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
      .toString(16)
      .padStart(32, '0')
    tokens.set(token, path)
    const kind = kindOf(name)
    const language = kind === 'code' ? codeLanguage(name) : undefined
    return {
      token,
      url: kind === 'image' ? CHART_URL : `clearchat-file://${token}/${encodeURIComponent(name)}`,
      path,
      name,
      size: SIZES[name] ?? 1834,
      mtime: Date.now(),
      kind,
      mime: viewerMime(kind, name),
      ...(language ? { language } : {}),
      typeLabel:
        kind === 'binary' && name.endsWith('.zip')
          ? 'Arquivo ZIP (ou docx/xlsx/jar)'
          : viewerTypeLabel(kind, name)
    }
  }
  return {
    open: (target) => {
      if (target.source === 'browse')
        return o.delay({ ok: true as const, file: grant(target.path) })
      const f = all().find((m) => m.id === target.messageId)?.meta.presentFiles?.files[target.index]
      if (!f || f.error)
        return o.delay({
          ok: false as const,
          reason: 'invalid' as const,
          message: 'Arquivo não encontrado nesta conversa.'
        })
      return o.delay({ ok: true as const, file: grant(f.path) })
    },
    check: (_chatId, messageId) =>
      o.delay(
        (all().find((m) => m.id === messageId)?.meta.presentFiles?.files ?? []).map(() => ({
          ok: true as const
        }))
      ),
    readText: (token) => {
      const name = fileNameOf(tokens.get(token) ?? '')
      const content =
        name === 'relatorio.md'
          ? REPORT_MD
          : name === 'notas.txt'
            ? NOTES_TXT
            : `// ${name}\nexport const exemplo = 42\n`
      return o.delay({ content, truncated: false, size: content.length })
    },
    openExternal: async (token) => {
      calls.push(`open:${tokens.get(token)}`)
    },
    showInFolder: async (token) => {
      calls.push(`reveal:${tokens.get(token)}`)
    }
  }
}
