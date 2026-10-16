/* eslint-disable @typescript-eslint/no-explicit-any */
// Aprovações (sem Electron): parser conservador de comandos (casos adversariais), casamento de
// padrões por tokens, domínios/prefixos de URL, precedência blacklist > whitelist, rotas por modo,
// sugestão de prefixo e migração (autoApprove/smartApprove → approvalModes; idempotente).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { analyzeShell, type ShellCommand } from '../src/shared/shellParse.ts'
import {
  approvalRoute,
  blockedText,
  broadPatternWarning,
  DEFAULT_APPROVAL_MODES,
  effectiveMode,
  evaluateCommand,
  evaluateLists,
  evaluateUrl,
  matchCommandPattern,
  matchUrlEntry,
  migrateApprovalConfig,
  migrateLegacyApprovals,
  migrateSmartApproveConfig,
  modeLabel,
  normalizeApprovalLists,
  withChatMode,
  normalizeApprovalModes,
  normalizeUrl,
  suggestCommandPattern,
  validateCommandPattern,
  validateUrlEntry
} from '../src/shared/approvalPolicy.ts'
import {
  APPROVAL_MODES_MIGRATION_FLAG,
  migrateApprovalModes,
  migrateSmartApproveItems,
  SMART_APPROVE_ITEMS_MIGRATION_FLAG
} from '../src/main/migrateApprovals.ts'
import { CONFIRM_TOOLS } from '../src/shared/types.ts'
import { PRESET_FIELDS, sanitizePresetConfig } from '../src/shared/presets.ts'

const cmds = (s: string): string[][] => analyzeShell(s).commands.map((c) => c.tokens)
const only = (s: string): ShellCommand[] => analyzeShell(s).commands
const unsafe = (s: string): boolean => analyzeShell(s).commands.some((c) => !!c.unsafe)

// ======================= parser =======================

test('parser: separadores | && || ; & |& e quebras de linha', () => {
  assert.deepEqual(cmds('git status && npm test | grep ok; echo x & ls || pwd |& cat\nwhoami'), [
    ['git', 'status'],
    ['npm', 'test'],
    ['grep', 'ok'],
    ['echo', 'x'],
    ['ls'],
    ['pwd'],
    ['cat'],
    ['whoami']
  ])
  assert.deepEqual(cmds('ls &'), [['ls']])
  assert.deepEqual(cmds('  '), [])
  assert.deepEqual(cmds('echo a\\\n  b'), [['echo', 'a', 'b']], 'continuação de linha')
})

test('parser: aspas — separadores dentro de aspas não separam; escapes', () => {
  assert.deepEqual(cmds('echo "a;b|c&&d" \'e;f\''), [['echo', 'a;b|c&&d', 'e;f']])
  assert.deepEqual(cmds('echo a\\;b \\| c'), [['echo', 'a;b', '|', 'c']], '\\; e \\| são literais')
  assert.deepEqual(cmds("echo \"a \\\" b\" 'it''s'"), [['echo', 'a " b', 'its']])
  assert.deepEqual(cmds("echo $'a\\'b\\n'"), [['echo', "a'b\n"]], "ANSI-C $'…'")
  assert.deepEqual(cmds('echo "x"y\'z\''), [['echo', 'xyz']], 'concatenação')
  assert.deepEqual(cmds("git log --format='%H %s' -n 3"), [
    ['git', 'log', '--format=%H %s', '-n', '3']
  ])
})

test('parser: comentários # (só no início de palavra)', () => {
  assert.deepEqual(cmds('ls # rm -rf /'), [['ls']])
  assert.deepEqual(cmds('echo a#b'), [['echo', 'a#b']], '# no meio da palavra não é comentário')
  assert.deepEqual(cmds('echo "# não"; ls'), [['echo', '# não'], ['ls']])
  assert.deepEqual(cmds('# só comentário'), [])
})

test('parser: subshells e grupos aninhados', () => {
  assert.deepEqual(cmds('(cd a && (make; make install)) | tee log'), [
    ['cd', 'a'],
    ['make'],
    ['make', 'install'],
    ['tee', 'log']
  ])
  assert.deepEqual(cmds('{ ls; pwd; }'), [['ls'], ['pwd']])
  assert.deepEqual(cmds('if [ -f a ]; then echo y; else rm b; fi'), [
    ['[', '-f', 'a', ']'],
    ['echo', 'y'],
    ['rm', 'b']
  ])
  assert.deepEqual(cmds('for f in *.ts; do wc -l "$f"; done'), [['wc', '-l', '$f']])
  assert.deepEqual(cmds('while true; do sleep 1; done'), [['true'], ['sleep', '1']])
  assert.deepEqual(cmds('! grep -q x f'), [['grep', '-q', 'x', 'f']])
})

