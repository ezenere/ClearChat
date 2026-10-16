/* eslint-disable @typescript-eslint/no-explicit-any */
// Testes unitários (sem Electron): processos em segundo plano (process_*), shell do usuário
// (escolha, env -ilc, descrição da tool) e a migração bash → shell.
// Rodar: npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  _resetProcesses,
  gcProcessLogs,
  killAllProcesses,
  listProcesses,
  processList,
  processLogs,
  processStart,
  processStop,
  setProcessListener,
  setProcessLogDir,
  stopChatProcesses
} from '../src/main/tools/processes.ts'
import {
  _setShell,
  _setUserEnv,
  ENV_MARKER,
  ENV_SCRIPT,
  parseEnvOutput,
  parseShellVersion,
  pickShell,
  resolveUserEnv,
  shellLabel
} from '../src/main/tools/shellEnv.ts'
import { shell } from '../src/main/tools/bash.ts'
import { setToolShellInfo, shellDescriptionPrefix } from '../src/shared/shellInfo.ts'
import { TOOL_DEFINITIONS, shellToolDefinition, toolDefinitionFor } from '../src/shared/tools.ts'
import { migrateToolShellRename, TOOL_SHELL_RENAME_FLAG } from '../src/main/migrateTools.ts'
import { migrateConfigTools } from '../src/shared/toolRename.ts'
import { sanitizePresetConfig } from '../src/shared/presets.ts'
import { LIMITS } from '../src/shared/limits.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-proc-'))
const ROOT = join(TMP, 'root')
const OUTSIDE = join(TMP, 'outside')
const LOGS = join(TMP, 'logs')
mkdirSync(join(ROOT, 'sub'), { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })

before(() => {
  setProcessLogDir(LOGS)
  // testes rápidos e determinísticos: bash sem resolver o env do usuário
  _setShell({ path: '/bin/bash', name: 'bash' })
  _setUserEnv({ env: null, error: 'teste', durationMs: 0 })
})
after(() => {
  killAllProcesses(0)
  rmSync(TMP, { recursive: true, force: true })
})

