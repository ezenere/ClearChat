// Configurações → Aprovações: modo GLOBAL por item (Sempre / Smart-Approve / Listas ou Perguntar)
// — é aqui que se define o padrão (★ na aba Tools) — e as listas
// globais (whitelist/blacklist) de comandos, processos e páginas, com busca, edição e "Testar".
import { Ban, Check, CircleHelp, CornerDownRight, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { Fragment, useState } from 'react'
import { APPROVAL_ITEM_GROUPS, evaluateLists, ITEM_LABEL, ITEM_TOOL } from '@shared/approvalPolicy'
import { analyzeShell, groupHeadings } from '@shared/shellParse'
import type { ApprovalItem, ApprovalListItem, ApprovalMode } from '@shared/types'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { C } from '../ui/Tooltip'
import { ListEntryEditor, ModeSelector } from './ApprovalControls'

const ITEM_DESC: Record<ApprovalItem, string> = {
  commands: 'Tool shell — cada comando é desmontado em sub-comandos (|, &&, ;, $(…), bash -c…).',
  processes: 'Tool process_start — mesma análise dos comandos, com listas próprias.',
  pages: 'Tool browse_url — domínio (github.com, *.github.com) ou prefixo de URL.',
  search: 'Tool web_search — sem listas: no modo “Perguntar”, cada busca pede sua confirmação.',
  writeFile: 'Tool write_file — cria ou sobrescreve arquivos.',
  editFile: 'Tool edit_file — substitui trechos de um arquivo.',
  sendToChat:
    'Tool send_to_chat — manda uma mensagem a outro chat (que pode rodar o agente de lá).',
  delegate: 'Tool delegate_task — cria um subagente (com as tools e aprovações deste chat).',
  memory_write: 'Tool memory_write — cria ou atualiza uma memória na coleção de escrita.',
  memory_rewrite:
    'Tool memory_rewrite — cria uma versão corrigida de uma memória só de leitura (a substitui).',
  memory_delete: 'Tool memory_delete — apaga uma memória de uma coleção gravável.'
}

export function ApprovalsSettings(): React.JSX.Element {
  const settings = useStore((s) => s.approvalSettings)
  const update = useStore((s) => s.updateApprovalSettings)
  const [listItem, setListItem] = useState<ApprovalListItem>('commands')
  const setMode = (item: ApprovalItem, mode: ApprovalMode): void =>
    void update({ modes: { ...settings.modes, [item]: mode } })
  return (
    <div className="space-y-5" data-testid="approvals-settings">
      <p className="text-xs leading-relaxed text-subtle">
        Modo padrão de cada item em todos os chats. Cada chat (aba Tools) e cada persona pode
        ajustar; lá a opção igual ao padrão daqui aparece com ★, e quem não ajustou segue este
        padrão. <strong className="text-fg/90">process_stop</strong> nunca pede confirmação: o
        agente só enxerga e para processos do próprio chat. As demais tools (leitura, apresentar
        arquivos, histórico, controle de subagentes, perguntas ao usuário) também nunca pedem.
      </p>
      {APPROVAL_ITEM_GROUPS.map((g) => (
        <div key={g.title} className="space-y-3">
          <div className="border-b border-border/50 pb-1 text-[11.5px] text-subtle">{g.title}</div>
          {g.items.map((item) => (
            <div key={item}>
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-fg/90">{ITEM_LABEL[item]}</span>
                <span className="font-mono text-[10.5px] text-faint">{ITEM_TOOL[item]}</span>
              </div>
              <ModeSelector
                item={item}
                value={settings.modes[item]}
                onChange={(m) => setMode(item, m)}
                label={`Modo global: ${ITEM_LABEL[item]}`}
                testId={`global-mode-${item}`}
              />
              <p className="mt-1 text-[11px] leading-snug text-subtle">{ITEM_DESC[item]}</p>
            </div>
          ))}
        </div>
      ))}
      <p className="text-[11px] leading-snug text-subtle">
        <strong className="text-fg/80">Sempre permitir</strong>: roda sem perguntar (a blacklist não
        vale). <strong className="text-fg/80">Smart-Approve</strong>: o modelo juiz escolhido no
        chat (aba Tools → Smart-Approve) aprova ou pergunta; em Comandos/Processos/Páginas ele só
        complementa as listas (blacklist bloqueia, o que a whitelist libera roda sem ele); sem
        modelo → pergunta. <strong className="text-fg/80">Listas</strong> (Comandos, Processos,
        Páginas): blacklist bloqueia (tem precedência), whitelist libera, o resto pergunta.{' '}
        <strong className="text-fg/80">Perguntar</strong> (demais itens): cada chamada pede sua
        confirmação.
      </p>

      <div className="border-t border-border pt-4">
        <div className="mb-3 flex items-center gap-1 border-b border-border">
          {(['commands', 'processes', 'pages'] as const).map((it) => (
            <button
              key={it}
              type="button"
              onClick={() => setListItem(it)}
              className={cn(
                '-mb-px border-b-2 px-2.5 pb-1.5 text-[12.5px] transition-colors',
                listItem === it
                  ? 'border-accent text-fg'
                  : 'border-transparent text-subtle hover:text-fg'
              )}
            >
              Listas · {ITEM_LABEL[it]}
            </button>
          ))}
        </div>
        <ListsEditor key={listItem} item={listItem} />
      </div>
    </div>
  )
}

function ListsEditor({ item }: { item: ApprovalListItem }): React.JSX.Element {
  const [query, setQuery] = useState('')
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar nas listas…"
          aria-label="Buscar nas listas"
          className="field h-8 pl-8 text-[12.5px]"
        />
      </div>
      <ListTable item={item} list="allow" query={query} />
      <ListTable item={item} list="deny" query={query} />
      <Tester item={item} />
    </div>
  )
}

