/* eslint-disable @typescript-eslint/no-explicit-any */
// Ações por tipo de arquivo do visualizador (sem Electron, NADA é executado): classificação por
// extensão + sistema (plataforma injetada), recusa de "Abrir no app", detecção de terminal do Linux
// (`which` injetado), planos de execução por sistema (argumentos em lista, caminho fora do texto do
// shell), texto da confirmação e o fluxo do main com dependências falsas — token não concedido,
// reclassificação, cancelar, cópia temporária privada do arquivo remoto.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { classifyFileAction, hostOsOf, openBlockedReason } from '../src/shared/fileActions.ts'
import {
  assertCanOpenLocal,
  buildRunPlan,
  LINUX_TERMINALS,
  linuxTerminalCommand,
  RUN_FILE_ENV,
  runConfirmText,
  runGrantedFile,
  runRemoteBytes,
  TERMINAL_BASH_SCRIPT,
  whichSync,
  type RunDeps
} from '../src/main/fileRun.ts'
import { ViewerRegistry } from '../src/main/fileViewer.ts'
import { codeLanguage, detectViewerKind } from '../src/shared/fileViewer.ts'

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cc-fileactions-')))
after(() => rmSync(TMP, { recursive: true, force: true }))

const cls = (name: string, platform: string, localExecutable?: boolean): string => {
  const a = classifyFileAction(name, platform, { localExecutable })
  return a.class === 'executable-here'
    ? `here:${a.method}`
    : a.class === 'executable-other-os'
      ? `other:${a.os}`
      : a.class
}

test('classificação: Windows', () => {
  const p = 'win32'
  assert.equal(hostOsOf(p), 'windows')
  for (const n of ['setup.exe', 'pacote.msi', 'velho.com', 'App.appx', 'App.msix', 'X.MSIXBUNDLE'])
    assert.equal(cls(n, p), 'here:open', n)
  assert.equal(cls('build.bat', p), 'here:cmd')
  assert.equal(cls('build.CMD', p), 'here:cmd')
  assert.equal(cls('deploy.ps1', p), 'here:powershell')
  assert.equal(cls('deploy.sh', p), 'other:Linux/macOS')
  assert.equal(cls('app.AppImage', p), 'other:Linux')
  assert.equal(cls('instalar.run', p), 'other:Linux')
  assert.equal(cls('Instalador.dmg', p), 'other:macOS')
  assert.equal(cls('Instalador.pkg', p), 'other:macOS')
  assert.equal(cls('abrir.command', p), 'other:macOS')
  // o app padrão do Windows EXECUTA estes: sem "documento" (comportamento antigo)
  for (const n of ['app.js', 'macro.vbs', 'atalho.lnk', 'chave.reg', 'tela.scr', 'app.jar'])
    assert.equal(cls(n, p), 'unknown', n)
  for (const n of ['relatorio.md', 'foto.png', 'dados.zip', 'planilha.xlsx', 'doc.pdf'])
    assert.equal(cls(n, p), 'document', n)
  // bit de execução não vale fora do Linux
  assert.equal(cls('ferramenta', p, true), 'unknown')
})

test('classificação: Linux', () => {
  const p = 'linux'
  assert.equal(hostOsOf(p), 'linux')
  assert.equal(hostOsOf('freebsd'), 'linux')
  assert.equal(cls('deploy.sh', p), 'here:terminal-bash')
  assert.equal(cls('driver.run', p), 'here:terminal-bash')
  assert.equal(cls('Editor-1.2.AppImage', p), 'here:appimage')
  assert.equal(cls('editor.appimage', p), 'here:appimage')
  assert.equal(cls('setup.exe', p), 'other:Windows')
  assert.equal(cls('build.bat', p), 'other:Windows')
  assert.equal(cls('deploy.ps1', p), 'other:Windows')
  assert.equal(cls('Instalador.dmg', p), 'other:macOS')
  assert.equal(cls('abrir.command', p), 'other:macOS')
  // sem extensão: só com o bit de execução LOCAL
  assert.equal(cls('ferramenta', p, true), 'here:terminal-exec')
  assert.equal(cls('ferramenta', p), 'unknown')
  assert.equal(cls('LICENSE', p), 'document')
  // .bin fica de fora (quase sempre é dado): documento binário conhecido
  assert.equal(cls('firmware.bin', p), 'document')
  for (const n of ['app.desktop', 'pacote.deb', 'pacote.rpm', 'app.jar'])
    assert.equal(cls(n, p), 'unknown', n)
  // .js no Linux é só código
  assert.equal(cls('app.js', p), 'document')
})

