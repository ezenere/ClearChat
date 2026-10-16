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
// - `bash|sh|zsh|dash|ksh -c "…"` (a string interna é analisada como linha de comando);
// - prefixos `env`, `nice`, `time`, `nohup`, `command`, `exec`, `builtin`, `timeout`, `stdbuf`
//   (avalia o comando depois deles); `sudo`/`doas` viram DOIS sub-comandos: `sudo …` inteiro (precisa
//   casar com a lista por si só) e o comando interno;
// - atribuições `VAR=v cmd` (avalia `cmd`; variáveis perigosas como PATH, LD_PRELOAD → `unsafe`);
// - palavras reservadas simples (`if/then/else/elif/fi/while/until/do/done/!/{/}`) são puladas e o
//   cabeçalho de `for/select NAME in …` não é comando.
// Sempre `unsafe`: eval, source/., xargs, find -exec/-execdir/-ok/-okdir, fd -x/-X, alias, function/
// definição `f() …`, trap, fc, coproc, watch, parallel, case, process substitution, heredoc que
// alimenta algo que não seja um consumidor de dados conhecido (cat, grep…) ou com substituição no
// corpo, redirecionamento de saída para arquivo (≠ /dev/null, /dev/stdout, /dev/stderr, &N),
// nome de comando vindo de expansão/glob (`$x args`, `./r*`), expansão de chaves `{a,b}` em
// qualquer palavra, `=cmd` do zsh, glob qualifiers/
// extglob `*(…)`, substituição dentro de `$(( … ))`.

export interface ShellCommand {
  /** Palavras do comando avaliado, sem aspas (redirecionamentos/atribuições/prefixos removidos). */
  tokens: string[]
  /** Texto para exibição: as palavras como escritas (aspas preservadas), espaços colapsados. */
  text: string
  /** Contexto: "dentro de $(…)", "via bash -c", "sob sudo"… */
  note?: string
  /** Motivo pelo qual NUNCA é liberado automaticamente (sempre pergunta). */
  unsafe?: string
}

export interface ShellAnalysis {
  commands: ShellCommand[]
  /** Erro de sintaxe (aí `commands` tem um item só, com o texto inteiro e `unsafe`). */
  error?: string
}

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

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash'])