function ListTable({
  item,
  list,
  query
}: {
  item: ApprovalListItem
  list: 'allow' | 'deny'
  query: string
}): React.JSX.Element {
  const settings = useStore((s) => s.approvalSettings)
  const update = useStore((s) => s.updateApprovalSettings)
  const entries = settings.lists[item][list]
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const q = query.trim().toLowerCase()
  const shown = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !q || e.toLowerCase().includes(q))
  const save = async (next: string[]): Promise<boolean> => {
    const ok = await update({
      lists: { ...settings.lists, [item]: { ...settings.lists[item], [list]: next } }
    })
    if (ok) setEditing(null)
    return ok
  }
  const allow = list === 'allow'
  return (
    <div data-testid={`list-${item}-${list}`}>
      <div className="mb-1 flex items-center gap-1.5">
        {allow ? (
          <Check className="size-3.5 text-success/90" />
        ) : (
          <Ban className="size-3.5 text-danger/90" />
        )}
        <span className="text-[12px] font-medium text-fg/90">
          {allow ? 'Whitelist' : 'Blacklist'}
        </span>
        <span className="text-[11px] text-faint">
          {entries.length} {entries.length === 1 ? 'entrada' : 'entradas'}
        </span>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-accent-strong hover:bg-accent-soft"
        >
          <Plus className="size-3" /> Adicionar
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {shown.length === 0 && editing !== 'new' && (
          <p className="px-3 py-2 text-[11.5px] text-faint">
            {entries.length ? 'Nada casa com a busca.' : 'Vazia.'}
          </p>
        )}
        {shown.map(({ e, i }) =>
          editing === i ? (
            <div key={i} className="border-b border-border/70 px-2 py-1.5 last:border-b-0">
              <ListEntryEditor
                item={item}
                list={list}
                initial={e}
                confirmLabel="Salvar"
                onCancel={() => setEditing(null)}
                onConfirm={(v) => void save(entries.map((x, k) => (k === i ? v : x)))}
              />
            </div>
          ) : (
            <div
              key={i}
              data-testid="list-entry"
              className="group flex h-8 items-center gap-2 border-b border-border/70 px-3 last:border-b-0 hover:bg-hover/40"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg/90">
                {e}
              </span>
              <button
                type="button"
                aria-label={`Editar ${e}`}
                onClick={() => setEditing(i)}
                className="rounded p-1 text-subtle opacity-0 group-hover:opacity-100 hover:text-fg"
              >
                <Pencil className="size-3" />
              </button>
              <button
                type="button"
                aria-label={`Remover ${e}`}
                onClick={() => void save(entries.filter((_, k) => k !== i))}
                className="rounded p-1 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          )
        )}
        {editing === 'new' && (
          <div className="px-2 py-1.5">
            <ListEntryEditor
              item={item}
              list={list}
              initial=""
              confirmLabel="Adicionar"
              onCancel={() => setEditing(null)}
              onConfirm={(v) => void save(entries.includes(v) ? entries : [...entries, v])}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** "Testar comando/URL": decomposição em sub-comandos + veredito de cada um com as listas atuais. */
function Tester({ item }: { item: ApprovalListItem }): React.JSX.Element {
  const lists = useStore((s) => s.approvalSettings.lists)
  const [text, setText] = useState('')
  const isPages = item === 'pages'
  const ev = text.trim()
    ? evaluateLists(item, isPages ? { url: text } : { command: text }, lists)
    : null
  const parseError = !isPages && text.trim() ? analyzeShell(text).error : undefined
  const heads = ev ? groupHeadings(ev.check.items) : []
  return (
    <div data-testid="approval-tester" className="rounded-lg border border-border bg-bg/30 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-fg/90">
        <CircleHelp className="size-3.5 text-subtle" />
        {isPages ? 'Testar URL' : 'Testar comando'}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={isPages ? 1 : 2}
        placeholder={isPages ? 'https://github.com/…' : 'git status && npm test | tee log.txt'}
        aria-label={isPages ? 'URL para testar' : 'Comando para testar'}
        className="field resize-y font-mono text-[11.5px]"
      />
      {ev && (
        <div className="mt-2 space-y-1">
          {parseError && (
            <p className="text-[11px] text-warning/90">Não analisável: {parseError}</p>
          )}
          {ev.blocked && (
            <p data-testid="tester-blocked" className="text-[11.5px] text-danger/90">
              Bloqueado: <C>{ev.blocked.entry}</C> casou com <C>{ev.blocked.text}</C> — nada roda.
            </p>
          )}
          {ev.check.items.map((it, i) => (
            <Fragment key={i}>
              {heads[i] && (
                <div
                  data-testid="tester-group"
                  style={{ marginLeft: `${(it.depth ?? 0) * 14}px` }}
                  className="flex items-center gap-1 pt-0.5 text-[10.5px] font-medium text-subtle"
                >
                  <CornerDownRight className="size-3 shrink-0 text-faint" />
                  {heads[i]}
                </div>
              )}
              <div
                data-testid="tester-item"
                style={{ marginLeft: `${(it.depth ?? 0) * 14}px` }}
                className="flex items-start gap-2 rounded-md bg-bg/60 px-2 py-1"
              >
                <span
                  className={cn(
                    'mt-px shrink-0 text-[10.5px] font-medium',
                    it.verdict === 'allow' ? 'text-success/90' : 'text-warning/90'
                  )}
                >
                  {it.verdict === 'allow' ? '✓ liberado' : 'pergunta'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[11.5px] break-all text-fg/90">
                    {it.text || '(vazio)'}
                  </span>
                  <span className="block text-[10.5px] text-faint">
                    {[
                      it.entry && `whitelist “${it.entry}”`,
                      it.note !== it.group && it.note,
                      it.reason && `nunca automático: ${it.reason}`,
                      it.suggestion && `sugestão: ${it.suggestion}`
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </div>
            </Fragment>
          ))}
          {!ev.blocked && (
            <p className="text-[11px] text-subtle">
              {ev.allAllowed
                ? 'Resultado: roda sem perguntar (modo Listas).'
                : 'Resultado: pede sua decisão para os itens pendentes.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
