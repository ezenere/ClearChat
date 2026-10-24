// Servidor FALSO do modo GPU (substitui `resources/gpu-server/server.py serve` nos testes):
// mesmos argumentos (`serve --port N --engines …`), token em CLEARCHAT_GPU_TOKEN exigido em toda
// request, `/health`, `/v1/audio/speech` (PCM em streaming, como o real) e
// `/v1/audio/transcriptions`. Modos por ambiente (FAKE_GPU_MODE):
//   ok (padrão) · exit-on-start (sai com 3 antes de responder) · crash-after:<ms> (cai sozinho)
//   idle-exit-after:<ms> (imprime {"event":"idle-exit"} e sai com 0)
//   warmup-oom (o /v1/warmup devolve os motores pedidos com state "error" — OOM simulado)
// `/health` e `/v1/warmup` devolvem `engines: {id: {state}}` (idle → ready depois do aquecimento).
// FAKE_GPU_COUNTER=<arquivo>: acrescenta uma linha por início (contar reinícios).
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = new Map()
for (let i = 0; i < args.length - 1; i++)
  if (args[i].startsWith('--')) opt.set(args[i], args[i + 1])
const port = Number(opt.get('--port'))
const engines = (opt.get('--engines') || '').split(',').filter(Boolean)
const token = process.env.CLEARCHAT_GPU_TOKEN || ''
/** Motores "carregados" (aquecidos) e os que falharam no aquecimento. */
const loaded = new Set()
const failed = new Map()
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const engineStates = () =>
  Object.fromEntries(
    engines.map((e) => [
      e,
      failed.has(e)
        ? { state: 'error', error: failed.get(e) }
        : { state: loaded.has(e) ? 'ready' : 'idle' }
    ])
  )
const mode = process.env.FAKE_GPU_MODE || 'ok'
if (process.env.FAKE_GPU_COUNTER)
  appendFileSync(process.env.FAKE_GPU_COUNTER, `${engines.join(',')}\n`)

if (mode === 'exit-on-start') {
  process.stderr.write('falha simulada ao importar torch\n')
  process.exit(3)
}

const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'token inválido' } }))
    return
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'ok',
        engines: engineStates()
      })
    )
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/v1/audio/speech') {
      const j = JSON.parse(body || '{}')
      if (!engines.includes(j.model)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'modelo não servido' } }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/pcm;rate=24000;channels=1',
        'X-Voice': String(j.voice ?? '')
      })
      let n = 0
      const t = setInterval(() => {
        res.write(Buffer.alloc(2400, n + 1))
        if (++n >= 4) {
          clearInterval(t)
          res.end()
        }
      }, 10)
      return
    }
    if (req.url === '/v1/audio/transcriptions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: 'claro já vou verificar isso para você agora' }))
      return
    }
    if (req.url === '/v1/warmup') {
      const j = JSON.parse(body || '{}')
      for (const e of (j.engines || engines).filter((x) => engines.includes(x))) {
        if (mode === 'warmup-oom') failed.set(e, 'GPU sem memória (CUDA out of memory)')
        else loaded.add(e)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ engines: engineStates() }))
      return
    }
    if (req.url === '/v1/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, body: JSON.parse(body || '{}') }))
      return
    }
    res.writeHead(404)
    res.end()
  })
})
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ event: 'listening', port }) + '\n')
})
const m = /^(crash-after|idle-exit-after):(\d+)$/.exec(mode)
if (m) {
  setTimeout(() => {
    if (m[1] === 'idle-exit-after') {
      process.stdout.write('{"event": "idle-exit"}\n')
      process.exit(0)
    }
    process.stderr.write('segfault simulado\n')
    process.exit(139)
  }, Number(m[2]))
}
process.on('SIGTERM', () => process.exit(0))