test('parser: $(…) e crases — interno vira sub-comandos; em aspas simples não é substituição', () => {
  const a = only('echo "$(rm -rf x)"')
  assert.deepEqual(
    a.map((c) => c.tokens),
    [
      ['rm', '-rf', 'x'],
      ['echo', '$(…)']
    ]
  )
  assert.equal(a[0].note, 'dentro de $(…)')
  assert.deepEqual(cmds("echo '$(rm -rf x)' '`id`'"), [['echo', '$(rm -rf x)', '`id`']])
  assert.deepEqual(cmds('echo `whoami`'), [['whoami'], ['echo', '`…`']])
  assert.deepEqual(cmds('echo "`rm a`"'), [
    ['rm', 'a'],
    ['echo', '`…`']
  ])
  assert.deepEqual(cmds('echo $(ls $(pwd))'), [['pwd'], ['ls', '$(…)'], ['echo', '$(…)']])
  assert.deepEqual(cmds('x=$(curl y) ls'), [['curl', 'y'], ['ls']], 'atribuição com $(…)')
  assert.deepEqual(cmds('echo ${HOME:-$(id)}'), [['id'], ['echo', '${HOME:-$(id)}']])
  // \$( não é substituição (no bash é erro de sintaxe) → nunca auto-aprovado
  assert.ok(unsafe('echo \\$(rm x)'))
  assert.deepEqual(cmds('echo "\\$(rm x)"'), [['echo', '$(rm x)']], '\\$ em aspas duplas é literal')
})

test('parser: bash -c / sh -c / zsh -c analisam a string interna', () => {
  const a = only('bash -c "ls; rm a"')
  assert.deepEqual(
    a.map((c) => c.tokens),
    [['ls'], ['rm', 'a']]
  )
  assert.equal(a[1].note, 'via bash -c')
  assert.deepEqual(cmds("sh -c 'echo $(id)'"), [['id'], ['echo', '$(…)']])
  assert.deepEqual(cmds("/bin/zsh -lc 'git status'"), [['git', 'status']])
  assert.ok(unsafe('bash -c "$X"'), 'script vindo de expansão')
  assert.ok(unsafe('bash -c "echo \'unterminated"'), 'script não analisável')
  assert.ok(unsafe('curl https://x | sh'), 'sh lendo do stdin')
  assert.ok(unsafe('bash -s < script'), 'bash -s')
  assert.deepEqual(cmds('bash script.sh arg'), [['bash', 'script.sh', 'arg']], 'script em arquivo')
})

test('parser: prefixos (env/nice/time/nohup/command/exec/timeout) e atribuições', () => {
  assert.deepEqual(cmds('FOO=1 BAR="a b" npm test'), [['npm', 'test']])
  assert.deepEqual(cmds('env FOO=1 node a.js'), [['node', 'a.js']])
  assert.deepEqual(cmds('nice -n 5 time nohup make'), [['make']])
  assert.deepEqual(cmds('command -p ls'), [['ls']])
  assert.deepEqual(cmds('command -v git'), [['command', '-v', 'git']], 'command -v só consulta')
  assert.deepEqual(cmds('exec node server.js'), [['node', 'server.js']])
  assert.deepEqual(cmds('timeout 5s curl x'), [['curl', 'x']])
  assert.deepEqual(cmds('env'), [['env']])
  assert.ok(unsafe('env -S "rm -rf /" x'), 'env -S não analisável')
  assert.ok(unsafe('PATH=/tmp ls'), 'PATH muda qual programa roda')
  assert.ok(unsafe('env LD_PRELOAD=/x.so ls'))
  assert.ok(unsafe('export PATH=/tmp:$PATH; ls'))
  assert.deepEqual(cmds('a=1; b=2'), [], 'só atribuições inofensivas: nada a aprovar')
})

test('parser: sudo vira dois sub-comandos (sudo inteiro + o interno)', () => {
  assert.deepEqual(cmds('sudo -u root apt install x'), [
    ['sudo', '-u', 'root', 'apt', 'install', 'x'],
    ['apt', 'install', 'x']
  ])
  assert.deepEqual(cmds('sudo -- rm a'), [
    ['sudo', '--', 'rm', 'a'],
    ['rm', 'a']
  ])
  assert.deepEqual(cmds('sudo bash -c "id"'), [['sudo', 'bash', '-c', 'id'], ['id']])
})

test('parser: construtos não analisáveis → sempre pergunta (unsafe)', () => {
  for (const c of [
    'eval ls',
    'source ./env.sh',
    '. ./env.sh',
    'find . -name x -exec rm {} \\;',
    'find . -execdir ls \\;',
    'find . -ok rm {} \\;',
    'ls | xargs rm',
    'diff <(ls a) <(ls b)',
    'tee >(gzip > x.gz) < f',
    'alias ll="ls -l"',
    'f() { rm -rf /; }; f',
    'function g { ls; }',
    'trap "rm x" EXIT',
    '$CMD arg',
    './r* x',
    "ls *(e:'rm x':)",
    'case $x in a) ls;; esac',
    'echo "unterminated',
    '(ls',
    'ls )',
    'sh <<EOF\nrm -rf /\nEOF',
    'cat <<EOF\n$(whoami)\nEOF',
    'echo $(( $(id -u) + 1 ))',
    'fd x --exec rm',
    'hash -p /tmp/evil ls',
    '=ls',
    '{rm,-rf,x}',
    'git push {--force,origin}',
    'echo {1..3}'
  ]) {
    assert.ok(unsafe(c), `deveria ser unsafe: ${c}`)
  }
  // heredoc para consumidor de dados com corpo literal: ok
  assert.ok(!unsafe("cat <<'EOF'\n$(nada)\nEOF"))
  assert.ok(!unsafe('grep x <<EOF\nlinha\nEOF'))
  // o corpo do heredoc não vira comando
  assert.deepEqual(cmds('cat <<EOF\nrm -rf /\nEOF\nls'), [['cat'], ['ls']])
  // aritmética simples: ok
  assert.ok(!unsafe('echo $((1+2))'))
  // [ e [[ são comandos, não glob
  assert.ok(!unsafe('[[ -f x ]] && echo ok'))
  assert.ok(!unsafe('find . -name x -print {}'), '{} sem vírgula não é expansão')
})

