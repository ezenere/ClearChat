// Análise CONSERVADORA de uma linha de comando (zsh/bash) para o modo "Listas" das aprovações.
// Não executa nada e não expande nada: só desmonta o texto em SUB-COMANDOS, cada um avaliado
// separadamente contra a whitelist/blacklist (ver approvalPolicy.ts e SPEC.md → "Aprovações").
//
// Princípio: na dúvida, PERGUNTA. Tudo o que o parser não entende com segurança vira um
// sub-comando com `unsafe` (motivo) — nunca liberado automaticamente pela whitelist (a blacklist
// continua valendo). Erro de sintaxe (aspas abertas, parênteses sem par…) → um item só com o texto
// inteiro e `unsafe`.
//
// O que é desmontado:
// - separadores `|`, `|&`, `||`, `&&`, `;`, `&`, quebras de linha; grupos `( … )` e `{ …; }`;
// - `$( … )`, crases e `<( … )`/`>( … )` (o interno vira sub-comandos extras; process substitution
//   também marca o comando que a usa como `unsafe`);
// - comandos que executam OUTRO código (tabela única `WRAPPERS`, mais abaixo), recursivamente (até
//   MAX_WRAPS camadas): `ssh host 'cmd'` (o comando remoto é analisado como script — também heredoc
//   e `bash -s`), `sudo`/`doas`/`su -c`, `docker|podman exec`, `docker compose exec`,
//   `kubectl exec … --`, `bash|sh|zsh… -c "…"` (e script vindo de heredoc), `xargs`, `watch`,
//   `script -c`, e os prefixos transparentes `env`, `nice`, `ionice`, `time`, `nohup`, `command`,
//   `exec`, `builtin`, `timeout`, `stdbuf`. ssh/sudo/su/docker/kubectl ganham um item PRÓPRIO
//   (a conexão / a elevação / o container) e os internos ficam um nível abaixo (`depth`, `group`);
// - atribuições `VAR=v cmd` (avalia `cmd`; variáveis perigosas como PATH, LD_PRELOAD → `unsafe`);
// - palavras reservadas simples (`if/then/else/elif/fi/while/until/do/done/!/{/}`) são puladas e o
//   cabeçalho de `for/select NAME in …` não é comando.
// Sempre `unsafe`: eval, source/., find -exec/-execdir/-ok/-okdir, fd -x/-X, alias, function/
// definição `f() …`, trap, fc, coproc, parallel, case, process substitution, heredoc que
// alimenta algo que não seja um consumidor de dados conhecido (cat, grep…) ou com substituição no
// corpo, redirecionamento de saída para arquivo (≠ /dev/null, /dev/stdout, /dev/stderr, &N),
// nome de comando vindo de expansão/glob (`$x args`, `./r*`), expansão de chaves `{a,b}` em
// qualquer palavra, `=cmd` do zsh, glob qualifiers/
// extglob `*(…)`, substituição dentro de `$(( … ))`, script embutido que não dá para ver (vem de
// expansão local, da entrada, aninhado demais, grande demais).

export interface ShellCommand {
  /** Palavras do comando avaliado, sem aspas (redirecionamentos/atribuições/prefixos removidos). */
  tokens: string[]
  /** Texto para exibição: as palavras como escritas (aspas preservadas), espaços colapsados. */
  text: string
  /** Contexto: "dentro de $(…)", "via bash -c", "via env"… */
  note?: string
  /** Motivo pelo qual NUNCA é liberado automaticamente (sempre pergunta). */
  unsafe?: string
  /** Nível na árvore (0 = linha de comando; internos de ssh/sudo/docker exec… = +1 por camada). */
  depth?: number
  /** Onde/como roda (internos): "no servidor deploy@host (via ssh)", "via sudo", "no container web (docker exec)". */
  group?: string
  /**
   * Tokens comparados com as listas quando diferem de `tokens` — item próprio de ssh/docker exec/
   * kubectl exec: só programa + opções relevantes + destino (o comando interno é avaliado à parte).
   */
  match?: string[]
  /** Item próprio de um wrapper: conexão ssh, elevação (sudo/doas/su) ou container (docker/kubectl exec). */
  role?: 'ssh' | 'elevate' | 'container'
  /**
   * Destinos de redirecionamento de SAÍDA para arquivo (`> f`, `>> f`, `&> f`…; sem aspas, como o
   * shell veria — expansões ficam literais). Usado pela detecção de caminhos protegidos
   * (approvalSafety.ts); esses itens já são `unsafe`.
   */
  writes?: string[]
}

export interface ShellAnalysis {
  commands: ShellCommand[]
  /** Erro de sintaxe (aí `commands` tem um item só, com o texto inteiro e `unsafe`). */
  error?: string
}

/** Argumentos que o xargs lê da entrada (no lugar deles no comando interno). */
export const INPUT_TOKEN = '…'
/** Camadas de wrappers que executam código (ssh, sudo, bash -c, docker exec…) analisadas. */
export const MAX_WRAPS = 4
/** Tamanho máximo de um script embutido (comando remoto, bash -c, heredoc) para analisar. */
export const MAX_SCRIPT = 20_000

interface Word {
  /** Valor sem aspas (expansões ficam literais, ex. `$HOME`). */
  value: string
  /** Como foi escrito. */
  raw: string
  quoted: boolean
  /** Contém $…, ${…}, $(…) ou crase. */
  expansion: boolean
  /** Contém * ? [ fora de aspas. */
  glob: boolean
  /**
   * Avaliação indireta: o VALOR de uma variável pode ser executado como código — aritmética com
   * nome de variável (`$((x))`, `$[x]`, subscritos `${a[$i]}`: bash/zsh avaliam `x` recursivamente,
   * e `a[$(cmd)]` dentro dele executa), flags do zsh `${(e)x}` / `${(P)x}` / `${~x}`.
   */
  indirect?: string
  /** Motivo de insegurança encontrado dentro da palavra (ex.: glob qualifier). */
  unsafe?: string
}

type Tok =
  | { t: 'word'; w: Word }
  | { t: 'op'; op: string }
  | { t: 'redir'; op: string; fd: string }
  | { t: 'eof' }

class ParseError extends Error {}

/** Programas que leem dados (não comandos) do stdin — heredoc para eles é aceitável. */
const HEREDOC_DATA = new Set([
  'cat',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'wc',
  'head',
  'tail',
  'sort',
  'uniq',
  'tr',
  'cut',
  'less',
  'more',
  'jq',
  'base64',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'diff',
  'column',
  'fold',
  'nl',
  'rev',
  'tac',
  'yq',
  'pbcopy',
  'xclip',
  'wl-copy'
])

/** Comandos que não leem a entrada — um heredoc para eles não executa nada. */
const NO_STDIN = new Set([
  'cd',
  'pwd',
  'echo',
  'printf',
  'mkdir',
  'true',
  'false',
  'test',
  '[',
  'sleep',
  'ls',
  'which',
  'whoami',
  'hostname',
  'date',
  'id',
  'uname',
  'umask',
  'set'
])

const ALWAYS_UNSAFE: Record<string, string> = {
  let: 'let avalia aritmética (o valor de uma variável pode executar código)',
  eval: 'eval executa texto arbitrário',
  source: 'source executa um arquivo de comandos',
  '.': '. (source) executa um arquivo de comandos',
  alias: 'define um alias',
  function: 'define uma função',
  trap: 'trap registra comandos para depois',
  fc: 'fc reexecuta comandos do histórico',
  coproc: 'coproc',
  parallel: 'parallel executa comandos montados a partir da entrada',
  case: 'case … esac não é analisado',
  select: 'select não é analisado',
  enable: 'enable troca builtins',
  autoload: 'autoload carrega funções',
  zmodload: 'zmodload carrega módulos do zsh',
  emulate: 'emulate muda o modo do shell'
}

/** Variáveis que mudam QUAL programa roda ou injetam código. */
const DANGEROUS_VARS =
  /^(PATH|LD_\w+|DYLD_\w+|BASH_ENV|ENV|ZDOTDIR|IFS|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|GIT_\w*(SSH|EXEC|EDITOR|PAGER|ASKPASS|CONFIG)\w*|EDITOR|VISUAL|PAGER|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|LESSOPEN|LESSCLOSE|MANPAGER|SUDO_ASKPASS|SSH_ASKPASS|FPATH|CDPATH|HOME|TMPDIR|NODE_PATH)$/

/** Builtins que definem variáveis (export PATH=… muda os comandos seguintes). */
const DECLARE = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'integer', 'float'])

const RESERVED_SKIP = new Set(['!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', '{'])
const RESERVED_END = new Set(['fi', 'done', '}', 'esac'])

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/

const baseName = (s: string): string => s.slice(s.lastIndexOf('/') + 1)

const SAFE_REDIR_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