const ALWAYS_UNSAFE: Record<string, string> = {
  let: 'let avalia aritmética (o valor de uma variável pode executar código)',
  eval: 'eval executa texto arbitrário',
  source: 'source executa um arquivo de comandos',
  '.': '. (source) executa um arquivo de comandos',
  xargs: 'xargs executa comandos montados a partir da entrada',
  alias: 'define um alias',
  function: 'define uma função',
  trap: 'trap registra comandos para depois',
  fc: 'fc reexecuta comandos do histórico',
  coproc: 'coproc',
  watch: 'watch executa um comando em texto',
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
  if (/^[A-Za-z0-9_@%+=:,./~^-]+$/.test(token)) return token
  return `'${token.replace(/'/g, `'\\''`)}'`
}

class Parser {
  pos = 0
  out: ShellCommand[] = []
  private notes: string[] = []
  private heredocs: { delim: string; strip: boolean; quoted: boolean; cmd: Pending }[] = []
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
    }
  }

  private redirect(cmd: Pending, tok: { op: string; fd: string }): void {
    const target = this.next()
    if (target.t !== 'word') throw new ParseError(`redirecionamento "${tok.op}" sem destino`)
    const w = target.w
    cmd.redirs.push(`${tok.fd}${tok.op}${w.raw}`)
    if (w.unsafe) cmd.unsafe.push(w.unsafe)
    const op = tok.op
    if (op === '<<' || op === '<<-') {
      cmd.heredoc = true
      this.heredocs.push({ delim: w.value, strip: op === '<<-', quoted: w.quoted, cmd })
      return
    }
    if (op === '<' || op === '<<<' || op === '<&') return
    // saída: > >> >| <> &> &>> >&
    if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(w.value)) return
    if (SAFE_REDIR_TARGETS.has(w.value) && !w.expansion) return
    cmd.unsafe.push(`redireciona para arquivo: ${w.raw}`)
  }

  /** Fecha um comando simples: aplica palavras reservadas, atribuições, prefixos e regras. */
  private finish(cmd: Pending): void {
    let words = cmd.words
    const note = this.note
    const push = (ws: Word[], extraUnsafe: string[], n?: string): void => {
      const unsafe = [
        ...cmd.unsafe,
        ...extraUnsafe,
        ...ws.flatMap((w) => w.unsafe ?? []),
        ...ws.flatMap((w) => (w.indirect ? [w.indirect] : []))
      ]
      const nn = n ?? note
      const c: ShellCommand = {
        tokens: ws.map((w) => w.value),
        text: [...ws.map((w) => w.raw), ...cmd.redirs].join(' ').replace(/\s+/g, ' ').trim(),
        ...(nn ? { note: nn } : {}),
        ...(unsafe.length ? { unsafe: [...new Set(unsafe)].join('; ') } : {})
      }
      ;(cmd.emitted ??= []).push(c)
      this.out.push(c)
    }
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
      if (cmd.unsafe.length) push(words, [])
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
      if (dangerous.length || cmd.unsafe.length) push(assigns, dangerous)
      return
    }
    this.command(words, dangerous, push, cmd)
  }

  private command(
    words: Word[],
    extra: string[],
    push: (ws: Word[], extraUnsafe: string[], n?: string) => void,
    cmd: Pending,
    hops = 0
  ): void {
    const first = words[0]
    if (hops > 6) {
      push(words, [...extra, 'prefixos demais'])
      return
    }
    if (first.expansion || first.glob) {
      push(words, [...extra, 'o nome do comando vem de expansão/glob'])
      return
    }
    if (first.value.startsWith('=') && !first.quoted) {
      push(words, [...extra, '=comando (expansão do zsh)'])
      return
    }
    const name = baseName(first.value)
    const unsafeWhy = ALWAYS_UNSAFE[first.value] ?? ALWAYS_UNSAFE[name]
    if (unsafeWhy) {
      push(words, [...extra, unsafeWhy])
      return
    }
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
          return push(words, [
            ...extra,
            '[[ … -eq/-lt … ]] com variável avalia aritmética (o valor pode executar código)'
          ])
      }
    }
    if (name === 'hash' && rest.some((w) => /^-[a-zA-Z]*p/.test(w.value)))
      return push(words, [...extra, 'hash -p troca o programa de um comando'])
    if (name === 'find' && rest.some((w) => /^-(exec|execdir|ok|okdir)$/.test(w.value))) {
      push(words, [...extra, 'find com -exec/-execdir/-ok executa comandos'])
      return
    }
    if (name === 'fd' && rest.some((w) => /^(-x|-X|--exec|--exec-batch)$/.test(w.value))) {
      push(words, [...extra, 'fd com --exec executa comandos'])
      return
    }
    if (cmd.heredoc && !HEREDOC_DATA.has(name)) {
      push(words, [...extra, `heredoc alimentando ${name}`])
      return
    }
    // sudo/doas: o comando inteiro é um sub-comando E o interno também
    if (name === 'sudo' || name === 'doas') {
      const i = skipOptions(rest, name === 'sudo' ? 'uUgpChDrtTR' : 'uC', name === 'sudo')
      if (i < 0) return push(words, [...extra, `opções de ${name} não reconhecidas`])
      push(words, extra)
      if (i >= rest.length) return
      return this.command(rest.slice(i), [], push, cmd, hops + 1)
    }
    // prefixos transparentes
    const wrap = unwrap(name, rest)
    if (wrap !== null) {
      if (wrap === -1)
        return push(words, [...extra, `não foi possível achar o comando após ${name}`])
      if (wrap >= rest.length) return push(words, extra) // `env`, `time` sozinhos
      let inner = rest.slice(wrap)
      if (name === 'env') {
        const as: Word[] = []
        while (inner[0] && ASSIGN_RE.test(inner[0].value)) {
          as.push(inner[0])
          inner = inner.slice(1)
        }
        const bad = as
          .map((a) => /^[A-Za-z_][A-Za-z0-9_]*/.exec(a.value)![0])
          .filter((n) => DANGEROUS_VARS.test(n))
          .map((n) => `altera a variável ${n}`)
        extra = [...extra, ...bad]
        if (!inner.length) return push(words, extra)
      }
      const n = `via ${name}`
      return this.command(inner, extra, (ws, ex, nn) => push(ws, ex, nn ?? n), cmd, hops + 1)
    }
    // bash -c "…"
    if (SHELLS.has(name)) {
      let script: Word | undefined
      let ok = true
      for (let i = 0; i < rest.length; i++) {
        const v = rest[i].value
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(v)) {
          script = rest[i + 1]
          break
        }
        if (v === '-o' || v === '+o' || v === '-O' || v === '+O') {
          i++
          continue
        }
        if (/^[-+][a-zA-Z]+$/.test(v) || /^--(login|norc|noprofile|posix|norc)$/.test(v)) continue
        ok = false // `bash script.sh` ou opção desconhecida: comando comum
        break
      }
      // shell sem -c e sem script (ou com -s): lê comandos da entrada (ex.: `curl … | sh`)
      if (
        !script &&
        (rest.every((w) => /^[-+]/.test(w.value)) || rest.some((w) => w.value === '-s'))
      )
        return push(words, [...extra, `${name} lendo comandos da entrada`])
      if (script && ok) {
        if (script.expansion) return push(words, [...extra, `script de ${name} -c vem de expansão`])
        let p: Parser
        try {
          p = new Parser(script.value, this.depth + 1)
          p.notes = [`via ${name} -c`]
          p.parseList(null)
        } catch (e) {
          return push(words, [
            ...extra,
            `não foi possível analisar o script de ${name} -c: ${(e as Error).message}`
          ])
        }
        if (extra.length || cmd.unsafe.length) push(words, extra)
        for (const c of p.out) this.out.push(c)
        return
      }
    }
    push(words, extra)
  }
}

interface Pending {
  words: Word[]
  redirs: string[]
  unsafe: string[]
  heredoc?: boolean
  /** Sub-comandos já emitidos por este comando (heredoc lido depois pode marcá-los). */
  emitted?: ShellCommand[]
}
const newPending = (): Pending => ({ words: [], redirs: [], unsafe: [] })

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