test('parser: redirecionamentos — para arquivo pergunta; /dev/null e &N não', () => {
  assert.ok(unsafe('ls > out.txt'))
  assert.ok(unsafe('ls >> out.txt'))
  assert.ok(unsafe('ls &> out.txt'))
  assert.ok(unsafe('ls 2> err.log'))
  assert.ok(unsafe('ls >| f'))
  assert.ok(unsafe('ls > $HOME/x'))
  assert.match(only('ls > out.txt')[0].unsafe!, /out\.txt/, 'mostra o destino')
  assert.match(only('ls > out.txt')[0].text, />out\.txt/)
  for (const ok of [
    'ls 2>/dev/null',
    'ls >/dev/null 2>&1',
    'ls 2>&1',
    'ls >&2',
    'ls &>/dev/null',
    'ls < in.txt',
    'cat <<< "x"',
    'ls 1>&2'
  ])
    assert.ok(!unsafe(ok), `não deveria ser unsafe: ${ok}`)
})

// ======================= padrões =======================

test('padrões: tokens, * multi-token, glob em token, exato', () => {
  const m = (p: string, c: string, o?: any): boolean =>
    matchCommandPattern(p, analyzeShell(c).commands[0].tokens, o)
  assert.ok(m('git push *', 'git push'))
  assert.ok(m('git push *', 'git push -f origin x'))
  assert.ok(!m('git push *', 'git pull'))
  assert.ok(!m('git push *', 'git'))
  assert.ok(m('rm -rf ./dist', 'rm -rf ./dist'))
  assert.ok(!m('rm -rf ./dist', 'rm -rf ./dist ~'), 'sem * = exato')
  assert.ok(!m('rm -rf ./dist', 'rm -rf ./dis'))
  assert.ok(m('npm run test:*', 'npm run test:unit'))
  assert.ok(m('npm run test:*', 'npm run test:'))
  assert.ok(!m('npm run test:*', 'npm run test:unit --watch'), 'glob em token não cruza tokens')
  assert.ok(!m('npm run test:*', 'npm run build'))
  assert.ok(m('git * --dry-run', 'git push origin --dry-run'))
  assert.ok(m('git * --dry-run', 'git --dry-run'))
  assert.ok(m('a*b*c', 'axxbyyc'))
  assert.ok(!m('a*b*c', 'axxcyyb'))
  // normalização: aspas e espaços
  assert.ok(m('git commit -m "a b"', "git   commit -m 'a b'"))
  assert.ok(m("echo 'a b'", 'echo "a b"'))
  assert.ok(!m('echo a b', 'echo "a b"'), 'tokens diferentes')
  // * literal
  assert.ok(m('echo \\*', 'echo "*"'))
  assert.ok(!m('echo \\*', 'echo x'))
  assert.ok(m("echo '*'", "echo '*'"))
  // programa: basename só na blacklist
  assert.ok(!m('rm *', '/bin/rm -rf x'))
  assert.ok(m('rm *', '/bin/rm -rf x', { basenameProgram: true }))
  assert.ok(m('/bin/rm *', '/bin/rm x', { basenameProgram: true }))
  assert.ok(!m('ls *', './ls'))
})

test('padrões: validação e aviso de padrão amplo', () => {
  assert.equal(validateCommandPattern('git push *'), null)
  assert.match(validateCommandPattern('*')!, /qualquer/)
  assert.match(validateCommandPattern('  ')!, /vazio/)
  assert.match(validateCommandPattern('echo "a')!, /Aspas/)
  assert.match(broadPatternWarning('git *')!, /git push --force/)
  assert.equal(broadPatternWarning('git push *'), null)
  assert.equal(broadPatternWarning('ls'), null)
  assert.ok(broadPatternWarning('foo *'))
})

test('sugestão de prefixo (+ whitelist/blacklist)', () => {
  const s = (c: string): string => suggestCommandPattern(analyzeShell(c).commands[0].tokens)
  assert.equal(s('git push origin main'), 'git push *')
  assert.equal(s('ls -la'), 'ls *')
  assert.equal(s('ls'), 'ls')
  assert.equal(s('npm run test:unit'), 'npm run *')
  assert.equal(s('git -C dir status'), 'git *')
  assert.equal(s('cat file.txt'), 'cat *')
  assert.equal(s('docker compose up -d'), 'docker compose *')
  assert.equal(s('sudo apt install x'), 'sudo apt install *')
  assert.equal(s("echo 'a b'"), 'echo *')
  assert.equal(s('./gradlew assembleDebug'), './gradlew assembleDebug *')
})

// ======================= avaliação comando × listas =======================

