// Servidor de transcrição (STT) FALSO para testes: responde o endpoint OpenAI-compatível
// `/audio/transcriptions` (qualquer baseUrl) com um texto fixo e registra cada request (headers e
// corpo multipart bruto, para conferir model/language/file/Authorization nos testes).
//
// Roda em Node puro (type stripping): só `import type`, sem enums/namespaces.
//
// Uso:
//   const srv = await startFakeSttServer({ text: 'ISTO É UM DITADO DE TESTE', requireKey: 'k' })
//   … app com sttSettings.api.baseUrl = srv.url …
//   srv.hits[0].body
//   await srv.close()
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeSttHit {
  path: string
  method: string
  headers: Record<string, string | string[] | undefined>
  /** Corpo multipart bruto (conferir `name="model"` etc. por includes). */
  body: string
}

export interface FakeSttServer {
  /** `sttSettings.api.baseUrl` para apontar para aqui (termina em `/v1`). */
  url: string
  /** Requests em `/audio/transcriptions`, na ordem. */
  hits: FakeSttHit[]
  close(): Promise<void>
}

export interface FakeSttOptions {
  /** Texto devolvido em `text` (padrão fixo de teste). */
  text?: string
  /** Se definido, só responde 200 com `Authorization: Bearer <requireKey>` (senão 401). */
  requireKey?: string
  /** Atraso artificial da resposta, em ms (padrão 0). */
  delayMs?: number
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })

export async function startFakeSttServer(opts: FakeSttOptions = {}): Promise<FakeSttServer> {
  const text = opts.text ?? 'ISTO É UM DITADO DE TESTE'
  const hits: FakeSttHit[] = []
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0]
      const body = await readBody(req)
      hits.push({ path, method: req.method ?? '', headers: req.headers, body })
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      if (!/\/audio\/transcriptions$/.test(path)) return json(res, 404, { error: 'not found' })
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (opts.requireKey && req.headers.authorization !== `Bearer ${opts.requireKey}`)
        return json(res, 401, {
          error: { message: 'Invalid API key', type: 'invalid_request_error' }
        })
      return json(res, 200, { text })
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    hits,
    close: () =>
      new Promise((r) => {
        server.close(() => r())
        server.closeAllConnections?.()
      })
  }
}