let chatSeq = 0
const ctl = (over: Record<string, unknown> = {}): any => ({
  cwd: ROOT,
  confine: true,
  chatId: `chat${++chatSeq}`,
  sessionId: 's1',
  signal: new AbortController().signal,
  ...over
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ======================= process_* =======================

test('process_start: wait_for casa, processo segue rodando; process_list/logs/stop', async () => {
  const c = ctl()
  const r = await processStart(
    {
      command:
        'echo iniciando; sleep 0.3; echo "Listening on 1234"; while true; do echo tick; sleep 0.1; done',
      name: 'srv',
      wait_for: 'Listening on \\d+',
      timeout_s: 10
    },
    c
  )
  assert.equal(r.status, 'ok', r.content)
  assert.match(r.content, /^\[wait_for casou em .*: Listening on 1234\]/)
  assert.match(r.content, /processo p1 "srv" · rodando/)
  assert.match(r.content, /log completo: .*\.log/)
  const list = listProcesses(c.chatId)
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'running')
  await sleep(400)
  const l = await processList({}, c)
  assert.match(l.content, /\[1 processo\(s\); 1 rodando\]/)
  assert.match(l.content, /p1 "srv" · rodando há/)
  const logs = await processLogs({ id: 'p1', tail: 3 }, c)
  assert.match(logs.content, /\n\d+\ttick\n\d+\ttick\n\d+\ttick\n/)
  const s = await processStop({ id: 'p1' }, c)
  assert.match(s.content, /Processo p1 "srv" parado: encerrado/)
  assert.equal(listProcesses(c.chatId)[0].status, 'exited')
  // arquivo de log completo
  const file = listProcesses(c.chatId)[0].logFile
  assert.ok(existsSync(file))
  assert.match(readFileSync(file, 'utf8'), /^iniciando\nListening on 1234\ntick\n/)
})

test('process_start: processo que sai antes do wait_for → erro com exit code e fim do log', async () => {
  const c = ctl()
  const r = await processStart(
    { command: 'echo "erro: porta ocupada" >&2; exit 3', wait_for: 'ready', timeout_s: 10 },
    c
  )
  assert.equal(r.status, 'error')
  assert.match(r.content, /^Erro: o processo p1 saiu antes de casar o wait_for \(exit code 3\)/)
  assert.match(r.content, /--- fim do log ---\n1\terro: porta ocupada/)
  // sem wait_for e saída 0 logo de cara: ok, mas avisa que saiu
  const r2 = await processStart({ command: 'echo pronto' }, c)
  assert.equal(r2.status, 'ok')
  assert.match(r2.content, /saiu logo após iniciar \(exit code 0\)/)
})

test('process_start: timeout do wait_for mantém o processo vivo; abort só para a espera', async () => {
  const c = ctl()
  const r = await processStart({ command: 'echo a; sleep 30', wait_for: 'nunca', timeout_s: 1 }, c)
  assert.equal(r.status, 'ok')
  assert.match(r.content, /wait_for não casou em 1 s — o processo CONTINUA rodando/)
  assert.equal(listProcesses(c.chatId)[0].status, 'running')
  // abort durante a espera
  const ac = new AbortController()
  const p = processStart(
    { command: 'sleep 30', wait_for: 'nunca', timeout_s: 30 },
    { ...c, signal: ac.signal }
  )
  setTimeout(() => ac.abort(), 300)
  const r2 = await p
  assert.match(r2.content, /espera interrompida — o processo CONTINUA rodando/)
  assert.equal(listProcesses(c.chatId)[1].status, 'running')
  await stopChatProcesses(c.chatId)
  assert.equal(listProcesses(c.chatId).length, 0)
})

test('process_logs: tail, pattern (case_insensitive), since_line, offset/limit', async () => {
  const c = ctl()
  await processStart(
    {
      command: 'for i in $(seq 1 50); do echo "linha $i"; done; echo FIM; sleep 30',
      wait_for: '^FIM$'
    },
    c
  )
  const t = await processLogs({ id: 'p1', tail: 2 }, c)
  assert.match(t.content, /rodando .*· 51 linhas\]/)
  assert.match(t.content, /\n50\tlinha 50\n51\tFIM\n\[próximo: since_line=51/)
  const pat = await processLogs({ id: 'p1', pattern: 'LINHA 4\\d', case_insensitive: true }, c)
  assert.equal((pat.content.match(/\tlinha 4\d/g) ?? []).length, 10)
  const noCi = await processLogs({ id: 'p1', pattern: 'LINHA' }, c)
  assert.match(noCi.content, /nenhuma linha casa/)
  const since = await processLogs({ id: 'p1', since_line: 48, limit: 2 }, c)
  assert.match(
    since.content,
    /\n49\tlinha 49\n50\tlinha 50\n\[há mais — continue com since_line=50\]/
  )
  const none = await processLogs({ id: 'p1', since_line: 51 }, c)
  assert.match(none.content, /nenhuma linha nova depois da linha 51/)
  const off = await processLogs({ id: 'p1', offset: 1, limit: 1 }, c)
  assert.match(off.content, /\n1\tlinha 1\n/)
  const bad = await processLogs({ id: 'p9' }, c).catch((e) => e)
  assert.match(String(bad.message ?? bad.content), /não encontrado/)
  await stopChatProcesses(c.chatId)
})

test('process_logs: buffer circular descarta o começo e avisa; ANSI removido', async () => {
  const c = ctl()
  const n = LIMITS.processBufferLines + 3000
  await processStart(
    {
      command: `printf '\\033[31mvermelho\\033[0m\\n'; seq 1 ${n}; echo FIM; sleep 30`,
      wait_for: '^FIM$',
      timeout_s: 20
    },
    c
  )
  const r = await processLogs({ id: 'p1', tail: 1 }, c)
  assert.match(
    r.content,
    /a memória guarda as linhas [\d.]+–[\d.]+; as [\d.]+ primeiras só no arquivo/
  )
  const file = listProcesses(c.chatId)[0].logFile
  assert.match(readFileSync(file, 'utf8'), /^vermelho\n1\n2\n/)
  await stopChatProcesses(c.chatId)
})

test('process_stop: mata o grupo inteiro (filhos em segundo plano inclusos)', async () => {
  const c = ctl()
  const tag = `clear_stop_${process.pid}_${Date.now()}`
  await processStart({ command: `sleep 301 & sleep 302 & exec -a ${tag} sleep 303`, name: tag }, c)
  await sleep(300)
  const pid = listProcesses(c.chatId)[0].pid!
  const kids = execFileSync('pgrep', ['-g', String(pid)], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  assert.ok(kids.length >= 3, `grupo com ${kids.length}`)
  const r = await processStop({ id: 'p1' }, c)
  assert.equal(r.status, 'ok')
  await sleep(200)
  let left: string[]
  try {
    left = execFileSync('pgrep', ['-g', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    left = []
  }
  assert.deepEqual(left, [], 'nenhum processo do grupo sobra')
  // já parado
  const again = await processStop({ id: 'p1' }, c)
  assert.match(again.content, /já tinha encerrado/)
  assert.equal((await processStop({ id: 'p1', signal: 'SIGHUP' }, c)).status, 'error')
})

test('killAllProcesses: mata todos os grupos de todos os chats (síncrono)', async () => {
  const a = ctl()
  const b = { ...ctl(), chatId: 'outro-chat' }
  await processStart({ command: 'sleep 311 & sleep 312' }, a)
  await processStart({ command: "trap '' TERM; sleep 313" }, b) // ignora SIGTERM → SIGKILL
  const pids = [listProcesses(a.chatId)[0].pid!, listProcesses(b.chatId)[0].pid!]
  const n = killAllProcesses(300)
  assert.ok(n >= 2)
  await sleep(100)
  for (const pid of pids) {
    assert.throws(() => process.kill(-pid, 0), 'grupo morto')
  }
  await sleep(300)
  assert.equal(listProcesses(a.chatId)[0].status, 'exited')
})

test('limite por chat e escopo por chat', async () => {
  const c = ctl()
  for (let i = 0; i < LIMITS.processMaxPerChat; i++) {
    const r = await processStart({ command: 'echo ok; sleep 30', name: `s${i}`, wait_for: 'ok' }, c)
    assert.equal(r.status, 'ok', r.content)
  }
  const over = await processStart({ command: 'sleep 30' }, c)
  assert.equal(over.status, 'error')
  assert.match(over.content, /limite de 8 processos rodando neste chat atingido/)
  // outro chat não vê nem é limitado
  const other = ctl()
  assert.match((await processList({}, other)).content, /Nenhum processo/)
  // subagente (outra sessão, mesmo chat) vê os processos
  const sub = await processList({}, { ...c, sessionId: 's2' })
  assert.match(sub.content, /\(outra sessão\)/)
  await processStop({ id: 'p1' }, c)
  assert.equal((await processStart({ command: 'sleep 30' }, c)).status, 'ok')
  await stopChatProcesses(c.chatId)
})

test('cwd: relativo ao raiz, padrão = diretório do shell da sessão, confinamento', async () => {
  const c = ctl()
  const r = await processStart({ command: 'pwd', cwd: 'sub' }, c)
  assert.match(r.content, new RegExp(`1\\t${join(ROOT, 'sub')}`))
  const r2 = await processStart(
    { command: 'pwd' },
    { ...c, shell: { root: ROOT, dir: join(ROOT, 'sub') } }
  )
  assert.match(r2.content, new RegExp(`cwd: ${join(ROOT, 'sub')}`))
  await assert.rejects(processStart({ command: 'pwd', cwd: OUTSIDE }, c), /fora do diretório raiz/)
  await assert.rejects(
    processStart({ command: 'pwd', cwd: '../outside' }, c),
    /fora do diretório raiz/
  )
  const free = await processStart({ command: 'pwd', cwd: OUTSIDE }, { ...c, confine: false })
  assert.equal(free.status, 'ok')
  assert.equal((await processStart({ command: 'x', wait_for: '(' }, c)).status, 'error')
})

test('evento processes-updated e gc de logs antigos', async () => {
  const c = ctl()
  const seen: number[] = []
  setProcessListener((chatId, list) => {
    if (chatId === c.chatId) seen.push(list.length)
  })
  await processStart({ command: 'true' }, c)
  await sleep(300)
  setProcessListener(null)
  assert.ok(seen.length >= 2, `eventos: ${seen.length}`)
  const old = join(LOGS, 'velho.log')
  writeFileSync(old, 'x')
  const t = (Date.now() - 10 * 86_400_000) / 1000
  utimesSync(old, t, t)
  const del = gcProcessLogs(7)
  assert.deepEqual(del, [old])
  _resetProcesses()
})

// ======================= shell do usuário =======================

test('pickShell: $SHELL zsh/bash existente; fish/inexistente → bash', () => {
  const exists = (p: string): boolean =>
    ['/bin/zsh', '/bin/bash', '/usr/local/bin/fish'].includes(p)
  assert.deepEqual(pickShell('/bin/zsh', exists), { path: '/bin/zsh', name: 'zsh' })
  assert.deepEqual(pickShell('/bin/bash', exists), { path: '/bin/bash', name: 'bash' })
  assert.deepEqual(pickShell('/usr/local/bin/fish', exists), { path: '/bin/bash', name: 'bash' })
  assert.deepEqual(pickShell('/opt/zsh-nao-existe/zsh', exists), {
    path: '/bin/bash',
    name: 'bash'
  })
  assert.deepEqual(pickShell(undefined, exists), { path: '/bin/bash', name: 'bash' })
  assert.deepEqual(
    pickShell('/bin/zsh', () => false),
    { path: 'bash', name: 'bash' }
  )
  assert.equal(parseShellVersion('zsh', 'zsh 5.9 (arm64-apple-darwin25.0)'), '5.9')
  assert.equal(
    parseShellVersion('bash', 'GNU bash, version 3.2.57(1)-release (arm64-apple-darwin25)'),
    '3.2.57'
  )
})

test('parseEnvOutput: ignora lixo antes/depois do marcador; descarta SHLVL/PWD/_', () => {
  const body = [
    'PATH=/a:/b',
    'MULTI=linha1\nlinha2',
    'SHLVL=2',
    'PWD=/x',
    '_=/usr/bin/env',
    'X=1=2'
  ].join('\0')
  const out = `Bem-vindo! motd\n${ENV_MARKER}${body}\0${ENV_MARKER}lixo do .zshrc no fim`
  const env = parseEnvOutput(out)!
  assert.deepEqual(env, { PATH: '/a:/b', MULTI: 'linha1\nlinha2', X: '1=2' })
  assert.equal(parseEnvOutput('sem marcador'), null)
  assert.equal(parseEnvOutput(`${ENV_MARKER}PATH=/a`), null, 'só um marcador')
  // sem NUL (env sem -0): uma por linha
  assert.deepEqual(parseEnvOutput(`${ENV_MARKER}A=1\nB=2\n${ENV_MARKER}`), { A: '1', B: '2' })
})

test('resolveUserEnv: shell real resolve; timeout cai no fallback', async () => {
  const r = await resolveUserEnv('/bin/bash', 10_000)
  assert.ok(r.env?.PATH, r.error)
  assert.ok(!('SHLVL' in r.env!))
  // "shell" que trava: timeout
  const fake = join(TMP, 'slowsh')
  writeFileSync(fake, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
  const t = await resolveUserEnv(fake, 300)
  assert.equal(t.env, null)
  assert.match(t.error ?? '', /tempo esgotado/)
  const bad = await resolveUserEnv(join(TMP, 'nao-existe'), 1000)
  assert.equal(bad.env, null)
  assert.ok(ENV_SCRIPT.includes(ENV_MARKER))
})

test(
  'shell em zsh (se existir): cd persiste, exit code e erros corretos; env resolvido usa -c',
  { skip: !existsSync('/bin/zsh') },
  async () => {
    _setShell({ path: '/bin/zsh', name: 'zsh', version: '5.9' })
    try {
      assert.equal(shellLabel(), 'zsh 5.9')
      for (const env of [null, { PATH: process.env.PATH ?? '/usr/bin:/bin', ZDOTDIR: TMP }]) {
        _setUserEnv({ env, durationMs: 0 })
        const st = { root: ROOT, dir: ROOT }
        const c = { cwd: ROOT, confine: true, signal: new AbortController().signal, shell: st }
        const r1 = await shell({ command: 'cd sub && echo $ZSH_VERSION' }, c as any)
        assert.match(r1.content, /^\d+\.\d+.*\n\[exit code: 0\]/, r1.content)
        assert.equal(st.dir, join(ROOT, 'sub'))
        const r2 = await shell({ command: 'pwd; cd .. && exit 4' }, c as any)
        assert.match(r2.content, new RegExp(`^${join(ROOT, 'sub')}\\n\\[exit code: 4\\]`))
        assert.equal(st.dir, ROOT)
        const r3 = await shell({ command: 'comando_que_nao_existe_xyz' }, c as any)
        assert.match(
          r3.content,
          /command not found: comando_que_nao_existe_xyz\n\[exit code: 127\]/
        )
        const r4 = await shell({ command: 'a=(x y z); echo ${a[1]}' }, c as any)
        assert.match(r4.content, /^x\n/, 'arrays 1-based no zsh')
      }
    } finally {
      _setShell({ path: '/bin/bash', name: 'bash' })
      _setUserEnv({ env: null, error: 'teste', durationMs: 0 })
    }
  }
)

test('descrição da tool shell: zsh / bash 3.2 / bash 5 / fallback; determinística', () => {
  const zsh = shellToolDefinition({ name: 'zsh', version: '5.9', os: 'macOS' }).function.description
  assert.match(
    zsh,
    /^Executa um comando no shell do usuário: zsh 5\.9 \(macOS\) — use sintaxe zsh: arrays começam em 1/
  )
  assert.match(zsh, /nullglob/)
  const b3 = shellToolDefinition({ name: 'bash', version: '3.2.57', os: 'macOS' }).function
    .description
  assert.match(b3, /bash 3\.2\.57 \(macOS\) — bash 3\.2 antigo: sem arrays associativos/)
  const b5 = shellToolDefinition({ name: 'bash', version: '5.2.37', os: 'Linux' }).function
    .description
  assert.match(b5, /^Executa um comando no shell do usuário: bash 5\.2\.37 \(Linux\)\. O ambiente/)
  const fb = TOOL_DEFINITIONS.shell.function.description
  assert.match(fb, /^Executa um comando no shell do usuário \(zsh ou bash\)\. O ambiente/)
  assert.equal(shellDescriptionPrefix(null), 'Executa um comando no shell do usuário (zsh ou bash)')
  for (const d of [zsh, b3, b5, fb]) assert.match(d, /process_start/)
  // injetado → toolDefinitionFor usa; mesma entrada → mesmo texto
  setToolShellInfo({ name: 'zsh', version: '5.9', os: 'macOS' })
  assert.equal(toolDefinitionFor('shell', []).function.description, zsh)
  assert.equal(toolDefinitionFor('shell', ['A', 'B']).function.description, zsh)
  setToolShellInfo(null)
  assert.equal(toolDefinitionFor('shell', []), TOOL_DEFINITIONS.shell)
})

// ======================= migração bash → shell =======================

test('migração bash→shell: mensagens, metas, chats, personas; idempotente', () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chats (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    CREATE TABLE presets (id TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE messages (id TEXT PRIMARY KEY, message_json TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}');
  `)
  const ins = db.prepare('INSERT INTO messages VALUES (?, ?, ?)')
  const call = (name: string): any => ({
    id: 'c',
    type: 'function',
    function: { name, arguments: '{"command":"echo \\"bash\\""}' }
  })
  ins.run(
    'm1',
    JSON.stringify({
      role: 'assistant',
      content: null,
      tool_calls: [call('bash'), call('read_file')]
    }),
    '{}'
  )
  ins.run('m2', JSON.stringify({ role: 'user', content: 'use "bash" por favor' }), '{}')
  ins.run(
    'm3',
    JSON.stringify({ role: 'tool', tool_call_id: 'c', content: 'ok "bash"' }),
    JSON.stringify({ toolStatus: 'ok', toolName: 'bash' })
  )
  db.prepare('INSERT INTO chats VALUES (?, ?)').run(
    'c1',
    JSON.stringify({
      enabledTools: ['read_file', 'bash', 'shell'],
      autoApprove: ['bash'],
      smartApprove: { enabled: true, tools: ['bash', 'web_search'] },
      systemPrompt: 'fale "bash"'
    })
  )
  db.prepare('INSERT INTO chats VALUES (?, ?)').run(
    'c2',
    JSON.stringify({ enabledTools: ['read_file'] })
  )
  db.prepare('INSERT INTO presets VALUES (?, ?)').run(
    'p1',
    JSON.stringify({ autoApprove: ['bash'] })
  )

  const r = migrateToolShellRename(db)
  assert.deepEqual(r, { skipped: false, messages: 1, metas: 1, chats: 1, presets: 1 })
  const msg = (id: string): any =>
    JSON.parse(
      (db.prepare('SELECT message_json FROM messages WHERE id = ?').get(id) as any).message_json
    )
  assert.deepEqual(
    msg('m1').tool_calls.map((t: any) => t.function.name),
    ['shell', 'read_file']
  )
  assert.equal(
    msg('m1').tool_calls[0].function.arguments,
    '{"command":"echo \\"bash\\""}',
    'argumentos intactos'
  )
  assert.equal(msg('m2').content, 'use "bash" por favor', 'texto do usuário intacto')
  const meta = JSON.parse(
    (db.prepare('SELECT meta_json FROM messages WHERE id = ?').get('m3') as any).meta_json
  )
  assert.equal(meta.toolName, 'shell')
  const cfg = JSON.parse(
    (db.prepare('SELECT config_json FROM chats WHERE id = ?').get('c1') as any).config_json
  )
  assert.deepEqual(cfg.enabledTools, [
    'read_file',
    'shell',
    'process_start',
    'process_logs',
    'process_list',
    'process_stop'
  ])
  assert.deepEqual(cfg.autoApprove, ['shell'])
  assert.deepEqual(cfg.smartApprove.tools, ['shell', 'web_search'])
  assert.equal(cfg.systemPrompt, 'fale "bash"')
  const pcfg = JSON.parse(
    (db.prepare('SELECT config_json FROM presets WHERE id = ?').get('p1') as any).config_json
  )
  assert.deepEqual(pcfg.autoApprove, ['shell'])
  assert.ok(db.prepare('SELECT value FROM settings WHERE key = ?').get(TOOL_SHELL_RENAME_FLAG))
  // segunda vez: nada (flag)
  assert.equal(migrateToolShellRename(db).skipped, true)
  db.close()
})

test('alias de leitura: configs com "bash" viram "shell"', () => {
  const c = migrateConfigTools({ enabledTools: ['bash', 'list_dir'], autoApprove: [] } as any)
  assert.deepEqual(c.enabledTools, [
    'shell',
    'process_start',
    'process_logs',
    'process_list',
    'process_stop',
    'list_dir'
  ])
  const same = { enabledTools: ['shell'] } as any
  assert.equal(migrateConfigTools(same), same, 'sem mudança → mesmo objeto')
  // alias de leitura nas personas: bash → shell → modo do item (autoApprove ≤ 0.3.0)
  assert.deepEqual(sanitizePresetConfig({ autoApprove: ['bash'] } as any).approvalModes, {
    commands: 'always'
  })
})