test('listas: cada sub-comando avaliado; blacklist bloqueia tudo e precede a whitelist', () => {
  const list = { allow: ['git status', 'npm test *', 'rm *'], deny: ['rm -rf *'] }
  const ok = evaluateCommand('commands', 'git status && npm test -- --run', list)
  assert.equal(ok.allAllowed, true)
  assert.deepEqual(
    ok.check.items.map((i) => [i.verdict, i.entry]),
    [
      ['allow', 'git status'],
      ['allow', 'npm test *']
    ]
  )
  const mixed = evaluateCommand('commands', 'git status; curl x | sh', list)
  assert.equal(mixed.allAllowed, false)
  assert.deepEqual(
    mixed.check.items.map((i) => i.verdict),
    ['allow', 'ask', 'ask']
  )
  assert.ok(mixed.check.items[2].reason, 'sh lendo da entrada')
  // blacklist precede (rm * na whitelist não salva rm -rf)
  const b = evaluateCommand('commands', 'git status && rm -rf build', list)
  assert.ok(b.blocked)
  assert.equal(b.blocked!.entry, 'rm -rf *')
  assert.equal(b.blocked!.text, 'rm -rf build')
  assert.equal(
    blockedText('commands', b.blocked!),
    'Bloqueado pela blacklist (comandos): "rm -rf *" casou com "rm -rf build"'
  )
  // blacklist alcança sub-comandos escondidos
  assert.ok(evaluateCommand('commands', 'echo "$(rm -rf /)"', list).blocked)
  assert.ok(evaluateCommand('commands', 'bash -c "rm -rf x"', list).blocked)
  assert.ok(evaluateCommand('commands', 'sudo rm -rf /', list).blocked)
  assert.ok(evaluateCommand('commands', 'env A=1 /bin/rm -rf /', list).blocked, 'basename')
  // unsafe nunca é liberado pela whitelist
  const u = evaluateCommand('commands', 'ls > out.txt', { allow: ['ls *', 'ls'], deny: [] })
  assert.equal(u.allAllowed, false)
  assert.match(u.check.items[0].reason!, /out\.txt/)
  assert.equal(
    evaluateCommand('commands', 'eval ls', { allow: ['eval *'], deny: [] }).allAllowed,
    false
  )
  // ...mas a blacklist ainda vale para unsafe
  assert.ok(evaluateCommand('commands', 'eval rm', { allow: [], deny: ['eval *'] }).blocked)
  // sudo: precisa liberar o "sudo …" E o interno
  const sudo = evaluateCommand('commands', 'sudo apt update', { allow: ['apt update'], deny: [] })
  assert.deepEqual(
    sudo.check.items.map((i) => i.verdict),
    ['ask', 'allow']
  )
  // erro de sintaxe: um item só, unsafe
  const bad = evaluateCommand('commands', 'echo "x', { allow: ['echo *'], deny: [] })
  assert.equal(bad.check.items.length, 1)
  assert.equal(bad.allAllowed, false)
  // vazio → pergunta
  assert.equal(evaluateCommand('commands', '   ', { allow: [], deny: [] }).allAllowed, false)
})

test('listas: processos usam as listas próprias; busca não tem listas', () => {
  const lists = normalizeApprovalLists({
    commands: { allow: ['npm run dev *'], deny: [] },
    processes: { allow: [], deny: ['npm run dev *'] }
  })
  assert.ok(evaluateLists('processes', { command: 'npm run dev -- --port 3000' }, lists).blocked)
  assert.equal(
    evaluateLists('commands', { command: 'npm run dev -- --port 3000' }, lists).allAllowed,
    true
  )
  const s = evaluateLists('search', { query: 'x' }, lists)
  assert.equal(s.allAllowed, false)
  assert.equal(s.blocked, undefined)
})

// ======================= URLs =======================

test('URLs: normalização (esquema/host minúsculos, porta padrão, IDN → punycode)', () => {
  assert.equal(normalizeUrl('HTTPS://GitHub.COM:443/a')!.href, 'https://github.com/a')
  assert.equal(normalizeUrl('github.com/x')!.href, 'https://github.com/x')
  assert.equal(normalizeUrl('http://exemplo.com:80')!.href, 'http://exemplo.com/')
  assert.equal(normalizeUrl('https://münchen.de/')!.hostname, 'xn--mnchen-3ya.de')
  assert.equal(normalizeUrl('file:///etc/passwd'), null)
  assert.equal(normalizeUrl('javascript:alert(1)'), null)
})

test('URLs: domínio, *.subdomínio e prefixo de URL em fronteira de segmento', () => {
  const u = (s: string): URL => normalizeUrl(s)!
  assert.ok(matchUrlEntry('github.com', u('https://github.com/x')))
  assert.ok(matchUrlEntry('github.com', u('http://GITHUB.com')))
  assert.ok(!matchUrlEntry('github.com', u('https://api.github.com')), 'domínio exato')
  assert.ok(!matchUrlEntry('github.com', u('https://evilgithub.com')))
  assert.ok(!matchUrlEntry('github.com', u('https://github.com.evil.io')))
  assert.ok(matchUrlEntry('*.github.com', u('https://api.github.com')))
  assert.ok(matchUrlEntry('*.github.com', u('https://github.com')), '*. inclui o próprio domínio')
  assert.ok(!matchUrlEntry('*.github.com', u('https://notgithub.com')))
  assert.ok(matchUrlEntry('münchen.de', u('https://xn--mnchen-3ya.de/')), 'IDN na entrada')
  assert.ok(matchUrlEntry('localhost:3000', u('http://localhost:3000/a')))
  assert.ok(!matchUrlEntry('localhost:3000', u('http://localhost:4000/a')))
  // prefixo
  const p = 'https://github.com/ezenere/'
  assert.ok(matchUrlEntry(p, u('https://github.com/ezenere/clearchat')))
  assert.ok(matchUrlEntry(p, u('https://github.com/ezenere')))
  assert.ok(!matchUrlEntry(p, u('https://github.com/ezenere2/x')))
  assert.ok(!matchUrlEntry(p, u('http://github.com/ezenere/x')), 'esquema conta')
  assert.ok(!matchUrlEntry(p, u('https://gist.github.com/ezenere/x')))
  assert.ok(matchUrlEntry('https://github.com/ezenere', u('https://github.com/ezenere/x')))
  assert.ok(!matchUrlEntry('https://github.com/ezenere', u('https://github.com/ezenerex')))
  assert.ok(matchUrlEntry('HTTPS://GitHub.com:443/ezenere', u('https://github.com/ezenere')))
  // validação
  assert.equal(validateUrlEntry('github.com'), null)
  assert.equal(validateUrlEntry('*.github.com'), null)
  assert.equal(validateUrlEntry('https://github.com/a/'), null)
  assert.ok(validateUrlEntry('*'))
  assert.ok(validateUrlEntry('*.com'), 'curinga de TLD')
  assert.ok(validateUrlEntry('github.com/path'), 'caminho sem esquema')
  assert.ok(validateUrlEntry('ftp://x.com'))
})