test('classificação: macOS', () => {
  const p = 'darwin'
  assert.equal(hostOsOf(p), 'macos')
  assert.equal(cls('abrir.command', p), 'here:mac-terminal')
  assert.equal(cls('deploy.sh', p), 'here:mac-terminal')
  assert.equal(cls('Instalador.pkg', p), 'here:open')
  assert.equal(cls('Instalador.dmg', p), 'here:open')
  assert.equal(cls('App.app', p), 'here:open')
  assert.equal(cls('setup.exe', p), 'other:Windows')
  assert.equal(cls('app.AppImage', p), 'other:Linux')
  assert.equal(cls('ferramenta', p, true), 'unknown')
  assert.equal(cls('fluxo.workflow', p), 'unknown')
  assert.equal(cls('notas.txt', p), 'document')
})

test('scripts em texto têm prévia como código (Executar… é uma ação a mais)', () => {
  const txt = new TextEncoder().encode('echo oi\n')
  for (const n of ['a.sh', 'a.command', 'a.bat', 'a.cmd', 'a.ps1'])
    assert.equal(detectViewerKind(n, txt), 'code', n)
  assert.equal(codeLanguage('a.command'), 'bash')
  assert.equal(codeLanguage('a.ps1'), 'plaintext')
  // .run / .AppImage com bytes binários: painel sem prévia (com Executar…)
  assert.equal(
    detectViewerKind('x.AppImage', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0])),
    'binary'
  )
})

test('"Abrir no app" recusado: executáveis (local e remoto) e os perigosos só no remoto', () => {
  assert.match(openBlockedReason('deploy.sh', 'linux')!, /Executar…/)
  assert.match(openBlockedReason('setup.exe', 'linux')!, /^Executável de Windows — não roda/)
  assert.match(openBlockedReason('setup.exe', 'linux', { remote: true })!, /Windows.*Salvar como/)
  assert.match(openBlockedReason('setup.exe', 'win32', { remote: true })!, /Executar…/)
  // local: comportamento antigo para tipos "desconhecidos"
  assert.equal(openBlockedReason('macro.vbs', 'win32'), null)
  assert.match(openBlockedReason('macro.vbs', 'win32', { remote: true })!, /Salvar como/)
  assert.equal(openBlockedReason('relatorio.md', 'linux', { remote: true }), null)
  assert.equal(openBlockedReason('ferramenta', 'linux'), null)
  assert.match(openBlockedReason('ferramenta', 'linux', { localExecutable: true })!, /Executar/)
  // remoto ignora o bit de execução (só local)
  assert.equal(
    openBlockedReason('ferramenta', 'linux', { remote: true, localExecutable: true }),
    null
  )
})