/** Palavra precisa de aspas para ser lida de volta como o mesmo token? */
export function shellQuote(token: string): string {
  if (token === '') return "''"
  if (token === INPUT_TOKEN) return token
  if (/^[A-Za-z0-9_@%+=:,./~^-]+$/.test(token)) return token
  return `'${token.replace(/'/g, `'\\''`)}'`
}

class Parser {
  pos = 0
  out: ShellCommand[] = []
  notes: string[] = []
  /** Nível na árvore e grupo dos itens deste parser (script embutido: o do wrapper). */
  level = 0
  group: string | undefined
  /** Camadas de wrappers já atravessadas (MAX_WRAPS). */
  wraps = 0
  /** Entrada herdada pelos comandos deste script (ex.: o heredoc de `ssh host bash -s <<EOF`). */
  stdin: Stdin | undefined
  private heredocs: {
    delim: string
    strip: boolean
    quoted: boolean
    cmd: Pending
    st: HeredocIn
  }[] = []
  private depth: number
  private src: string

  constructor(src: string, depth = 0) {
    this.src = src
    this.depth = depth
    if (depth > 8) throw new ParseError('aninhamento profundo demais')
  }

  private get note(): string | undefined {
    return this.notes.length ? this.notes[this.notes.length - 1] : undefined
  }

  private peek(o = 0): string {
    return this.src[this.pos + o] ?? ''
  }

  // ---------------- lexer ----------------

  /** Pula espaços, continuações de linha e comentários (não quebras de linha). */
  private skipBlank(): void {
    for (;;) {
      const c = this.peek()
      if (c === ' ' || c === '\t' || c === '\r') this.pos++
      else if (c === '\\' && this.peek(1) === '\n') this.pos += 2
      else if (c === '#') {
        while (this.pos < this.src.length && this.peek() !== '\n') this.pos++
      } else return
    }
  }

  private next(): Tok {
    this.skipBlank()
    if (this.pos >= this.src.length) return { t: 'eof' }
    const c = this.peek()
    if (c === '\n') {
      this.pos++
      this.readHeredocBodies()
      return { t: 'op', op: '\n' }
    }
    // process substitution <( … ) / >( … ) é uma PALAVRA (argumento)
    if ((c === '<' || c === '>') && this.peek(1) === '(') return { t: 'word', w: this.readWord() }
    for (const op of [';;&', ';;', ';&', ';|', '||', '|&', '&&', '&>>', '&>']) {
      if (this.src.startsWith(op, this.pos)) {
        this.pos += op.length
        return op.startsWith('&>') ? { t: 'redir', op, fd: '' } : { t: 'op', op }
      }
    }
    if ('|&;()'.includes(c)) {
      this.pos++
      return { t: 'op', op: c }
    }
    if (c === '<' || c === '>') return this.readRedir('')
    const w = this.readWord()
    // fd numérico colado: 2>…  / 1>&2
    if (/^\d+$/.test(w.raw) && (this.peek() === '<' || this.peek() === '>')) {
      if (this.peek(1) !== '(') return this.readRedir(w.raw)
    }
    return { t: 'word', w }
  }

  private readRedir(fd: string): Tok {
    for (const op of ['<<<', '<<-', '<<', '<&', '<>', '>>', '>&', '>|', '<', '>']) {
      if (this.src.startsWith(op, this.pos)) {
        this.pos += op.length
        return { t: 'redir', op, fd }
      }
    }
    throw new ParseError('redirecionamento inválido')
  }

  /** Lê uma palavra (com aspas, escapes e substituições — estas são analisadas na hora). */
  private readWord(): Word {
    const w: Word = { value: '', raw: '', quoted: false, expansion: false, glob: false }
    const start = this.pos
    for (;;) {
      if (this.pos >= this.src.length) break
      const c = this.peek()
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ';' || c === '|') break
      if (c === '&') break
      if (c === '<' || c === '>') {
        if (this.peek(1) === '(') {
          // <( … ) / >( … ): analisa o interno; o comando que a usa nunca é auto-aprovado
          this.pos += 2
          this.sub('dentro de ' + c + '(…)', ')')
          w.expansion = true
          w.unsafe = `process substitution ${c}(…)`
          w.value += `${c}(…)`
          continue
        }
        break
      }
      if (c === ')') break
      if (c === '(') {
        if (this.pos === start) break
        // `nome()` = definição de função: o parser trata
        if (/^\(\s*\)/.test(this.src.slice(this.pos))) break
        // `*(…)` (glob qualifier do zsh — pode executar código) / extglob `@(…)`
        w.unsafe = 'glob qualifier/extglob com parênteses'
        this.skipBalanced('(', ')')
        w.glob = true
        continue
      }
      if (c === '\\') {
        if (this.peek(1) === '\n') {
          this.pos += 2
          continue
        }
        if (this.pos + 1 >= this.src.length) throw new ParseError('barra invertida no fim')
        w.value += this.peek(1)
        w.quoted = true
        this.pos += 2
        continue
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1)
        if (end < 0) throw new ParseError('aspas simples sem fechamento')
        w.value += this.src.slice(this.pos + 1, end)
        w.quoted = true
        this.pos = end + 1
        continue
      }
      if (c === '"') {
        this.pos++
        w.value += this.readDouble(w)
        w.quoted = true
        continue
      }
      if (c === '`') {
        this.readBacktick()
        w.expansion = true
        w.value += '`…`'
        continue
      }
      if (c === '$') {
        w.value += this.readDollar(w)
        continue
      }
      // expansão de chaves {a,b} / {1..3}: muda as palavras (`{rm,-rf,x}` = `rm -rf x`)
      if (c === '{' && /^\{[^\s{}]*(,|\.\.)[^\s{}]*\}/.test(this.src.slice(this.pos))) {
        w.glob = true
        w.unsafe = 'expansão de chaves {…,…}'
      }
      if (c === '*' || c === '?') w.glob = true
      // `[` só é glob com um `]` adiante na mesma palavra (`[` e `[[` sozinhos são comandos)
      if (c === '[' && /^\[[^\s;|&<>()]*\]/.test(this.src.slice(this.pos))) w.glob = true
      w.value += c
      this.pos++
    }
    w.raw = this.src.slice(start, this.pos)
    return w
  }

  /** Conteúdo entre aspas duplas (abre já consumido). */
  private readDouble(w: Word): string {
    let v = ''
    for (;;) {
      if (this.pos >= this.src.length) throw new ParseError('aspas duplas sem fechamento')
      const c = this.peek()
      if (c === '"') {
        this.pos++
        return v
      }
      if (c === '\\') {
        const n = this.peek(1)
        if (n === '\n') this.pos += 2
        else if ('$`"\\'.includes(n) && n !== '') {
          v += n
          this.pos += 2
        } else {
          v += c
          this.pos++
        }
        continue
      }
      if (c === '`') {
        this.readBacktick()
        w.expansion = true
        v += '`…`'
        continue
      }
      if (c === '$') {
        v += this.readDollar(w)
        continue
      }
      v += c
      this.pos++
    }
  }

  /** `$…`: variável, ${…}, $(…), $((…)), $'…', $"…". Retorna o texto literal para o token. */
  private readDollar(w: Word): string {
    const start = this.pos
    const n = this.peek(1)
    if (n === '[') {
      // $[ … ]: aritmética antiga (bash/zsh) — mesma regra de $(( … ))
      this.pos += 1
      const s0 = this.pos
      this.skipBalanced('[', ']')
      const inner = this.src.slice(s0, this.pos)
      if (/\$\(|`/.test(inner))
        this.out.push({
          tokens: [inner],
          text: this.src.slice(start, this.pos),
          unsafe: 'substituição de comando dentro de $[ … ]',
          ...(this.note ? { note: this.note } : {})
        })
      if (/[A-Za-z_]/.test(inner))
        w.indirect = 'aritmética com variável pode executar código ($[x] avalia o valor de x)'
      w.expansion = true
      return this.src.slice(start, this.pos)
    }
    if (n === '(' && this.peek(2) === '(') {
      // aritmética: só aceitável sem substituições dentro
      this.pos += 1
      const s = this.pos
      this.skipBalanced('(', ')')
      const inner = this.src.slice(s, this.pos)
      if (/\$\(|`/.test(inner)) {
        this.out.push({
          tokens: [inner],
          text: this.src.slice(start, this.pos),
          unsafe: 'substituição de comando dentro de $(( … ))',
          ...(this.note ? { note: this.note } : {})
        })
      }
      if (/[A-Za-z_]/.test(inner))
        w.indirect = 'aritmética com variável pode executar código ($((x)) avalia o valor de x)'
      w.expansion = true
      return this.src.slice(start, this.pos)
    }
    if (n === '(') {
      this.pos += 2
      this.sub('dentro de $(…)', ')')
      w.expansion = true
      return '$(…)'
    }
    if (n === '{') {
      this.pos += 2
      let depth = 1
      while (depth > 0) {
        if (this.pos >= this.src.length) throw new ParseError('${ sem fechamento')
        const c = this.peek()
        if (c === '\\') this.pos += 2
        else if (c === "'") {
          const end = this.src.indexOf("'", this.pos + 1)
          if (end < 0) throw new ParseError('aspas simples sem fechamento')
          this.pos = end + 1
        } else if (c === '"') {
          this.pos++
          this.readDouble(w)
        } else if (c === '`') this.readBacktick()
        else if (c === '$') this.readDollar(w)
        else {
          if (c === '{') depth++
          else if (c === '}') depth--
          this.pos++
        }
      }
      const body = this.src.slice(start + 2, this.pos - 1)
      if (/^\([^)]*[ePI%gq#~][^)]*\)/.test(body) || /^[~=^]/.test(body) || /^!/.test(body))
        w.indirect = 'flag/indireção de expansão do zsh/bash (${(e)…}, ${(P)…}, ${~…}, ${!…})'
      else if (/\[[^\]]*[A-Za-z_$`][^\]]*\]/.test(body))
        w.indirect = 'subscrito com variável é avaliado como aritmética (pode executar código)'
      w.expansion = true
      return this.src.slice(start, this.pos)
    }
    if (n === "'") {
      // ANSI-C: $'…' (\' escapa a aspa)
      this.pos += 2
      let v = ''
      for (;;) {
        if (this.pos >= this.src.length) throw new ParseError("$' sem fechamento")
        const c = this.peek()
        if (c === "'") {
          this.pos++
          break
        }
        if (c === '\\') {
          const e = this.peek(1)
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            "'": "'",
            '"': '"',
            a: '\x07',
            e: '\x1b',
            '0': '\0'
          }
          if (e in map) {
            v += map[e]
            this.pos += 2
          } else if (e === 'x' && /^[0-9a-fA-F]{1,2}/.test(this.src.slice(this.pos + 2))) {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(this.src.slice(this.pos + 2))![0]
            v += String.fromCharCode(parseInt(hex, 16))
            this.pos += 2 + hex.length
          } else {
            v += e
            this.pos += 2
          }
          continue
        }
        v += c
        this.pos++
      }
      w.quoted = true
      return v
    }
    if (n === '"') {
      this.pos += 2
      w.quoted = true
      return this.readDouble(w)
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9@*#?$!-]/.exec(this.src.slice(this.pos + 1))
    if (m) {
      this.pos += 1 + m[0].length
      w.expansion = true
      return '$' + m[0]
    }
    this.pos++
    return '$'
  }

  /** Crase: o conteúdo (com \` \\ \$ desescapados) é analisado como linha de comando. */
  private readBacktick(): void {
    this.pos++
    let inner = ''
    for (;;) {
      if (this.pos >= this.src.length) throw new ParseError('crase sem fechamento')
      const c = this.peek()
      if (c === '`') {
        this.pos++
        break
      }
      if (c === '\\' && '`\\$'.includes(this.peek(1)) && this.peek(1) !== '') {
        inner += this.peek(1)
        this.pos += 2
        continue
      }
      inner += c
      this.pos++
    }
    const p = new Parser(inner, this.depth + 1)
    p.notes = ['dentro de `…`']
    p.level = this.level
    p.group = this.group
    p.wraps = this.wraps
    p.parseList(null)
    this.out.push(...p.out)
  }

  /** Pula um grupo balanceado (abre em this.pos), respeitando aspas. */
  private skipBalanced(open: string, close: string): void {
    let depth = 0
    for (;;) {
      if (this.pos >= this.src.length) throw new ParseError(`${open} sem ${close}`)
      const c = this.peek()
      if (c === '\\') {
        this.pos += 2
        continue
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1)
        if (end < 0) throw new ParseError('aspas simples sem fechamento')
        this.pos = end + 1
        continue
      }
      if (c === '"') {
        this.pos++
        this.readDouble({ value: '', raw: '', quoted: true, expansion: false, glob: false })
        continue
      }
      if (c === open) depth++
      else if (c === close) depth--
      this.pos++
      if (depth === 0) return
    }
  }

  /** Analisa até `close` (já depois da abertura) com uma nota de contexto. */
  private sub(note: string, close: ')'): void {
    this.notes.push(note)
    try {
      this.parseList(close)
    } finally {
      this.notes.pop()
    }
  }

  private readHeredocBodies(): void {
    const list = this.heredocs
    this.heredocs = []
    for (const h of list) {
      let found = false
      const lines: string[] = []
      while (this.pos < this.src.length) {
        const nl = this.src.indexOf('\n', this.pos)
        const end = nl < 0 ? this.src.length : nl
        let line = this.src.slice(this.pos, end)
        this.pos = nl < 0 ? end : end + 1
        if (h.strip) line = line.replace(/^\t+/, '')
        if (line === h.delim) {
          found = true
          break
        }
        lines.push(line)
      }
      if (!found) throw new ParseError(`heredoc sem o delimitador ${h.delim}`)
      if (!h.quoted && /\$\(|`/.test(lines.join('\n'))) {
        const why = 'heredoc com substituição de comando no corpo'
        h.cmd.unsafe.push(why)
        // o comando já pode ter sido fechado (ex.: `cat <<EOF | x`): marca o que ele emitiu
        for (const c of h.cmd.emitted ?? []) c.unsafe = c.unsafe ? `${c.unsafe}; ${why}` : why
      }
      // corpo como o programa o recebe (sem aspas no delimitador: \$ \` \\ desescapados; $… local)
      const body = lines.length ? lines.join('\n') + '\n' : ''
      const t = h.quoted ? { text: body } : heredocText(body)
      h.st.body = t.text
      if (t.local) h.st.local = t.local
      const waiters = h.st.waiters ?? []
      h.st.waiters = undefined
      // quem lê o heredoc como script e já foi fechado (`ssh h <<EOF | tee x`) analisa agora
      for (const f of waiters) f()
    }
  }

  // ---------------- parser ----------------

  /** Lista de comandos até `close` (consumido) ou o fim. */
  parseList(close: ')' | null): void {
    let cmd = newPending()
    for (;;) {
      const tok = this.next()
      if (tok.t === 'eof') {
        if (this.heredocs.length) this.readHeredocBodies()
        if (close) throw new ParseError(`falta "${close}"`)
        this.finish(cmd)
        return
      }
      if (tok.t === 'word') {
        cmd.words.push(tok.w)
        continue
      }
      if (tok.t === 'redir') {
        this.redirect(cmd, tok)
        continue
      }
      const op = tok.op
      if (op === ')') {
        if (close !== ')') throw new ParseError('")" sem "("')
        this.finish(cmd)
        return
      }
      if (op === '(') {
        if (cmd.words.length) {
          // `nome() …` = definição de função
          this.skipBlank()
          if (this.peek() === ')') {
            this.pos++
            // a definição vira um sub-comando inseguro; o corpo é analisado como comandos
            cmd.unsafe.push('define uma função')
            this.finish(cmd)
            cmd = newPending()
            continue
          }
          throw new ParseError('"(" inesperado')
        }
        this.finish(cmd)
        cmd = newPending()
        this.notes.push(this.note ?? '')
        try {
          this.parseList(')')
        } finally {
          this.notes.pop()
        }
        continue
      }
      if (op.startsWith(';;') || op === ';&' || op === ';|')
        throw new ParseError(`"${op}" (case) não é analisado`)
      // separadores: | |& || && ; & \n
      this.finish(cmd)
      cmd = newPending()
      if (op === '|' || op === '|&') cmd.stdin = { kind: 'pipe' }
    }
  }

  private redirect(cmd: Pending, tok: { op: string; fd: string }): void {
    const target = this.next()
    if (target.t !== 'word') throw new ParseError(`redirecionamento "${tok.op}" sem destino`)
    const w = target.w
    cmd.redirs.push(`${tok.fd}${tok.op}${w.raw}`)
    if (w.unsafe) cmd.unsafe.push(w.unsafe)
    const op = tok.op
    const toStdin = tok.fd === '' || tok.fd === '0'
    if (op === '<<' || op === '<<-') {
      cmd.heredoc = true
      const st: HeredocIn = { kind: 'heredoc' }
      if (toStdin) cmd.stdin = st
      this.heredocs.push({ delim: w.value, strip: op === '<<-', quoted: w.quoted, cmd, st })
      return
    }
    if (op === '<<<') {
      if (toStdin) cmd.stdin = { kind: 'herestring' }
      return
    }
    if (op === '<' || op === '<&') {
      if (toStdin && !(op === '<&' && (w.value === '-' || w.value === '0')))
        cmd.stdin = { kind: 'file' }
      return
    }
    // saída: > >> >| <> &> &>> >&
    if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(w.value)) return
    if (SAFE_REDIR_TARGETS.has(w.value) && !w.expansion) return
    cmd.unsafe.push(`redireciona para arquivo: ${w.raw}`)
    ;(cmd.writes ??= []).push(w.value)
  }

  /** Contexto dos itens emitidos agora (nível, grupo, nota, camadas). */
  private ctx(): Ctx {
    return { depth: this.level, group: this.group, note: this.note, wraps: this.wraps }
  }

  /** Emite um sub-comando com os motivos do comando (redirecionamentos…) e das palavras. */
  private emit(
    cmd: Pending,
    ws: Word[],
    extra: string[],
    ctx: Ctx,
    o: { match?: string[]; role?: ShellCommand['role']; note?: string } = {}
  ): ShellCommand {
    const unsafe = [
      ...cmd.unsafe,
      ...extra,
      ...ws.flatMap((w) => w.unsafe ?? []),
      ...ws.flatMap((w) => (w.indirect ? [w.indirect] : []))
    ]
    const note = o.note ?? ctx.note
    const c: ShellCommand = {
      tokens: ws.map((w) => w.value),
      text: [...ws.map((w) => w.raw), ...cmd.redirs].join(' ').replace(/\s+/g, ' ').trim(),
      ...(note ? { note } : {}),
      ...(unsafe.length ? { unsafe: [...new Set(unsafe)].join('; ') } : {}),
      ...(ctx.depth ? { depth: ctx.depth } : {}),
      ...(ctx.group ? { group: ctx.group } : {}),
      ...(o.match ? { match: o.match } : {}),
      ...(o.role ? { role: o.role } : {}),
      ...(cmd.writes?.length ? { writes: [...cmd.writes] } : {})
    }
    ;(cmd.emitted ??= []).push(c)
    this.out.push(c)
    return c
  }

  /** Item com um texto que não deu para desmontar (sempre pergunta; a blacklist ainda vê as palavras). */
  private opaque(text: string, why: string, ctx: Ctx): ShellCommand {
    const flat = text.replace(/\s+/g, ' ').trim()
    const c: ShellCommand = {
      tokens: flat.split(' ').filter(Boolean),
      text: flat || '(vazio)',
      unsafe: why,
      ...(ctx.note ? { note: ctx.note } : {}),
      ...(ctx.depth ? { depth: ctx.depth } : {}),
      ...(ctx.group ? { group: ctx.group } : {})
    }
    this.out.push(c)
    return c
  }

  /**
   * Analisa um script embutido (comando remoto do ssh, `bash -c`, heredoc lido por um shell) com o
   * contexto do wrapper. `local` = motivo que vale para TODOS os itens (ex.: expansão local no texto
   * enviado). Retorna os itens ou a mensagem de erro.
   */
  private subParse(src: string, ctx: Ctx, stdin?: Stdin, local?: string): ShellCommand[] | string {
    if (src.length > MAX_SCRIPT)
      return `script grande demais para analisar (${src.length} caracteres)`
    try {
      const p = new Parser(src, this.depth + 1)
      p.level = ctx.depth
      p.group = ctx.group
      p.wraps = ctx.wraps
      p.stdin = stdin
      if (ctx.note) p.notes = [ctx.note]
      p.parseList(null)
      if (local) for (const c of p.out) c.unsafe = c.unsafe ? `${c.unsafe}; ${local}` : local
      return p.out
    } catch (e) {
      return (e as Error).message
    }
  }

  /** Fecha um comando simples: aplica palavras reservadas, atribuições, prefixos e regras. */
  private finish(cmd: Pending): void {
    let words = cmd.words
    const ctx = this.ctx()
    // palavras reservadas no início
    for (;;) {
      const f = words[0]
      if (!f || f.quoted) break
      if (RESERVED_SKIP.has(f.value)) words = words.slice(1)
      else if (RESERVED_END.has(f.value) && words.length === 1) words = []
      else break
    }
    if (words[0] && !words[0].quoted && words[0].value === 'for') {
      // cabeçalho `for NOME in …` não é comando (substituições já foram analisadas)
      if (cmd.unsafe.length) this.emit(cmd, words, [], ctx)
      return
    }
    // atribuições no início
    const assigns: Word[] = []
    while (words[0] && ASSIGN_RE.test(words[0].raw)) {
      assigns.push(words[0])
      words = words.slice(1)
    }
    const dangerous = assigns
      .map((a) => /^[A-Za-z_][A-Za-z0-9_]*/.exec(a.raw)![0])
      .filter((n) => DANGEROUS_VARS.test(n))
      .map((n) => `altera a variável ${n}`)
    if (!words.length) {
      if (dangerous.length || cmd.unsafe.length) this.emit(cmd, assigns, dangerous, ctx)
      return
    }
    this.command(words, dangerous, cmd, ctx, 0, cmd.stdin ?? this.stdin)
  }

  private command(
    words: Word[],
    extra: string[],
    cmd: Pending,
    ctx: Ctx,
    hops: number,
    stdin: Stdin | undefined
  ): void {
    const emit = (ws: Word[], ex: string[]): void => void this.emit(cmd, ws, ex, ctx)
    const first = words[0]
    if (hops > 6) return emit(words, [...extra, 'prefixos demais'])
    if (first.expansion || first.glob)
      return emit(words, [...extra, 'o nome do comando vem de expansão/glob'])
    if (first.value.startsWith('=') && !first.quoted)
      return emit(words, [...extra, '=comando (expansão do zsh)'])
    const name = baseName(first.value)
    const unsafeWhy = own(ALWAYS_UNSAFE, first.value) ?? own(ALWAYS_UNSAFE, name)
    if (unsafeWhy) return emit(words, [...extra, unsafeWhy])
    const rest = words.slice(1)
    if (DECLARE.has(name)) {
      const bad = rest
        .map((w) => /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/.exec(w.value)?.[1] ?? '')
        .filter((n) => n && DANGEROUS_VARS.test(n))
      if (bad.length) extra = [...extra, ...bad.map((n) => `altera a variável ${n}`)]
      // declare -i / typeset -i / integer / float: a atribuição é avaliada como aritmética
      if (
        name === 'integer' ||
        name === 'float' ||
        rest.some((w) => /^[-+][A-Za-z]*[iEF]/.test(w.value))
      )
        extra = [
          ...extra,
          'atribuição numérica avalia aritmética (o valor de uma variável pode executar código)'
        ]
    }
    // [[ a -eq b ]]: operandos de -eq/-ne/-lt/-le/-gt/-ge são avaliados como aritmética
    // (bash: x='a[$(cmd)]' executa cmd). Só literais inteiros são seguros.
    if (name === '[[') {
      const ARITH = /^-(eq|ne|lt|le|gt|ge)$/
      for (let i = 0; i < rest.length; i++) {
        if (!ARITH.test(rest[i].value)) continue
        const ops = [rest[i - 1], rest[i + 1]].filter(Boolean)
        if (ops.some((w) => w.expansion || !/^[-+]?\d+$/.test(w.value)))
          return emit(words, [
            ...extra,
            '[[ … -eq/-lt … ]] com variável avalia aritmética (o valor pode executar código)'
          ])
      }
    }
    if (name === 'hash' && rest.some((w) => /^-[a-zA-Z]*p/.test(w.value)))
      return emit(words, [...extra, 'hash -p troca o programa de um comando'])
    if (name === 'find' && rest.some((w) => /^-(exec|execdir|ok|okdir)$/.test(w.value)))
      return emit(words, [...extra, 'find com -exec/-execdir/-ok executa comandos'])
    if (name === 'fd' && rest.some((w) => /^(-x|-X|--exec|--exec-batch)$/.test(w.value)))
      return emit(words, [...extra, 'fd com --exec executa comandos'])
    // comandos que executam outro código (ssh, sudo, bash -c, docker exec, env…)
    const spec = WRAPPERS.get(name)
    const r = spec ? spec(rest, first.value) : null
    if (r) return this.wrapped(words, rest, r, name, extra, cmd, ctx, hops, stdin)
    if (stdin?.kind === 'heredoc' && !HEREDOC_DATA.has(name) && !NO_STDIN.has(name))
      return emit(words, [...extra, `heredoc alimentando ${name}`])
    emit(words, extra)
  }

  /** Aplica um wrapper da tabela: item próprio (se houver) + os comandos internos, um nível abaixo. */
  private wrapped(
    words: Word[],
    rest: Word[],
    r: Wrap,
    name: string,
    extra: string[],
    cmd: Pending,
    ctx: Ctx,
    hops: number,
    stdin: Stdin | undefined
  ): void {
    if ('error' in r) return void this.emit(cmd, words, [...extra, r.error], ctx)
    const ownExtra = [...extra, ...(r.unsafe ?? [])]
    const deeper = r.own !== 'none'
    const ictx: Ctx = deeper
      ? { depth: ctx.depth + 1, group: r.label, wraps: ctx.wraps + (r.layer ? 1 : 0) }
      : { ...ctx, note: r.label, wraps: ctx.wraps + (r.layer ? 1 : 0) }
    const istdin = r.stdin ? stdin : undefined
    const tooDeep = ictx.wraps > MAX_WRAPS
    const deepWhy = `aninhamento de comandos que executam código profundo demais (máx. ${MAX_WRAPS})`
    let innerWords = rest.slice(r.at)
    if (r.inner === 'argv' && r.input) innerWords = withInput(innerWords, r.input.replace)
    // texto do item próprio
    if (deeper) {
      const note = typeof r.ownNote === 'function' ? r.ownNote(istdin) : r.ownNote
      this.emit(cmd, r.own === 'full' ? words : words.slice(0, 1 + r.at), ownExtra, ctx, {
        match: r.match,
        role: r.role,
        ...(note ? { note } : {})
      })
    }
    // transparente sem nada dentro (`env`, `time` sozinhos; `env PATH=x`)
    if (!deeper && r.inner === 'argv' && !innerWords.length)
      return void this.emit(cmd, words, [...ownExtra, ...(r.innerExtra ?? [])], ctx)
    if (r.inner === 'none') return
    // transparente cujo interno é analisado num script à parte: os motivos do wrapper (e do
    // comando: redirecionamento…) ficam num item com o comando inteiro
    const wholeIfNeeded = (): void => {
      if (!deeper && (ownExtra.length || cmd.unsafe.length)) this.emit(cmd, words, ownExtra, ctx)
    }
    const fail = (text: string, why: string): void => {
      if (deeper) this.opaque(text, why, ictx)
      else this.emit(cmd, words, [...ownExtra, why], ctx)
    }
    if (r.inner === 'argv') {
      if (!deeper && r.unsafe?.length) this.emit(cmd, words, ownExtra, ctx)
      if (!innerWords.length) return
      if (tooDeep) return void this.opaque(innerWords.map((w) => w.raw).join(' '), deepWhy, ictx)
      const iextra = deeper ? (r.innerExtra ?? []) : [...extra, ...(r.innerExtra ?? [])]
      return this.command(innerWords, iextra, cmd, ictx, hops + 1, istdin)
    }
    // o texto do script só existe quando o heredoc da entrada chega (`ssh h bash -s <<EOF | tee x`
    // fecha o comando antes da próxima linha): os itens entram logo depois do item atual
    const place = (gen: () => void): void => {
      const st = istdin
      if (st?.kind !== 'heredoc' || st.body !== undefined) return gen()
      const anchor = this.out[this.out.length - 1]
      ;(st.waiters ??= []).push(() => {
        const n = this.out.length
        gen()
        const items = this.out.splice(n)
        this.out.splice(anchor ? this.out.indexOf(anchor) + 1 : 0, 0, ...items)
      })
    }
    if (r.inner === 'joined' || r.inner === 'script') {
      // o texto que o programa interno vai analisar como script
      const ws = r.inner === 'script' ? [r.script!] : innerWords
      const src = ws.map((w) => w.value).join(' ')
      const what = r.inner === 'script' ? `o script de ${name} -c` : `o comando de ${name}`
      if (tooDeep) return fail(src, deepWhy)
      if (r.inner === 'script' && (ws[0].expansion || ws[0].glob))
        return fail(src, `script de ${name} -c vem de expansão`)
      // expansão local muda o texto enviado — só se sabe na execução
      if (ws.some((w) => w.expansion && /\$\(…\)|`…`/.test(w.value)))
        return fail(src, `${what} é montado com substituição de comando local ($(…)/crase)`)
      const local = ws.some((w) => w.expansion || w.glob)
        ? `${what} usa expansão local ($VAR/glob): o texto real só é conhecido na execução`
        : undefined
      return place(() => {
        const items = this.subParse(src, ictx, istdin, local)
        if (typeof items === 'string')
          return fail(src, `não foi possível analisar ${what}: ${items}`)
        wholeIfNeeded()
        this.out.push(...items)
      })
    }
    // stdin: o script vem da entrada (bash -s, ssh sem comando, sudo -s, su sem -c)
    const st = istdin
    if (st?.kind === 'heredoc')
      return place(() => {
        const body = st.body ?? ''
        if (tooDeep) return fail(body, deepWhy)
        const items = this.subParse(body, ictx, undefined, st.local)
        if (typeof items === 'string')
          return fail(body, `não foi possível analisar o heredoc lido por ${name}: ${items}`)
        wholeIfNeeded()
        this.out.push(...items)
      })
    if (st || r.noStdin === 'ask')
      return fail('(entrada)', r.stdinWhy ?? `${name} lendo comandos da entrada`)
  }
}

interface Pending {
  words: Word[]
  redirs: string[]
  unsafe: string[]
  /** Destinos de redirecionamento de saída para arquivo (ver ShellCommand.writes). */
  writes?: string[]
  heredoc?: boolean
  /** De onde vem a entrada do comando (pipe, arquivo, heredoc…). */
  stdin?: Stdin
  /** Sub-comandos já emitidos por este comando (heredoc lido depois pode marcá-los). */
  emitted?: ShellCommand[]
}
const newPending = (): Pending => ({ words: [], redirs: [], unsafe: [] })

/** Heredoc como entrada: o corpo chega quando a linha termina (`waiters` = quem espera por ele). */
interface HeredocIn {
  kind: 'heredoc'
  body?: string
  /** Sem aspas no delimitador e com $… no corpo: o texto real só existe na execução. */
  local?: string
  waiters?: (() => void)[]
}
type Stdin = { kind: 'pipe' | 'file' | 'herestring' } | HeredocIn

/** Contexto de quem emite (árvore da decomposição). */
interface Ctx {
  depth: number
  group?: string
  note?: string
  wraps: number
}

const own = <T>(o: Record<string, T>, k: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined

/** Corpo de heredoc sem aspas no delimitador: desescapa \$ \` \\ e \<nl>; $…/crase = expansão local. */
function heredocText(body: string): { text: string; local?: string } {
  let text = ''
  let local: string | undefined
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    const n = body[i + 1] ?? ''
    if (c === '\\' && (n === '$' || n === '`' || n === '\\')) {
      text += n
      i++
    } else if (c === '\\' && n === '\n') i++
    else {
      if ((c === '$' && /[A-Za-z_{(0-9@*#?!$-]/.test(n)) || c === '`')
        local =
          'heredoc sem aspas no delimitador expande $… localmente: o texto real só é conhecido na execução'
      text += c
    }
  }
  return local ? { text, local } : { text }
}

const synth = (value: string, expansion = false): Word => ({
  value,
  raw: value === INPUT_TOKEN ? value : shellQuote(value),
  quoted: false,
  expansion,
  glob: false
})

/** xargs: o comando interno recebe os argumentos da entrada (no fim, ou no lugar de `replace`). */
function withInput(ws: Word[], replace?: string): Word[] {
  const base = ws.length ? ws : [synth('echo')]
  if (!replace) return [...base, synth(INPUT_TOKEN, true)]
  return base.map((w) =>
    w.value.includes(replace)
      ? {
          ...w,
          value: w.value.split(replace).join(INPUT_TOKEN),
          raw: w.raw.split(replace).join(INPUT_TOKEN),
          expansion: true
        }
      : w
  )
}

// ---------------- wrappers: comandos que executam outro código ----------------

/**
 * Resultado de um wrapper da tabela. `own`: item próprio — `none` (prefixo transparente: só o
 * interno, com nota), `full` (o comando inteiro: sudo/doas/su — precisa casar sozinho com a
 * lista), `head` (as palavras até o comando interno: ssh/docker exec/kubectl exec; casa com
 * `match`). `inner`: como o resto vira comando — `argv` (as palavras são executadas), `joined`
 * (juntadas com espaço e analisadas como script — ssh, watch), `script` (uma palavra — bash -c),
 * `stdin` (o script vem da entrada — bash -s, ssh sem comando), `none`.
 */
type Wrap =
  | { error: string }
  | {
      own: 'none' | 'full' | 'head'
      /** Índice (em rest) do comando interno = fim das palavras do wrapper. */
      at: number
      inner: 'argv' | 'joined' | 'script' | 'stdin' | 'none'
      script?: Word
      role?: ShellCommand['role']
      match?: string[]
      /** Motivos do próprio wrapper (nunca automático). */
      unsafe?: string[]
      /** Motivos passados ao interno (env com variável perigosa). */
      innerExtra?: string[]
      ownNote?: string | ((stdin: Stdin | undefined) => string | undefined)
      /** Grupo dos internos (item próprio) ou nota deles (transparente). */
      label: string
      /** O interno recebe a entrada do wrapper. */
      stdin: boolean
      /** Conta como camada que executa código (MAX_WRAPS). */
      layer: boolean
      /** xargs: argumentos vindos da entrada. */
      input?: { replace?: string }
      /** stdin: motivo quando a entrada não é um heredoc visível; `noStdin` sem entrada nenhuma. */
      stdinWhy?: string
      noStdin?: 'ask' | 'ok'
    }

type WrapSpec = (rest: Word[], prog: string) => Wrap | null

interface OptSpec {
  /** Letras curtas com argumento (no resto da palavra ou na seguinte). */
  arg?: string
  /** Letras curtas sem argumento. */
  flag?: string
  /** Letras com argumento OPCIONAL, só colado (`-i{}`, `-t2`). */
  opt?: string
  /** Longas com argumento (`--user x` / `--user=x`). */
  long?: string[]
  /** Longas sem argumento (aceitam `=valor` colado). */
  longFlag?: string[]
}
interface Opt {
  name: string
  value?: string
  /** Palavra que contém o valor. */
  argWord?: Word
}
interface Opts {
  at: number
  opts: Opt[]
  /** Índices dos posicionais (modo permute). */
  pos: number[]
  dashdash: boolean
  error?: string
}

const loose = (w: Word): boolean => w.glob || (w.expansion && !w.quoted)

/**
 * getopt: lê opções a partir de `from` até o 1º posicional (ou `--`). `permute` (estilo GNU/cobra):
 * posicionais no meio são coletados em `pos` e a leitura segue até `--` ou o fim. Palavra sem aspas
 * com expansão/glob na região das opções → erro (pode virar várias palavras).
 */
function getopts(ws: Word[], from: number, spec: OptSpec, prog: string, permute = false): Opts {
  const opts: Opt[] = []
  const pos: number[] = []
  const fail = (error: string): Opts => ({ at: from, opts, pos, dashdash: false, error })
  let i = from
  while (i < ws.length) {
    const w = ws[i]
    const v = w.value
    if (v === '--') return { at: i + 1, opts, pos, dashdash: true }
    if (!(v.length > 1 && v.startsWith('-'))) {
      if (!permute) return { at: i, opts, pos, dashdash: false }
      if (loose(w)) return fail(`palavra com expansão/glob nas opções de ${prog}: ${w.raw}`)
      pos.push(i++)
      continue
    }
    if (loose(w)) return fail(`opção de ${prog} vem de expansão/glob: ${w.raw}`)
    if (v.startsWith('--')) {
      const eq = v.indexOf('=')
      const n = eq < 0 ? v.slice(2) : v.slice(2, eq)
      if (spec.long?.includes(n)) {
        if (eq >= 0) opts.push({ name: `--${n}`, value: v.slice(eq + 1), argWord: w })
        else {
          const a = ws[i + 1]
          if (!a) return fail(`${v} de ${prog} sem argumento`)
          if (loose(a)) return fail(`argumento de ${v} vem de expansão/glob: ${a.raw}`)
          opts.push({ name: `--${n}`, value: a.value, argWord: a })
          i++
        }
        i++
        continue
      }
      if (spec.longFlag?.includes(n)) {
        opts.push({ name: `--${n}`, ...(eq >= 0 ? { value: v.slice(eq + 1), argWord: w } : {}) })
        i++
        continue
      }
      return fail(`opção de ${prog} não reconhecida: ${v}`)
    }
    const letters = v.slice(1)
    let step = 1
    for (let k = 0; k < letters.length; k++) {
      const l = letters[k]
      if (spec.arg?.includes(l)) {
        const inline = letters.slice(k + 1)
        if (inline) opts.push({ name: `-${l}`, value: inline, argWord: w })
        else {
          const a = ws[i + 1]
          if (!a) return fail(`-${l} de ${prog} sem argumento`)
          if (loose(a)) return fail(`argumento de -${l} vem de expansão/glob: ${a.raw}`)
          opts.push({ name: `-${l}`, value: a.value, argWord: a })
          step = 2
        }
        break
      }
      if (spec.opt?.includes(l)) {
        const inline = letters.slice(k + 1)
        opts.push({ name: `-${l}`, ...(inline ? { value: inline, argWord: w } : {}) })
        break
      }
      if (spec.flag?.includes(l)) {
        opts.push({ name: `-${l}` })
        continue
      }
      return fail(`opção de ${prog} não reconhecida: -${l}`)
    }
    i += step
  }
  return { at: i, opts, pos, dashdash: false }
}

/** Opções normalizadas para casar (`-p2222` → `-p 2222`; `-At` → `-A -t`), sem as inofensivas. */
const optTokens = (opts: Opt[], harmless: Set<string>): string[] =>
  opts
    .filter((o) => !harmless.has(o.name))
    .flatMap((o) => (o.value === undefined ? [o.name] : [o.name, o.value]))

// ssh [opções] destino [opções] [comando…] — o comando remoto é o resto JUNTADO com espaços (como
// o ssh faz) e analisado como script pelo shell do servidor. Opções depois do destino valem (o ssh
// relê as opções); `--` termina.
const SSH_OPTS: OptSpec = { arg: 'BbcDEeFIiJLlmOoPpQRSWw', flag: '46AaCfGgKkMNnqsTtVvXxYy' }
/** Não mudam quem/onde/como conecta: ficam fora do casamento (`ssh -t host` casa `ssh host`). */
const SSH_HARMLESS = new Set(['-t', '-T', '-q', '-v', '-C', '-4', '-6', '-n', '-x'])
const SSH_RUNS = /^(proxycommand|localcommand|knownhostscommand|remotecommand)$/i

const sshWrap: WrapSpec = (rest, prog) => {
  const a = getopts(rest, 0, SSH_OPTS, 'ssh')
  if (a.error) return { error: a.error }
  let opts = a.opts
  let i = a.at
  // sem destino (ssh -V, ssh -Q cipher): comando comum
  if (i >= rest.length) return null
  const destW = rest[i++]
  if (loose(destW)) return { error: `destino do ssh vem de expansão/glob: ${destW.raw}` }
  if (!a.dashdash && i < rest.length) {
    const b = getopts(rest, i, SSH_OPTS, 'ssh')
    if (b.error) return { error: b.error }
    opts = [...opts, ...b.opts]
    i = b.at
  }
  const unsafe: string[] = []
  for (const o of opts) {
    const key = o.name === '-o' ? (o.value ?? '').split(/[=\s]/)[0] : ''
    if (SSH_RUNS.test(key))
      unsafe.push(
        /^remotecommand$/i.test(key)
          ? `-o ${key} esconde o comando remoto`
          : `-o ${key} executa um comando local`
      )
  }
  const dest = destW.value
  const user = opts.find((o) => o.name === '-l')?.value
  const port = opts.find((o) => o.name === '-p')?.value
  const jump = opts.find((o) => o.name === '-J')?.value
  const where = `${user && !dest.includes('@') ? `${user}@` : ''}${dest}${port ? `:${port}` : ''}`
  const base = {
    own: 'head' as const,
    at: i,
    role: 'ssh' as const,
    match: [prog, ...optTokens(opts, SSH_HARMLESS), dest],
    ...(unsafe.length ? { unsafe } : {}),
    label: `no servidor ${where} (via ssh${jump ? `, salto ${jump}` : ''})`
  }
  if (i < rest.length)
    return {
      ...base,
      inner: 'joined',
      ownNote: 'conexão — os comandos remotos estão abaixo',
      stdin: true,
      layer: true
    }
  if (opts.some((o) => /^-[NWOGV]$/.test(o.name)))
    return {
      ...base,
      inner: 'none',
      ownNote: 'sem comando remoto (só túnel/controle)',
      stdin: false,
      layer: false
    }
  return {
    ...base,
    inner: 'stdin',
    ownNote: (st) =>
      !st
        ? 'sem comando remoto: sessão interativa (sem terminal na tool, encerra logo — passe o comando)'
        : st.kind === 'heredoc'
          ? 'sem comando remoto: o servidor executa o heredoc (abaixo)'
          : 'sem comando remoto: o servidor executa o que vier da entrada',
    stdinWhy:
      'ssh sem comando remoto: o servidor executa o que vier da entrada (script desconhecido)',
    noStdin: 'ok',
    stdin: true,
    layer: true
  }
}

// sudo/doas: item próprio = o comando INTEIRO (precisa casar sozinho, com o comando específico —
// ver approvalPolicy) + o interno um nível abaixo.
const elevateWrap: WrapSpec = (rest, prog) => {
  const name = baseName(prog)
  const isSudo = name === 'sudo'
  const i = skipOptions(rest, isSudo ? 'uUgpChDrtTR' : 'uC', isSudo)
  if (i < 0) return { error: `opções de ${name} não reconhecidas` }
  const optWords = rest.slice(0, i).map((w) => w.value)
  let user: string | undefined
  for (let k = 0; k < optWords.length; k++) {
    const m = /^-([a-zA-Z]*)u(.*)$/.exec(optWords[k]) ?? /^--user=(.*)$/.exec(optWords[k])
    if (optWords[k] === '--user') user = optWords[k + 1]
    else if (m) user = (m.length === 3 ? m[2] : m[1]) || optWords[k + 1]
  }
  const flagsOf = (re: RegExp): boolean =>
    optWords.some((v) => /^-[a-zA-Z]+$/.test(v) && re.test(v))
  const label = `via ${name}${user ? ` (como ${user})` : ''}`
  const base = { own: 'full' as const, at: i, role: 'elevate' as const, label }
  // sem execução: sudo -e (sudoedit) -l -v -V -K; doas -C (confere config) -L
  const noRun = isSudo
    ? flagsOf(/[elvVK]/) ||
      optWords.some((v) => /^--(edit|list|validate|version|remove-timestamp)$/.test(v))
    : flagsOf(/[CL]/)
  if (noRun) return { ...base, inner: 'none', stdin: false, layer: false }
  if (i >= rest.length) {
    const shell = flagsOf(/[si]/) || optWords.some((v) => v === '--shell' || v === '--login')
    return shell
      ? {
          ...base,
          inner: 'stdin',
          stdinWhy: `${name} -s/-i lendo comandos da entrada`,
          noStdin: 'ok',
          stdin: true,
          layer: true
        }
      : { ...base, inner: 'none', stdin: false, layer: false }
  }
  return { ...base, inner: 'argv', stdin: true, layer: true }
}

// su [opções] [usuário] — com -c o script roda como o usuário; sem -c lê comandos da entrada.
const SU_OPTS: OptSpec = {
  arg: 'cCsgGw',
  flag: 'lmpfP',
  long: ['command', 'session-command', 'shell', 'group', 'supp-group', 'whitelist-environment'],
  longFlag: ['login', 'preserve-environment', 'pty']
}
const suWrap: WrapSpec = (rest) => {
  const ws = rest.map((w) => (w.value === '-' ? { ...w, value: '--login' } : w))
  const a = getopts(ws, 0, SU_OPTS, 'su', true)
  if (a.error) return { error: a.error }
  if (a.pos.length > 1 || a.at < rest.length)
    return { error: 'argumentos extras de su (vão para o shell)' }
  const user = a.pos.length ? rest[a.pos[0]].value : 'root'
  const base = {
    own: 'full' as const,
    at: rest.length,
    role: 'elevate' as const,
    label: `como ${user} (via su)`
  }
  const c = a.opts.find((o) => /^(-c|-C|--command|--session-command)$/.test(o.name))
  if (c) {
    const w = c.argWord!
    const script = w.value === c.value ? w : { ...synth(c.value ?? ''), expansion: w.expansion }
    return { ...base, inner: 'script', script, stdin: true, layer: true }
  }
  return {
    ...base,
    inner: 'stdin',
    stdinWhy: 'su lendo comandos da entrada',
    noStdin: 'ok',
    stdin: true,
    layer: true
  }
}

// docker|podman [globais] exec [opções] CONTAINER cmd… · docker compose [globais] exec … SERVIÇO
// cmd… · docker container exec … — o comando interno é executado direto (sem shell).
const DOCKER_GLOBAL: OptSpec = {
  arg: 'cHl',
  flag: 'D',
  long: ['context', 'host', 'config', 'log-level', 'tlscacert', 'tlscert', 'tlskey'],
  longFlag: ['debug', 'tls', 'tlsverify']
}
const DOCKER_EXEC: OptSpec = {
  arg: 'euw',
  flag: 'dit',
  long: ['env', 'env-file', 'user', 'workdir', 'detach-keys'],
  longFlag: ['detach', 'interactive', 'tty', 'privileged']
}
const COMPOSE_GLOBAL: OptSpec = {
  arg: 'fp',
  long: [
    'file',
    'project-name',
    'profile',
    'env-file',
    'project-directory',
    'ansi',
    'progress',
    'parallel'
  ],
  longFlag: ['compatibility', 'dry-run', 'all-resources']
}
const COMPOSE_EXEC: OptSpec = {
  arg: 'euw',
  flag: 'ditT',
  long: ['env', 'user', 'workdir', 'index'],
  longFlag: ['detach', 'privileged', 'no-TTY', 'interactive', 'tty', 'dry-run']
}
const CONTAINER_HARMLESS = new Set([
  '-i',
  '-t',
  '-T',
  '--interactive',
  '--tty',
  '--no-TTY',
  '-q',
  '--quiet'
])

const dockerWrap: WrapSpec = (rest, prog) => {
  const tool = baseName(prog)
  const hasExec = rest.some((w) => w.value === 'exec')
  let compose = /-compose$/.test(tool)
  const g = getopts(rest, 0, compose ? COMPOSE_GLOBAL : DOCKER_GLOBAL, tool)
  if (g.error) return hasExec ? { error: g.error } : null
  let i = g.at
  if (!compose && rest[i]?.value === 'container' && rest[i + 1]?.value === 'exec') i++
  else if (!compose && rest[i]?.value === 'compose') {
    const c = getopts(rest, i + 1, COMPOSE_GLOBAL, `${tool} compose`)
    if (c.error) return hasExec ? { error: c.error } : null
    i = c.at
    compose = true
  }
  if (rest[i]?.value !== 'exec') return null
  const e = getopts(rest, i + 1, compose ? COMPOSE_EXEC : DOCKER_EXEC, `${tool} exec`)
  if (e.error) return { error: e.error }
  const target = rest[e.at]
  if (!target) return null
  if (loose(target)) return { error: `container vem de expansão/glob: ${target.raw}` }
  const interactive = e.opts.some((o) => o.name === '-i' || o.name === '--interactive')
  return {
    own: 'head',
    at: e.at + 1,
    inner: 'argv',
    role: 'container',
    match: [
      prog,
      ...rest.slice(0, i + 1).map((w) => w.value),
      ...optTokens(e.opts, CONTAINER_HARMLESS),
      target.value
    ],
    label: compose
      ? `no serviço ${target.value} (${tool === 'docker' || tool === 'podman' ? `${tool} compose` : tool} exec)`
      : `no container ${target.value} (${tool} exec)`,
    stdin: compose || interactive,
    layer: true
  }
}

// kubectl|oc [globais] exec [opções] POD -- cmd… (opções em qualquer posição antes do `--`).
const KUBE_LONG = [
  'namespace',
  'context',
  'kubeconfig',
  'cluster',
  'user',
  'server',
  'token',
  'as',
  'as-group',
  'request-timeout',
  'cache-dir',
  'profile'
]
const KUBE_GLOBAL: OptSpec = { arg: 'ns', long: KUBE_LONG, longFlag: ['insecure-skip-tls-verify'] }
const KUBE_EXEC: OptSpec = {
  arg: 'cnsf',
  flag: 'itq',
  long: [...KUBE_LONG, 'container', 'filename', 'pod-running-timeout'],
  longFlag: ['stdin', 'tty', 'quiet', 'insecure-skip-tls-verify']
}
const KUBE_HARMLESS = new Set(['-i', '-t', '-q', '--stdin', '--tty', '--quiet'])

const kubeWrap: WrapSpec = (rest, prog) => {
  const tool = baseName(prog)
  const g = getopts(rest, 0, KUBE_GLOBAL, tool)
  const hasExec = rest.some((w) => w.value === 'exec')
  if (g.error) return hasExec ? { error: g.error } : null
  if (rest[g.at]?.value !== 'exec') return null
  const e = getopts(rest, g.at + 1, KUBE_EXEC, `${tool} exec`, true)
  if (e.error) return { error: e.error }
  if (!e.dashdash)
    return e.pos.length > 1
      ? { error: `${tool} exec sem "--": não dá para separar o comando` }
      : null
  const file = e.opts.find((o) => o.name === '-f' || o.name === '--filename')?.value
  if (e.pos.length > 1 || (!e.pos.length && !file))
    return { error: `${tool} exec: não deu para identificar o pod` }
  const pod = e.pos.length ? rest[e.pos[0]].value : `-f ${file}`
  const all = [...g.opts, ...e.opts]
  const ns = all.find((o) => o.name === '-n' || o.name === '--namespace')?.value
  const container = all.find((o) => o.name === '-c' || o.name === '--container')?.value
  return {
    own: 'head',
    at: e.at,
    inner: 'argv',
    role: 'container',
    match: [
      prog,
      ...rest.slice(0, g.at + 1).map((w) => w.value),
      ...optTokens(e.opts, KUBE_HARMLESS),
      ...(e.pos.length ? [pod] : [])
    ],
    label: `no pod ${pod}${container ? ` (container ${container})` : ''} (${tool} exec${ns ? `, namespace ${ns}` : ''})`,
    stdin: e.opts.some((o) => o.name === '-i' || o.name === '--stdin'),
    layer: true
  }
}

// bash|sh|zsh… -c "script" (a string é analisada) · sem script: lê comandos da entrada (bash -s,
// `curl … | sh`; com heredoc visível, o corpo é analisado) · `bash script.sh`: comando comum.
const shellWrap: WrapSpec = (rest, prog) => {
  const name = baseName(prog)
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i].value
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(v)) {
      const script = rest[i + 1]
      if (!script) return { error: `${name} -c sem script` }
      return {
        own: 'none',
        at: rest.length,
        inner: 'script',
        script,
        label: `via ${name} -c`,
        stdin: true,
        layer: true
      }
    }
    if (v === '-o' || v === '+o' || v === '-O' || v === '+O') {
      i++
      continue
    }
    if (/^[-+][a-zA-Z]+$/.test(v) || /^--(login|norc|noprofile|posix)$/.test(v)) continue
    break // `bash script.sh` ou opção desconhecida
  }
  if (rest.every((w) => /^[-+]/.test(w.value)) || rest.some((w) => w.value === '-s'))
    return {
      own: 'none',
      at: rest.length,
      inner: 'stdin',
      label: `via ${name} (script da entrada)`,
      stdinWhy: `${name} lendo comandos da entrada`,
      noStdin: 'ask',
      stdin: true,
      layer: true
    }
  return null
}

// xargs [opções] [cmd…] — o comando interno recebe argumentos da entrada (`…`); -I/-i/-J: no
// lugar do texto de substituição (vira expansão: em `sh -c '… {}'` o script fica invisível).
const XARGS_OPTS: OptSpec = {
  arg: 'adEILnPsJRS',
  flag: '0prtxo',
  opt: 'eil',
  long: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'],
  longFlag: [
    'null',
    'no-run-if-empty',
    'verbose',
    'interactive',
    'exit',
    'open-tty',
    'show-limits',
    'replace',
    'eof',
    'max-lines'
  ]
}
const xargsWrap: WrapSpec = (rest) => {
  const a = getopts(rest, 0, XARGS_OPTS, 'xargs')
  if (a.error) return { error: a.error }
  let replace: string | undefined
  for (const o of a.opts) {
    if (o.name === '-I' || o.name === '-J') replace = o.value
    else if (o.name === '-i' || o.name === '--replace') replace = o.value || '{}'
  }
  return {
    own: 'none',
    at: a.at,
    inner: 'argv',
    label: 'via xargs (argumentos da entrada)',
    input: replace ? { replace } : {},
    stdin: false,
    layer: true
  }
}

// watch [opções] cmd… — sem -x o comando é juntado e roda em `sh -c` (repetido).
const WATCH_OPTS: OptSpec = {
  arg: 'nq',
  flag: 'bcCdegprtwx',
  long: ['interval', 'equexit'],
  longFlag: [
    'beep',
    'color',
    'no-color',
    'differences',
    'errexit',
    'chgexit',
    'precise',
    'no-rerun',
    'no-title',
    'no-wrap',
    'exec'
  ]
}
const watchWrap: WrapSpec = (rest) => {
  const a = getopts(rest, 0, WATCH_OPTS, 'watch')
  if (a.error) return { error: a.error }
  if (a.at >= rest.length) return null
  const exec = a.opts.some((o) => o.name === '-x' || o.name === '--exec')
  return {
    own: 'none',
    at: a.at,
    inner: exec ? 'argv' : 'joined',
    label: 'via watch (repetido)',
    stdin: false,
    layer: true
  }
}

// script -c 'cmd' [arquivo] (util-linux) · script [-q] arquivo cmd… (BSD/macOS). Grava a sessão
// num arquivo (padrão ./typescript) — nunca automático, salvo /dev/null.
const SCRIPT_LINUX: OptSpec = {
  arg: 'cEIOBTmo',
  flag: 'aefqVh',
  opt: 't',
  long: [
    'command',
    'echo',
    'log-in',
    'log-out',
    'log-io',
    'log-timing',
    'logging-format',
    'output-limit'
  ],
  longFlag: ['append', 'return', 'flush', 'force', 'quiet', 'timing']
}
const scriptWrap: WrapSpec = (rest, prog) => {
  const a = getopts(rest, 0, SCRIPT_LINUX, 'script')
  const c = a.error ? undefined : a.opts.find((o) => o.name === '-c' || o.name === '--command')
  if (c) {
    const logs = a.opts
      .filter(
        (o) =>
          /^(-[IOBT]|--log-(in|out|io|timing))$/.test(o.name) ||
          ((o.name === '-t' || o.name === '--timing') && o.value)
      )
      .map((o) => o.value ?? '')
    const files = [rest[a.at]?.value ?? 'typescript', ...logs].filter((f) => f !== '/dev/null')
    const unsafe = files.length ? [`script grava a sessão em arquivo: ${files.join(', ')}`] : []
    if (rest.length > a.at + 1) unsafe.push('argumentos extras de script')
    const w = c.argWord!
    const script = w.value === c.value ? w : { ...synth(c.value ?? ''), expansion: w.expansion }
    return {
      own: 'none',
      at: rest.length,
      inner: 'script',
      script,
      label: `via ${baseName(prog)} -c`,
      ...(unsafe.length ? { unsafe } : {}),
      stdin: true,
      layer: true
    }
  }
  const b = getopts(rest, 0, { flag: 'adekpqr', arg: 'FTt' }, 'script')
  if (b.error || rest.length - b.at < 2) return null
  const file = rest[b.at].value
  return {
    own: 'none',
    at: b.at + 1,
    inner: 'argv',
    label: 'via script',
    ...(file !== '/dev/null' ? { unsafe: [`script grava a sessão em arquivo: ${file}`] } : {}),
    stdin: true,
    layer: true
  }
}

/** Prefixo transparente (não muda o que roda nem onde): só o interno, com a nota "via x". */
const prefixWrap: WrapSpec = (rest, prog) => {
  const name = baseName(prog)
  const at = unwrap(name, rest)
  if (at === null) return null
  if (at === -1) return { error: `não foi possível achar o comando após ${name}` }
  let i = at
  const innerExtra: string[] = []
  if (name === 'env') {
    while (rest[i] && ASSIGN_RE.test(rest[i].value)) {
      const n = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest[i].value)![0]
      if (DANGEROUS_VARS.test(n)) innerExtra.push(`altera a variável ${n}`)
      i++
    }
  }
  return {
    own: 'none',
    at: i,
    inner: 'argv',
    label: `via ${name}`,
    ...(innerExtra.length ? { innerExtra } : {}),
    stdin: true,
    layer: false
  }
}

/**
 * A TABELA dos comandos que executam outro código (por basename do programa). Cada entrada
 * desmonta as próprias opções e diz como o resto vira comando (ver `Wrap`). Resumo:
 * - remoto: ssh (item próprio = conexão sem o comando remoto; remoto = script; heredoc/bash -s);
 * - privilégio: sudo, doas, su (item próprio = o comando inteiro; o interno abaixo);
 * - container: docker/podman exec, docker compose exec, docker-compose, kubectl/oc exec;
 * - script: bash/sh/zsh/dash/ksh/mksh/ash -c (e da entrada), watch, script -c;
 * - entrada: xargs (argumentos da entrada no fim do comando, ou no lugar de -I);
 * - prefixos transparentes: env, nice, ionice, time, nohup, command, exec, builtin, noglob,
 *   nocorrect, timeout, stdbuf.
 */
const WRAPPERS = new Map<string, WrapSpec>([
  ['ssh', sshWrap],
  ['sudo', elevateWrap],
  ['doas', elevateWrap],
  ['su', suWrap],
  ['docker', dockerWrap],
  ['podman', dockerWrap],
  ['docker-compose', dockerWrap],
  ['podman-compose', dockerWrap],
  ['kubectl', kubeWrap],
  ['oc', kubeWrap],
  ...['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash'].map((n): [string, WrapSpec] => [
    n,
    shellWrap
  ]),
  ['xargs', xargsWrap],
  ['watch', watchWrap],
  ['script', scriptWrap],
  ...[
    'env',
    'nice',
    'ionice',
    'time',
    'nohup',
    'command',
    'exec',
    'builtin',
    'noglob',
    'nocorrect',
    'timeout',
    'stdbuf'
  ].map((n): [string, WrapSpec] => [n, prefixWrap])
])

/**
 * Pula as opções de sudo/doas. `withArg` = letras que levam argumento. Retorna o índice do
 * comando (≥ rest.length = sem comando) ou -1 se encontrar algo não reconhecido.
 */
function skipOptions(rest: Word[], withArg: string, long: boolean): number {
  let i = 0
  while (i < rest.length) {
    const v = rest[i].value
    if (v === '--') return i + 1
    if (long && /^--[a-z-]+(=.*)?$/.test(v)) {
      if (
        /^--(user|group|host|prompt|close-from|chdir|role|type|other-user|command-timeout)$/.test(v)
      )
        i++
      i++
      continue
    }
    if (!/^-[A-Za-z]+$/.test(v)) return i
    const letters = v.slice(1)
    const k = [...letters].findIndex((l) => withArg.includes(l))
    if (k >= 0 && k === letters.length - 1) i++ // argumento na próxima palavra
    i++
  }
  return i
}

/** Prefixos transparentes: índice do comando dentro de `rest`; -1 = não entendido; null = não é prefixo. */
function unwrap(name: string, rest: Word[]): number | null {
  const v = (i: number): string => rest[i]?.value ?? ''
  let i = 0
  switch (name) {
    case 'nohup':
    case 'builtin':
    case 'noglob':
    case 'nocorrect':
      return 0
    case 'time':
      while (v(i) === '-p') i++
      return i
    case 'command':
      // command -v/-V só consulta: é o próprio comando
      if (rest.some((w) => w.value === '-v' || w.value === '-V')) return null
      while (v(i) === '-p') i++
      return i
    case 'exec':
      while (i < rest.length && v(i).startsWith('-')) {
        if (v(i) === '-a') i++
        else if (!/^-[cl]+$/.test(v(i))) return -1
        i++
      }
      return i
    case 'nice':
      while (i < rest.length && v(i).startsWith('-')) {
        if (v(i) === '-n') i++
        else if (!/^(-\d+|-n\d+|--adjustment=-?\d+)$/.test(v(i))) return -1
        i++
      }
      return i
    case 'ionice':
      // ionice -p PID / -P / -u: muda outro processo (não executa comando)
      if (rest.some((w) => /^(-[pPu]|--(pid|pgid|uid))$/.test(w.value))) return null
      while (i < rest.length && v(i).startsWith('-')) {
        if (/^(-[cn]|--(class|classdata))$/.test(v(i))) i++
        else if (!/^(-t|--ignore|-c\d|-n\d|--class=\S+|--classdata=\S+)$/.test(v(i))) return -1
        i++
      }
      return i
    case 'env':
      while (i < rest.length && v(i).startsWith('-')) {
        if (v(i) === '--') return i + 1
        if (v(i) === '-S' || v(i).startsWith('--split-string') || /^-[a-zA-Z]*S/.test(v(i)))
          return -1
        if (v(i) === '-u' || v(i) === '-C' || v(i) === '--unset' || v(i) === '--chdir') i++
        else if (
          !/^(-[i0v]+|--ignore-environment|--null|-|--unset=.*|--chdir=.*|-u\S+|-C\S+)$/.test(v(i))
        )
          return -1
        i++
      }
      return i
    case 'timeout':
      while (i < rest.length && v(i).startsWith('-')) {
        if (v(i) === '-s' || v(i) === '-k' || v(i) === '--signal' || v(i) === '--kill-after') i++
        else if (
          !/^(--foreground|--preserve-status|-v|--verbose|--signal=.*|--kill-after=.*|-s\S+|-k\S+)$/.test(
            v(i)
          )
        )
          return -1
        i++
      }
      if (!/^\d+(\.\d+)?[smhd]?$/.test(v(i))) return -1
      return i + 1
    case 'stdbuf':
      while (i < rest.length && v(i).startsWith('-')) {
        if (/^-[ioe]$/.test(v(i))) i++
        else if (!/^(-[ioe]\S+|--(input|output|error)=\S+)$/.test(v(i))) return -1
        i++
      }
      return i
    default:
      return null
  }
}

/**
 * Cabeçalhos da árvore: para cada item, o grupo a mostrar ANTES dele ("no servidor x (via ssh)") —
 * quando o grupo muda naquele nível — ou null. Usado no card, no "Testar" e no texto do juiz.
 */
export function groupHeadings(items: { depth?: number; group?: string }[]): (string | null)[] {
  const open: (string | undefined)[] = []
  return items.map((it) => {
    const d = it.depth ?? 0
    const show = !!it.group && open[d] !== it.group
    open[d] = it.group
    open.length = d + 1
    return show ? it.group! : null
  })
}

/**
 * Decomposição em texto (para o juiz do Smart-Approve): um sub-comando por linha, indentado pelo
 * nível, com o grupo antes ("[no servidor x (via ssh)]"), nota e motivo de "nunca automático".
 */
export function describeShell(src: string, maxLines = 60): string {
  const a = analyzeShell(src)
  const heads = groupHeadings(a.commands)
  const lines: string[] = []
  const cut = (s: string): string => (s.length > 300 ? `${s.slice(0, 300)}…` : s)
  a.commands.forEach((c, i) => {
    const pad = '  '.repeat(c.depth ?? 0)
    if (heads[i]) lines.push(`${pad}[${heads[i]}]`)
    const extra = [
      c.note && c.note !== c.group ? c.note : '',
      c.unsafe ? `never automatic: ${c.unsafe}` : ''
    ]
      .filter(Boolean)
      .join('; ')
    lines.push(cut(`${pad}- ${c.text}${extra ? `   (${extra})` : ''}`))
  })
  if (lines.length > maxLines)
    return [...lines.slice(0, maxLines), `… (+${lines.length - maxLines})`].join('\n')
  return lines.join('\n')
}

/** Desmonta `src` em sub-comandos (ver o topo do arquivo). Nunca lança. */
export function analyzeShell(src: string): ShellAnalysis {
  const text = String(src ?? '')
  try {
    const p = new Parser(text)
    p.parseList(null)
    return { commands: p.out }
  } catch (e) {
    const error = e instanceof ParseError ? e.message : `erro interno: ${(e as Error).message}`
    const flat = text.replace(/\s+/g, ' ').trim()
    return {
      error,
      commands: [
        {
          tokens: flat.split(' ').filter(Boolean),
          text: flat,
          unsafe: `não foi possível analisar o comando (${error})`
        }
      ]
    }
  }
}

/**
 * Tokeniza um texto do mesmo jeito que as palavras de um comando (aspas removidas, espaços
 * colapsados). Usado para normalizar comandos digitados no "Testar". Retorna null se inválido.
 */
export function tokenizeWords(src: string): string[] | null {
  const a = analyzeShell(src)
  if (a.error || a.commands.length !== 1) return null
  return a.commands[0].tokens
}