test('URLs: blacklist precede; sugestão = domínio', () => {
  const list = { allow: ['*.github.com'], deny: ['https://github.com/evil/'] }
  const b = evaluateUrl('https://github.com/evil/repo', list)
  assert.ok(b.blocked)
  assert.equal(
    blockedText('pages', b.blocked!),
    'Bloqueado pela blacklist (páginas): "https://github.com/evil/" casou com "https://github.com/evil/repo"'
  )
  const a = evaluateUrl('api.github.com/x', list)
  assert.equal(a.allAllowed, true)
  const q = evaluateUrl('https://Example.org/a?b=1', list)
  assert.equal(q.allAllowed, false)
  assert.equal(q.check.items[0].suggestion, 'example.org')
  assert.equal(evaluateUrl('file:///x', list).check.items[0].reason, 'URL inválida ou não http(s)')
})

// ======================= modos / rota =======================

test('modos: padrão global, override do chat, normalização', () => {
  assert.deepEqual(DEFAULT_APPROVAL_MODES, {
    commands: 'lists',
    processes: 'lists',
    pages: 'lists',
    search: 'lists',
    writeFile: 'always',
    editFile: 'always',
    sendToChat: 'always',
    delegate: 'always'
  })
  assert.deepEqual(normalizeApprovalModes({ commands: 'always', pages: 'x' }), {
    ...DEFAULT_APPROVAL_MODES,
    commands: 'always'
  })
  assert.equal(effectiveMode({}, { commands: 'smart' }, 'commands'), 'smart')
  assert.equal(
    effectiveMode({ approvalModes: { commands: 'always' } }, { commands: 'smart' }, 'commands'),
    'always'
  )
  assert.equal(effectiveMode(null, null, 'pages'), 'lists')
  assert.ok(!CONFIRM_TOOLS.includes('process_stop'), 'process_stop nunca pede confirmação')
  assert.equal(approvalRoute({}, null, 'process_stop').kind, 'run')
  assert.equal(approvalRoute({ approvalModes: { commands: 'smart' } }, null, 'shell').kind, 'user')
  assert.equal(
    approvalRoute(
      {
        approvalModes: { commands: 'smart' },
        smartApprove: { providerId: 'p', model: 'j' } as any
      },
      null,
      'shell'
    ).kind,
    'judge'
  )
  assert.equal(approvalRoute({}, { pages: 'always' }, 'browse_url').kind, 'run')
})

// ======================= migração =======================

test('migração de config: autoApprove → always; smartApprove → smart; extras preservados', () => {
  const sa = { enabled: true, providerId: 'p', model: 'j' }
  // autoApprove completo (antigo "Auto-aprovar tudo")
  const a = migrateApprovalConfig({
    autoApprove: ['shell', 'process_start', 'process_stop', 'web_search', 'browse_url']
  } as any)
  assert.deepEqual(a.approvalModes, {
    commands: 'always',
    processes: 'always',
    pages: 'always',
    search: 'always'
  })
  assert.equal('autoApprove' in a, false)
  // smart com tools padrão (ausente = CONFIRM_TOOLS antigas) e shell em autoApprove
  const b = migrateApprovalConfig({ autoApprove: ['shell'], smartApprove: sa } as any)
  assert.deepEqual(b.approvalModes, {
    commands: 'always',
    processes: 'smart',
    search: 'smart',
    pages: 'smart'
  })
  assert.deepEqual(b.smartApprove!.tools, [])
  // smart com lista explícita + extras; extra em autoApprove sai do juiz
  const c = migrateApprovalConfig({
    autoApprove: ['edit_file'],
    smartApprove: { ...sa, tools: ['web_search', 'process_stop', 'write_file', 'edit_file'] }
  } as any)
  assert.deepEqual(c.approvalModes, { search: 'smart' })
  assert.deepEqual(c.smartApprove!.tools, ['write_file'])
  // smart desligado: não vira 'smart'
  const d = migrateApprovalConfig({
    autoApprove: [],
    smartApprove: { ...sa, enabled: false }
  } as any)
  assert.equal(d.approvalModes, undefined)
  // sem a chave autoApprove → mesmo objeto (alias de leitura idempotente)
  const same = { approvalModes: { commands: 'always' } } as any
  assert.equal(migrateApprovalConfig(same), same)
  assert.equal(migrateApprovalConfig(a), a)
  // override já existente vence
  const e = migrateApprovalConfig({
    autoApprove: ['shell'],
    approvalModes: { commands: 'lists' }
  } as any)
  assert.deepEqual(e.approvalModes, { commands: 'lists' })
  // personas: alias de leitura + campo novo em PRESET_FIELDS (autoApprove fora)
  assert.ok((PRESET_FIELDS as readonly string[]).includes('approvalModes'))
  assert.ok(!(PRESET_FIELDS as readonly string[]).includes('autoApprove'))
  assert.deepEqual(sanitizePresetConfig({ autoApprove: ['browse_url'] } as any), {
    approvalModes: { pages: 'always' }
  })
  assert.deepEqual(sanitizePresetConfig({ approvalModes: { commands: 'x', pages: 'smart' } }), {
    approvalModes: { pages: 'smart' }
  })
})