test('terminal do Linux: ordem de preferência e argumentos em lista', () => {
  const only =
    (...have: string[]) =>
    (cmd: string): string | null =>
      have.includes(cmd) ? `/usr/bin/${cmd}` : null
  const cmd = ['/usr/bin/bash', '-c', 'S', 'clearchat', '/tmp/a b.sh']
  assert.deepEqual(
    LINUX_TERMINALS.map((t) => t.bin),
    [
      'x-terminal-emulator',
      'gnome-terminal',
      'konsole',
      'xfce4-terminal',
      'kitty',
      'alacritty',
      'wezterm',
      'xterm'
    ]
  )
  assert.deepEqual(linuxTerminalCommand(only('xterm', 'gnome-terminal'), cmd), {
    command: '/usr/bin/gnome-terminal',
    args: ['--', ...cmd]
  })
  assert.deepEqual(linuxTerminalCommand(only('xterm', 'x-terminal-emulator'), cmd)?.args, [
    '-e',
    ...cmd
  ])
  assert.deepEqual(linuxTerminalCommand(only('konsole'), cmd)?.args, ['-e', ...cmd])
  assert.deepEqual(linuxTerminalCommand(only('xfce4-terminal'), cmd)?.args, ['-x', ...cmd])
  assert.deepEqual(linuxTerminalCommand(only('kitty'), cmd)?.args, cmd)
  assert.deepEqual(linuxTerminalCommand(only('alacritty'), cmd)?.args, ['-e', ...cmd])
  assert.deepEqual(linuxTerminalCommand(only('wezterm'), cmd)?.args, ['start', '--', ...cmd])
  assert.deepEqual(linuxTerminalCommand(only('xterm'), cmd)?.args, ['-e', ...cmd])
  assert.equal(linuxTerminalCommand(only(), cmd), null)
  // which real: só pastas absolutas do PATH, só executáveis
  const bin = join(TMP, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'meu-term'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(join(bin, 'nao-exec'), 'x', { mode: 0o644 })
  if (process.platform !== 'win32') {
    assert.equal(whichSync('meu-term', `relativo:${bin}`), join(bin, 'meu-term'))
    assert.equal(whichSync('nao-exec', bin), null)
    assert.equal(whichSync('meu-term', 'relativo'), null)
  }
})

test('planos de execução: o caminho nunca entra no texto do shell', () => {
  const file = '/home/u/Meus scripts/a"; rm -rf ~; ".sh'
  const which = (c: string): string | null =>
    c === 'bash' ? '/usr/bin/bash' : c === 'konsole' ? '/usr/bin/konsole' : null
  const env = { platform: 'linux', which }
  const p = buildRunPlan(file, 'terminal-bash', env)
  assert.ok(p.kind === 'spawn')
  if (p.kind !== 'spawn') return
  assert.equal(p.command, '/usr/bin/konsole')
  assert.deepEqual(p.args, ['-e', '/usr/bin/bash', '-c', TERMINAL_BASH_SCRIPT, 'clearchat', file])
  assert.ok(!TERMINAL_BASH_SCRIPT.includes(file) && TERMINAL_BASH_SCRIPT.includes('bash -- "$1"'))
  assert.match(TERMINAL_BASH_SCRIPT, /read -r _/)
  assert.equal(p.cwd, '/home/u/Meus scripts')
  const e = buildRunPlan('/x/run.sh', 'terminal-exec', env)
  assert.ok(e.kind === 'spawn' && e.args.includes('/x/run.sh') && !e.args[3].includes('/x/run.sh'))
  // sem terminal → erro sugerindo "Salvar como…"
  const none = buildRunPlan('/x/a.sh', 'terminal-bash', { platform: 'linux', which: () => null })
  assert.ok(none.kind === 'error' && /Nenhum terminal.*Salvar como/.test(none.message))
  // AppImage: chmod e roda o próprio arquivo, destacado
  assert.deepEqual(buildRunPlan('/x/App.AppImage', 'appimage', env), {
    kind: 'spawn',
    file: '/x/App.AppImage',
    command: '/x/App.AppImage',
    args: [],
    cwd: '/x',
    chmod: true
  })
  // macOS
  const mac = buildRunPlan('/x/abrir.command', 'mac-terminal', { platform: 'darwin', which })
  assert.ok(mac.kind === 'spawn')
  if (mac.kind === 'spawn') {
    assert.equal(mac.command, '/usr/bin/open')
    assert.deepEqual(mac.args, ['-a', 'Terminal', '/x/abrir.command'])
    assert.equal(mac.chmod, true)
  }
  assert.deepEqual(buildRunPlan('/x/I.pkg', 'open', env), { kind: 'open', file: '/x/I.pkg' })
})

test('planos do Windows: cmd/PowerShell visíveis por `start`, caminho por variável, entre aspas', () => {
  const env = { platform: 'win32', which: () => null, systemRoot: 'C:\\Windows' }
  const file = 'C:\\Users\\u\\Downloads\\a&b (1).bat'
  const p = buildRunPlan(file, 'cmd', env)
  assert.ok(p.kind === 'spawn')
  if (p.kind !== 'spawn') return
  assert.equal(p.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(p.verbatim, true)
  assert.deepEqual(p.env, { [RUN_FILE_ENV]: file })
  assert.deepEqual(p.args, [
    '/d',
    '/c',
    'start',
    '"ClearChat"',
    '"C:\\Windows\\System32\\cmd.exe"',
    '/d',
    '/v:off',
    '/k',
    'call',
    `"%${RUN_FILE_ENV}%"`
  ])
  assert.ok(!p.args.join(' ').includes('a&b'), 'o caminho não vai na linha de comando')
  const ps = buildRunPlan('C:\\x\\deploy.ps1', 'powershell', env)
  assert.ok(ps.kind === 'spawn')
  if (ps.kind === 'spawn')
    assert.deepEqual(ps.args.slice(4), [
      '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
      '-NoExit',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `"%${RUN_FILE_ENV}%"`
    ])
  // % (o cmd expandiria) → recusa
  const bad = buildRunPlan('C:\\x\\%PATH%.bat', 'cmd', env)
  assert.ok(bad.kind === 'error' && /Salvar como/.test(bad.message))
  assert.deepEqual(buildRunPlan('C:\\x\\setup.exe', 'open', env), {
    kind: 'open',
    file: 'C:\\x\\setup.exe'
  })
})

test('texto da confirmação: nome, tamanho, origem/pasta, como roda', () => {
  const r = runConfirmText({
    name: 'deploy.ps1',
    size: 2048,
    method: 'powershell',
    platform: 'win32',
    origin: 'PC do escritório'
  })
  assert.equal(r.message, 'Executar “deploy.ps1”?')
  assert.match(r.detail, /Tamanho: 2\.0 KB/)
  assert.match(r.detail, /Veio de PC do escritório/)
  assert.match(r.detail, /ExecutionPolicy Bypass/)
  const l = runConfirmText({
    name: 'a.sh',
    size: 10,
    method: 'terminal-bash',
    platform: 'linux',
    dir: '/home/u'
  })
  assert.match(l.detail, /Pasta: \/home\/u/)
  assert.match(l.detail, /terminal/)
  assert.doesNotMatch(l.detail, /Veio de/)
})

/** Dependências falsas: registram tudo; nada roda. */
function fakeDeps(platform = 'linux', answer = true): { deps: RunDeps; calls: string[] } {
  const calls: string[] = []
  const deps: RunDeps = {
    platform,
    which: (c) => (c === 'bash' ? '/usr/bin/bash' : c === 'xterm' ? '/usr/bin/xterm' : null),
    confirm: async (t) => {
      calls.push(`confirm:${t.message}`)
      return answer
    },
    openPath: async (p) => {
      calls.push(`open:${p}`)
      return ''
    },
    spawn: async (command, args) => {
      calls.push(`spawn:${command} ${JSON.stringify(args)}`)
    },
    chmodX: async (p) => {
      calls.push(`chmod:${p}`)
    },
    log: (m) => calls.push(`log:${m}`)
  }
  return { deps, calls }
}

test('main: só executa token concedido, reclassifica e confirma (nada roda de verdade)', async () => {
  const reg = new ViewerRegistry()
  const dir = join(TMP, 'local')
  mkdirSync(dir)
  const write = (name: string, mode = 0o644): string => {
    const p = join(dir, name)
    writeFileSync(p, '#!/bin/sh\necho oi\n', { mode })
    chmodSync(p, mode)
    return p
  }
  const sh = write('deploy.sh')
  const md = write('notas.md')
  const exe = write('setup.exe')
  const tool = write('ferramenta', 0o755)
  // token não concedido / formato errado / caminho no lugar do token → recusa sem perguntar
  for (const t of ['0'.repeat(32), sh, 42 as any, null as any]) {
    const { deps, calls } = fakeDeps()
    await assert.rejects(runGrantedFile(t, deps, reg), /não disponível/)
    assert.deepEqual(calls, [])
  }
  // concedido mas não executável deste sistema (a classe do renderer não importa)
  {
    const { deps, calls } = fakeDeps()
    await assert.rejects(
      runGrantedFile(reg.grant(md, 'markdown').token, deps, reg),
      /não é um executável/
    )
    await assert.rejects(
      runGrantedFile(reg.grant(exe, 'binary').token, deps, reg),
      /Executável de Windows/
    )
    assert.deepEqual(calls, [])
  }
  // cancelar → false, nada roda
  {
    const { deps, calls } = fakeDeps('linux', false)
    assert.equal(await runGrantedFile(reg.grant(sh, 'code').token, deps, reg), false)
    assert.deepEqual(calls, ['confirm:Executar “deploy.sh”?', `log:cancelado: ${sh}`])
  }
  // confirmar → terminal com bash e o caminho como argumento
  {
    const { deps, calls } = fakeDeps()
    assert.equal(await runGrantedFile(reg.grant(sh, 'code').token, deps, reg), true)
    assert.equal(calls[0], 'confirm:Executar “deploy.sh”?')
    assert.equal(
      calls.at(-1),
      `spawn:/usr/bin/xterm ${JSON.stringify(['-e', '/usr/bin/bash', '-c', TERMINAL_BASH_SCRIPT, 'clearchat', sh])}`
    )
    assert.ok(calls.some((c) => c === `log:terminal-bash: ${sh}`))
  }
  // sem extensão + bit de execução (Linux) → executa o arquivo no terminal; no macOS não
  {
    const { deps, calls } = fakeDeps()
    assert.equal(await runGrantedFile(reg.grant(tool, 'binary').token, deps, reg), true)
    assert.ok(calls.at(-1)!.includes('"clearchat",' + JSON.stringify(tool)))
    const mac = fakeDeps('darwin')
    await assert.rejects(runGrantedFile(reg.grant(tool, 'binary').token, mac.deps, reg))
  }
  // trocado por symlink depois da concessão → recusa
  if (process.platform !== 'win32') {
    const target = write('outro.sh')
    const link = join(dir, 'trocado.sh')
    writeFileSync(link, 'x')
    const token = reg.grant(link, 'code').token
    rmSync(link)
    symlinkSync(target, link)
    const { deps, calls } = fakeDeps()
    await assert.rejects(runGrantedFile(token, deps, reg), /mudou de lugar/)
    assert.deepEqual(calls, [])
  }
  // "Abrir no app" local recusa executáveis (deste sistema e de outro)
  await assert.rejects(assertCanOpenLocal(sh, 'linux'), /Executar…/)
  await assert.rejects(assertCanOpenLocal(exe, 'linux'), /Executável de Windows/)
  await assert.rejects(assertCanOpenLocal(tool, 'linux'), /Executar…/)
  await assertCanOpenLocal(md, 'linux')
  await assertCanOpenLocal(tool, 'darwin')
})

test('main: arquivo do host roda da cópia temporária privada, depois da confirmação', async () => {
  const dir = join(TMP, 'tmp-run')
  const bytes = new TextEncoder().encode('#!/bin/sh\necho remoto\n')
  // fora do controle remoto → recusa
  {
    const { deps, calls } = fakeDeps()
    await assert.rejects(runRemoteBytes('a.sh', bytes, null, deps, dir), /controle remoto/)
    assert.deepEqual(calls, [])
  }
  // executável de outro sistema / documento → recusa sem perguntar
  {
    const { deps, calls } = fakeDeps()
    await assert.rejects(runRemoteBytes('setup.exe', bytes, 'PC', deps, dir), /Windows/)
    await assert.rejects(runRemoteBytes('notas.md', bytes, 'PC', deps, dir), /não é um executável/)
    await assert.rejects(runRemoteBytes('a.sh', 'não é Uint8Array', 'PC', deps, dir), /inválido/)
    assert.deepEqual(calls, [])
  }
  // cancelar → nada gravado
  {
    const { deps, calls } = fakeDeps('linux', false)
    assert.equal(await runRemoteBytes('a.sh', bytes, 'PC do escritório', deps, dir), false)
    assert.equal(existsSync(dir), false)
    assert.equal(calls[0], 'confirm:Executar “a.sh”?')
  }
  // confirmar → pasta 0700, arquivo 0700, terminal com o caminho da cópia
  {
    const { deps, calls } = fakeDeps()
    assert.equal(await runRemoteBytes('../../a.sh', bytes, 'PC do escritório', deps, dir), true)
    const [sub] = readdirSync(dir)
    const file = join(dir, sub, 'a.sh')
    assert.deepEqual(new Uint8Array(readFileSync(file)), bytes)
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, sub)).mode & 0o777, 0o700)
      assert.equal(statSync(file).mode & 0o777, 0o700)
    }
    assert.ok(calls.at(-1)!.startsWith('spawn:/usr/bin/xterm '))
    assert.ok(calls.at(-1)!.endsWith(`"clearchat",${JSON.stringify(file)}]`))
    assert.ok(calls.some((c) => c.startsWith('log:terminal-bash (de PC do escritório): ')))
  }
  // AppImage: chmod + roda a própria cópia; sem terminal não importa
  {
    const { deps, calls } = fakeDeps()
    deps.which = () => null
    assert.equal(await runRemoteBytes('Editor.AppImage', bytes, 'PC', deps, dir), true)
    const spawned = calls.find((c) => c.startsWith('spawn:'))!
    const chmod = calls.find((c) => c.startsWith('chmod:'))!
    assert.equal(spawned, `spawn:${chmod.slice(6)} []`)
    assert.equal(dirname(dirname(chmod.slice(6))), dir)
  }
  // .sh sem terminal → erro antes de perguntar
  {
    const { deps, calls } = fakeDeps()
    deps.which = () => null
    await assert.rejects(runRemoteBytes('b.sh', bytes, 'PC', deps, dir), /Salvar como/)
    assert.deepEqual(calls, [])
  }
  // Windows: .exe → shell.openPath da cópia
  {
    const { deps, calls } = fakeDeps('win32')
    assert.equal(await runRemoteBytes('setup.exe', bytes, 'PC', deps, dir), true)
    assert.ok(calls.at(-1)!.startsWith('open:') && calls.at(-1)!.endsWith('setup.exe'))
  }
})