test('migração do banco: chats e personas, uma vez (flag)', () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chats (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    CREATE TABLE presets (id TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}');
  `)
  const insC = db.prepare('INSERT INTO chats VALUES (?, ?)')
  insC.run('c1', JSON.stringify({ model: 'm', autoApprove: ['shell', 'web_search'] }))
  insC.run('c2', JSON.stringify({ model: 'm', autoApprove: [] }))
  insC.run('c3', JSON.stringify({ model: 'm' }))
  // sem autoApprove mas com smartApprove antigo (tools ausente = todas as CONFIRM_TOOLS)
  insC.run('c4', JSON.stringify({ smartApprove: { enabled: true, providerId: 'p', model: 'j' } }))
  insC.run('c5', 'não é json')
  db.prepare('INSERT INTO presets VALUES (?, ?)').run(
    'p1',
    JSON.stringify({ autoApprove: ['browse_url'] })
  )
  const r = migrateApprovalModes(db)
  assert.deepEqual(r, { skipped: false, chats: 3, presets: 1 })
  const cfg = (t: string, id: string): any =>
    JSON.parse((db.prepare(`SELECT config_json FROM ${t} WHERE id = ?`).get(id) as any).config_json)
  assert.deepEqual(cfg('chats', 'c1').approvalModes, { commands: 'always', search: 'always' })
  assert.equal('autoApprove' in cfg('chats', 'c1'), false)
  assert.equal(cfg('chats', 'c2').approvalModes, undefined)
  assert.equal('autoApprove' in cfg('chats', 'c2'), false)
  assert.deepEqual(cfg('chats', 'c3'), { model: 'm' })
  assert.deepEqual(cfg('chats', 'c4').approvalModes, {
    commands: 'smart',
    processes: 'smart',
    search: 'smart',
    pages: 'smart'
  })
  assert.deepEqual(cfg('chats', 'c4').smartApprove.tools, [])
  assert.deepEqual(cfg('presets', 'p1').approvalModes, { pages: 'always' })
  assert.ok(
    db.prepare('SELECT value FROM settings WHERE key = ?').get(APPROVAL_MODES_MIGRATION_FLAG)
  )
  // segunda vez: nada (flag) — e mesmo sem a flag, rodar de novo não muda nada
  assert.equal(migrateApprovalModes(db).skipped, true)
  db.prepare('DELETE FROM settings').run()
  assert.deepEqual(migrateApprovalModes(db), { skipped: false, chats: 0, presets: 0 })
  db.close()
})

// ---- revisão de segurança: avaliação indireta (o VALOR de uma variável vira código) ----
test('parser: aritmética/indireção sobre variáveis sempre pergunta (bash/zsh executam $(…) do valor)', () => {
  const list = {
    allow: ['echo *', 'let *', '[[ *', 'declare *', 'typeset *', 'integer *'],
    deny: []
  }
  const ask = [
    "x='$(rm y)'; echo ${(e)x}", // zsh: ${(e)…} reavalia o valor
    'echo ${(P)x}',
    'echo ${~x}',
    'echo ${!x}',
    'echo $((x))', // bash: x='a[$(cmd)]' executa cmd
    'echo $[x]',
    'echo ${a[$x]}',
    'echo ${a[x]}',
    'let y=x',
    '[[ $x -eq 1 ]]',
    '[[ 1 -lt $y ]]',
    'declare -i y=x',
    'typeset -i y=x',
    'integer y=x'
  ]
  for (const c of ask) {
    const r = evaluateCommand('commands', c, list)
    assert.ok(!r.allAllowed && !r.blocked, `deveria perguntar: ${c}`)
  }
  // literais continuam liberáveis
  for (const c of [
    'echo $((1+2))',
    'echo $[1+2]',
    'echo ${a[1]}',
    'echo ${#x}',
    'echo ${x:-y}',
    'echo $x'
  ])
    assert.ok(evaluateCommand('commands', c, list).allAllowed, `deveria liberar: ${c}`)
})

// ======================= itens de arquivo/agentes + Smart-Approve por item (0.5) =======================

test('itens novos: write_file/edit_file/send_to_chat/delegate_task — padrão Sempre permitir', () => {
  for (const t of ['write_file', 'edit_file', 'send_to_chat', 'delegate_task'] as const)
    assert.equal(approvalRoute({}, null, t).kind, 'run', t)
  // global salvo antes dos itens novos existirem → os novos ficam no padrão (always)
  assert.equal(normalizeApprovalModes({ commands: 'always' }).writeFile, 'always')
  // Perguntar (lists sem listas) → pergunta simples, nunca o card de listas
  assert.equal(
    approvalRoute({ approvalModes: { writeFile: 'lists' } }, null, 'write_file').kind,
    'user'
  )
  assert.equal(approvalRoute({}, { delegate: 'lists' }, 'delegate_task').kind, 'user')
  assert.equal(modeLabel('editFile', 'lists'), 'Perguntar')
  assert.equal(modeLabel('search', 'lists'), 'Perguntar')
  assert.equal(modeLabel('commands', 'lists'), 'Listas')
  // smart: com modelo → juiz; sem modelo → usuário com aviso (fail-closed)
  const judge = { providerId: 'p', model: 'j' } as any
  assert.equal(
    approvalRoute(
      { approvalModes: { sendToChat: 'smart' }, smartApprove: judge },
      null,
      'send_to_chat'
    ).kind,
    'judge'
  )
  assert.deepEqual(approvalRoute({ approvalModes: { editFile: 'smart' } }, null, 'edit_file'), {
    kind: 'user',
    smartMissing: true
  })
  // leitura e afins nunca são itens
  for (const t of ['read_file', 'list_dir', 'process_stop', 'ask_user', 'read_history'] as const)
    assert.equal(approvalRoute({ smartApprove: judge }, { commands: 'smart' }, t).kind, 'run', t)
})

test('Smart-Approve sem liga/desliga: o juiz só decide itens em modo smart, se houver modelo', () => {
  const judge = { providerId: 'p', model: 'j' } as any
  // modelo escolhido mas nenhum item em smart → ninguém vai ao juiz
  assert.equal(approvalRoute({ smartApprove: judge }, null, 'shell').kind, 'lists')
  assert.equal(approvalRoute({ smartApprove: judge }, null, 'write_file').kind, 'run')
  // smart via global
  assert.equal(
    approvalRoute({ smartApprove: judge }, { pages: 'smart' }, 'browse_url').kind,
    'judge'
  )
  // `enabled: false` legado não desliga mais nada (a migração cuida dele)
  assert.equal(
    approvalRoute(
      { approvalModes: { commands: 'smart' }, smartApprove: { ...judge, enabled: false } },
      null,
      'shell'
    ).kind,
    'judge'
  )
  // modelo removido → pergunta (smartMissing)
  assert.equal(
    (
      approvalRoute(
        { approvalModes: { commands: 'smart' }, smartApprove: { ...judge, model: '' } },
        null,
        'shell'
      ) as any
    ).smartMissing,
    true
  )
})

test('migração Smart-Approve ≤ 0.4.0: enabled/tools → modos por item (idempotente)', () => {
  const sa = { providerId: 'p', model: 'j', labels: { approve: 'A', reject: 'R', ask: 'K' } }
  // ligado com modelo: smart continua; extras viram itens em smart; chaves legadas somem
  const a = migrateSmartApproveConfig({
    approvalModes: { commands: 'smart', pages: 'always' },
    smartApprove: { ...sa, enabled: true, tools: ['write_file', 'delegate_task', 'shell'] }
  } as any)
  assert.deepEqual(a.approvalModes, {
    commands: 'smart',
    pages: 'always',
    writeFile: 'smart',
    delegate: 'smart'
  })
  assert.deepEqual(a.smartApprove, sa)
  // idempotente: sem enabled/tools → MESMO objeto
  assert.equal(migrateSmartApproveConfig(a), a)
  const plain = { smartApprove: sa } as any
  assert.equal(migrateSmartApproveConfig(plain), plain)
  // desligado COM modelo: o que era smart (chat ou global) perguntava → lists; extras não viram smart
  const b = migrateSmartApproveConfig(
    {
      approvalModes: { commands: 'smart' },
      smartApprove: { ...sa, enabled: false, tools: ['edit_file'] }
    } as any,
    { globalModes: { pages: 'smart', search: 'always' } }
  )
  assert.deepEqual(b.approvalModes, { commands: 'lists', pages: 'lists' })
  assert.equal('enabled' in b.smartApprove!, false)
  assert.equal('tools' in b.smartApprove!, false)
  // globalModes também pode ser uma função (lida só quando precisa)
  let calls = 0
  const g = (): any => (calls++, { processes: 'smart' })
  migrateSmartApproveConfig({ smartApprove: sa } as any, { globalModes: g })
  assert.equal(calls, 0, 'config nova não lê o global')
  const c = migrateSmartApproveConfig({ smartApprove: { ...sa, enabled: false } } as any, {
    globalModes: g
  })
  assert.deepEqual(c.approvalModes, { processes: 'lists' })
  // ligado SEM modelo (juiz inativo) e sem modelo: nada muda — smart sem modelo já pergunta
  const d = migrateSmartApproveConfig({
    approvalModes: { commands: 'smart' },
    smartApprove: { enabled: true, providerId: null, model: null, tools: ['write_file'] }
  } as any)
  assert.deepEqual(d.approvalModes, { commands: 'smart' })
  assert.deepEqual(d.smartApprove, { providerId: null, model: null })
  // override existente vence nos extras
  const e = migrateSmartApproveConfig({
    approvalModes: { writeFile: 'lists' },
    smartApprove: { ...sa, enabled: true, tools: ['write_file'] }
  } as any)
  assert.deepEqual(e.approvalModes, { writeFile: 'lists' })
  // cadeia completa a partir do ≤ 0.3.0: autoApprove + smart antigo (tools ausente = todas)
  const f = migrateLegacyApprovals(
    { autoApprove: ['shell'], smartApprove: { ...sa, enabled: true } } as any,
    { assumeLegacy: true }
  )
  assert.deepEqual(f.approvalModes, {
    commands: 'always',
    processes: 'smart',
    search: 'smart',
    pages: 'smart'
  })
  assert.deepEqual(f.smartApprove, sa)
  assert.equal(migrateLegacyApprovals(f, { assumeLegacy: true }), f)
  // personas: alias de leitura (sem global) no sanitize
  assert.deepEqual(
    sanitizePresetConfig({
      smartApprove: { ...sa, enabled: true, tools: ['send_to_chat'] }
    } as any),
    { smartApprove: sa, approvalModes: { sendToChat: 'smart' } }
  )
})

test('migração do banco (Smart-Approve por item): chats + personas, com o global, uma vez', () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chats (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    CREATE TABLE presets (id TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}');
  `)
  db.prepare('INSERT INTO settings VALUES (?, ?)').run(
    'approvalModes',
    JSON.stringify({ commands: 'smart', processes: 'lists', pages: 'lists', search: 'lists' })
  )
  const sa = { providerId: 'p', model: 'j', contextMessages: 6 }
  const insC = db.prepare('INSERT INTO chats VALUES (?, ?)')
  insC.run('on', JSON.stringify({ smartApprove: { ...sa, enabled: true, tools: ['edit_file'] } }))
  insC.run('off', JSON.stringify({ smartApprove: { ...sa, enabled: false, tools: ['edit_file'] } }))
  insC.run(
    'nomodel',
    JSON.stringify({ smartApprove: { enabled: false, providerId: null, model: null, tools: [] } })
  )
  insC.run('new', JSON.stringify({ smartApprove: sa }))
  insC.run('none', JSON.stringify({ model: 'm' }))
  db.prepare('INSERT INTO presets VALUES (?, ?)').run(
    'p1',
    JSON.stringify({ approvalModes: { search: 'smart' }, smartApprove: { ...sa, enabled: false } })
  )
  const r = migrateSmartApproveItems(db)
  assert.deepEqual(r, { skipped: false, chats: 3, presets: 1 })
  const cfg = (t: string, id: string): any =>
    JSON.parse((db.prepare(`SELECT config_json FROM ${t} WHERE id = ?`).get(id) as any).config_json)
  assert.deepEqual(cfg('chats', 'on'), { smartApprove: sa, approvalModes: { editFile: 'smart' } })
  // desligado com modelo: Comandos (smart pelo global) perguntava → lists neste chat
  assert.deepEqual(cfg('chats', 'off'), { smartApprove: sa, approvalModes: { commands: 'lists' } })
  assert.deepEqual(cfg('chats', 'nomodel'), { smartApprove: { providerId: null, model: null } })
  assert.deepEqual(cfg('chats', 'new'), { smartApprove: sa })
  assert.deepEqual(cfg('presets', 'p1'), {
    approvalModes: { search: 'lists', commands: 'lists' },
    smartApprove: sa
  })
  assert.ok(
    db.prepare('SELECT value FROM settings WHERE key = ?').get(SMART_APPROVE_ITEMS_MIGRATION_FLAG)
  )
  assert.equal(migrateSmartApproveItems(db).skipped, true)
  db.prepare('DELETE FROM settings').run()
  assert.deepEqual(migrateSmartApproveItems(db), { skipped: false, chats: 0, presets: 0 })
  db.close()
})

test('★ padrão global: escolher a opção do global = sem override (segue o global); outra = override', () => {
  const global = { commands: 'lists', writeFile: 'always' } as const
  // sem override → efetivo = global (a opção com ★ aparece selecionada)
  assert.equal(effectiveMode({}, global, 'commands'), 'lists')
  // escolher outra opção grava override
  const a = withChatMode({}, 'commands', 'always', global)
  assert.deepEqual(a, { commands: 'always' })
  // escolher a opção com ★ remove o override (não grava 'lists')
  assert.deepEqual(withChatMode(a, 'commands', 'lists', global), {})
  // override igual ao global (ex.: global mudou depois) → clicar nele vira "segue o global"
  assert.deepEqual(
    withChatMode({ writeFile: 'always', editFile: 'smart' }, 'writeFile', 'always', global),
    {
      editFile: 'smart'
    }
  )
  // sem global salvo → DEFAULT_APPROVAL_MODES é o padrão (★)
  assert.deepEqual(withChatMode({}, 'delegate', 'always', null), {})
  assert.deepEqual(withChatMode({}, 'delegate', 'lists', null), { delegate: 'lists' })
  // null = voltar ao global; entrada não é mutada
  const src = { pages: 'smart' } as const
  assert.deepEqual(withChatMode(src, 'pages', null, global), {})
  assert.deepEqual(src, { pages: 'smart' })
  // seguindo o global, o chat acompanha quando o global muda
  assert.equal(effectiveMode({}, { ...global, commands: 'always' }, 'commands'), 'always')
})
