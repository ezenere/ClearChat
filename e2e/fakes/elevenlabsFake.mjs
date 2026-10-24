// Servidor FAKE da ElevenLabs para os testes (sem rede, sem chave real): REST (`/v1/models`,
// `/v1/voices[/:id]`, `/v1/user`, `POST /v1/text-to-speech/:voice[/stream]`) + o WebSocket
// multi-contexto (`/v1/text-to-speech/:voice/multi-stream-input`), validando as mensagens do
// protocolo (init `text: ' '`, pedaços terminando em espaço, `flush`, `close_context`,
// `close_socket`) e devolvendo PCM16 24 kHz falso (senoide) em base64 com atrasos configuráveis.
// Usado por `e2e/elevenlabs.test.ts` e pelo benchmark local. `ws` já é devDependency.
/* eslint-disable @typescript-eslint/explicit-function-return-type -- JS puro (sem tipos de retorno) */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')

/** Amostras por char (PCM falso): 240 = 10 ms de áudio por char a 24 kHz. */
const DEFAULT_SAMPLES_PER_CHAR = 240

/** PCM16 LE mono (senoide 220 Hz) com `samples` amostras; `phase` continua entre pedaços. */
function sine(samples, phase = 0) {
  const b = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin(((phase + i) * 2 * Math.PI * 220) / 24000) * 8000)
    b.writeInt16LE(v, i * 2)
  }
  return b
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Sobe o fake. Opções:
 * - `apiKey` (padrão 'test-key'); `voices` ({ id: nome }); `models` (lista do /v1/models)
 * - `samplesPerChar`, `chunkSamples` (tamanho de cada frame de áudio; padrão 2400 = 100 ms)
 * - `firstAudioDelayMs` (flush → 1º áudio; padrão 20), `chunkDelayMs` (entre frames; padrão 5)
 * - `mode`: 'ok' | 'quota' (frame de erro de cota) | 'quotaMid' (cota acaba NO MEIO do áudio: 1º
 *   frame de áudio sai, depois o frame de erro `quota_exceeded` e o socket fecha) | 'rejectUpgrade'
 *   (handshake 403)
 * - `idleCloseMs` (fecha o socket ocioso — simula o `inactivity_timeout`)
 * - `dropOnFirstFlush` (derruba a 1ª conexão no 1º flush, antes do áudio — testa o reenvio)
 * - `alignment` (padrão true): alinhamento de caracteres junto do áudio, como o da ElevenLabs
 * - `planTier` (padrão 'pro'): 'creator' recusa os formatos do Pro (`pcm_44100`) com o 403
 *   `output_format_not_allowed` exato da API (REST) / frame de erro + fechamento (WebSocket)
 */

/** Formatos PCM aceitos (o fake gera o mesmo PCM falso — a taxa só muda o cabeçalho do cliente). */
const PCM_FORMAT = /^pcm_(8000|16000|22050|24000|32000|44100|48000)$/
const PRO_FORMATS = new Set(['pcm_44100', 'wav_44100'])
const formatNotAllowed = (f) => ({
  detail: {
    type: 'authorization_error',
    code: 'subscription_required',
    message: `Output format '${f}' is only available on the Pro tier and above.`,
    status: 'output_format_not_allowed',
    request_id: 'fake'
  }
})
export async function startElevenLabsFake(opts = {}) {
  const state = {
    apiKey: opts.apiKey ?? 'test-key',
    voices: opts.voices ?? { EXAVITQu4vr4xnSDxMaL: 'Sarah', JBFqnCBsd6RMkjVDRZzb: 'George' },
    models: opts.models ?? [
      {
        model_id: 'eleven_flash_v2_5',
        name: 'Eleven Flash v2.5',
        can_do_text_to_speech: true,
        languages: [{ language_id: 'pt', name: 'Portuguese' }]
      },
      {
        model_id: 'eleven_multilingual_v2',
        name: 'Eleven Multilingual v2',
        can_do_text_to_speech: true
      },
      { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true },
      { model_id: 'scribe_v1', name: 'Scribe', can_do_text_to_speech: false }
    ],
    planTier: opts.planTier ?? 'pro',
    samplesPerChar: opts.samplesPerChar ?? DEFAULT_SAMPLES_PER_CHAR,
    chunkSamples: opts.chunkSamples ?? 2400,
    firstAudioDelayMs: opts.firstAudioDelayMs ?? 20,
    chunkDelayMs: opts.chunkDelayMs ?? 5,
    mode: opts.mode ?? 'ok',
    idleCloseMs: opts.idleCloseMs ?? 0,
    dropOnFirstFlush: !!opts.dropOnFirstFlush,
    alignment: opts.alignment !== false
  }
  /** Requests REST recebidas (método, caminho, query, headers, corpo). */
  const requests = []
  /** Conexões WS: { url, query, headerKey, frames: [], closed, closeCode } */
  const connections = []
  /** Violações do protocolo percebidas (os testes exigem vazio). */
  const protocolErrors = []
  /** Pico de contextos gerando ao mesmo tempo numa conexão. */
  let maxActive = 0
  let flushCount = 0

  const authOk = (key) => !!key && key === state.apiKey
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const unauthorized = (res) =>
    json(res, 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } })

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: { ...req.headers },
        body
      })
      const key = req.headers['xi-api-key']
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        if (!authOk(key)) return unauthorized(res)
        return json(res, 200, state.models)
      }
      if (url.pathname === '/v1/user' && req.method === 'GET') {
        if (!authOk(key)) return unauthorized(res)
        return json(res, 200, { subscription: { tier: 'free' } })
      }
      if (url.pathname === '/v1/voices' && req.method === 'GET') {
        if (!authOk(key)) return unauthorized(res)
        return json(res, 200, {
          voices: Object.entries(state.voices).map(([voice_id, name]) => ({
            voice_id,
            name,
            category: 'premade',
            labels: { accent: 'american', gender: 'female' },
            preview_url: `https://example.invalid/${voice_id}.mp3`
          }))
        })
      }
      let m = /^\/v1\/voices\/([^/]+)$/.exec(url.pathname)
      if (m && req.method === 'GET') {
        if (!authOk(key)) return unauthorized(res)
        if (!state.voices[m[1]])
          return json(res, 404, {
            detail: {
              status: 'voice_not_found',
              message: `A voice with the voice_id ${m[1]} was not found.`
            }
          })
        return json(res, 200, { voice_id: m[1], name: state.voices[m[1]] })
      }
      m = /^\/v1\/text-to-speech\/([^/]+)(\/stream)?$/.exec(url.pathname)
      if (m && req.method === 'POST') {
        if (!authOk(key)) return unauthorized(res)
        if (state.mode === 'quota')
          return json(res, 429, {
            detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' }
          })
        if (!state.voices[m[1]])
          return json(res, 404, {
            detail: { status: 'voice_not_found', message: 'A voice with that id was not found.' }
          })
        let j
        try {
          j = JSON.parse(body)
        } catch {
          return json(res, 400, { detail: { status: 'invalid_json', message: 'bad json' } })
        }
        if (typeof j.text !== 'string' || !j.text.trim())
          return json(res, 400, { detail: { status: 'invalid_text', message: 'text required' } })
        const fmt = url.searchParams.get('output_format') ?? ''
        if (!PCM_FORMAT.test(fmt)) protocolErrors.push(`REST output_format=${fmt}`)
        if (state.planTier !== 'pro' && PRO_FORMATS.has(fmt))
          return json(res, 403, formatNotAllowed(fmt))
        const total = j.text.length * state.samplesPerChar
        res.writeHead(200, { 'content-type': 'audio/pcm' })
        let sent = 0
        while (sent < total) {
          const n = Math.min(state.chunkSamples, total - sent)
          res.write(sine(n, sent))
          sent += n
          if (m[2]) await sleep(state.chunkDelayMs)
        }
        return res.end()
      }
      json(res, 404, { detail: { status: 'not_found', message: 'not found' } })
    })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    const m = /^\/v1\/text-to-speech\/([^/]+)\/multi-stream-input$/.exec(url.pathname)
    if (!m || state.mode === 'rejectUpgrade') {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, url, m[1]))
  })

  function onConnection(ws, req, url, voiceId) {
    const conn = {
      index: connections.length,
      url: req.url,
      query: Object.fromEntries(url.searchParams),
      voiceId,
      headerKey: req.headers['xi-api-key'] ?? null,
      frames: [],
      closed: false,
      closeCode: null,
      clientClosed: false
    }
    connections.push(conn)
    if (!PCM_FORMAT.test(conn.query.output_format ?? ''))
      protocolErrors.push(`WS output_format=${conn.query.output_format}`)
    if (!conn.query.model_id) protocolErrors.push('WS sem model_id')
    /** contextos: id → { buffer, flushed, closed, generating, sentSamples, finalSent } */
    const contexts = new Map()
    let authed = authOk(conn.headerKey)
    let first = true
    let idleTimer = null
    const armIdle = () => {
      if (!state.idleCloseMs) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (ws.readyState === 1) ws.close(1000, 'inactivity timeout')
      }, state.idleCloseMs)
    }
    armIdle()
    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj))
    }
    const activeCount = () =>
      [...contexts.values()].filter((c) => c.started && !c.finalSent && !c.dropped).length

    async function generate(cid, ctx, text) {
      // gera áudio para `text` (sequencial por contexto). Alinhamento como o da ElevenLabs: cada
      // frame traz os chars que COMEÇAM nele, com tempos relativos ao 1º deles (blocos
      // consecutivos — cada um começa onde o anterior terminou); frame sem começo de char vai sem
      // alinhamento. `alignment: false` nas opções desliga (proxy/modelo sem alinhamento).
      ctx.queue = (ctx.queue ?? Promise.resolve()).then(async () => {
        await sleep(state.firstAudioDelayMs)
        const spc = state.samplesPerChar
        const msPerChar = (spc / 24000) * 1000
        const total = text.length * spc
        let sent = 0
        let nextChar = 0
        while (sent < total) {
          if (ctx.dropped || ws.readyState !== 1) return
          const n = Math.min(state.chunkSamples, total - sent)
          const chars = []
          while (nextChar < text.length && nextChar * spc < sent + n) chars.push(text[nextChar++])
          send({
            audio: sine(n, ctx.sentSamples).toString('base64'),
            contextId: cid,
            alignment:
              state.alignment && chars.length
                ? {
                    chars,
                    charStartTimesMs: chars.map((_, i) => i * msPerChar),
                    charDurationsMs: chars.map(() => msPerChar)
                  }
                : null,
            normalizedAlignment: null
          })
          ctx.sentSamples += n
          sent += n
          if (state.mode === 'quotaMid') {
            // créditos acabaram no meio da sentença (o que já saiu tocou)
            send({
              message: 'This request exceeds your quota of 10000. You have 0 credits remaining.',
              error: 'quota_exceeded',
              code: 1008
            })
            ws.close(1008, 'quota_exceeded')
            return
          }
          await sleep(state.chunkDelayMs)
        }
      })
      return ctx.queue
    }

    ws.on('message', async (raw) => {
      armIdle()
      let j
      try {
        j = JSON.parse(String(raw))
      } catch {
        protocolErrors.push(`frame não-JSON: ${String(raw).slice(0, 40)}`)
        return
      }
      conn.frames.push(j)
      if (first) {
        first = false
        if (!authed && typeof j.xi_api_key === 'string') authed = authOk(j.xi_api_key)
        if (!authed) {
          send({ message: 'Invalid API key', error: 'invalid_api_key', code: 1008 })
          ws.close(1008, 'Invalid API key')
          return
        }
        if (!state.voices[voiceId]) {
          send({ message: `voice_id ${voiceId} not found`, error: 'voice_not_found', code: 1008 })
          ws.close(1008, 'voice_not_found')
          return
        }
        if (state.planTier !== 'pro' && PRO_FORMATS.has(conn.query.output_format)) {
          const d = formatNotAllowed(conn.query.output_format).detail
          send({ message: d.message, error: d.status, code: 1008 })
          ws.close(1008, d.status)
          return
        }
        if (state.mode === 'quota') {
          send({
            message: 'This request exceeds your quota of 10000.',
            error: 'quota_exceeded',
            code: 1008
          })
          ws.close(1008, 'quota_exceeded')
          return
        }
      }
      if (j.close_socket === true) {
        ws.close(1000, 'close_socket')
        return
      }
      const cid = j.context_id
      if (typeof cid !== 'string' || !cid) {
        protocolErrors.push(`frame sem context_id: ${JSON.stringify(j).slice(0, 80)}`)
        return
      }
      let ctx = contexts.get(cid)
      if (j.close_context === true) {
        if (!ctx) {
          protocolErrors.push(`close_context de contexto desconhecido ${cid}`)
          return
        }
        ctx.closed = true
        if (!ctx.flushed) {
          // descartado sem flush: o buffer cai fora, sem isFinal
          ctx.dropped = true
          return
        }
        await ctx.queue
        if (!ctx.finalSent && !ctx.dropped) {
          ctx.finalSent = true
          send({ isFinal: true, contextId: cid })
        }
        return
      }
      if (!ctx) {
        // 1º frame do contexto: init com text ' '
        if (j.text !== ' ')
          protocolErrors.push(`init de ${cid} sem text ' ' (${JSON.stringify(j.text)})`)
        const sched = j.generation_config?.chunk_length_schedule
        if (!Array.isArray(sched) || sched.some((n) => n < 50 || n > 500))
          protocolErrors.push(`chunk_length_schedule inválido em ${cid}`)
        ctx = {
          buffer: '',
          flushed: false,
          closed: false,
          started: true,
          sentSamples: 0,
          finalSent: false,
          dropped: false,
          generated: 0,
          queue: Promise.resolve(),
          schedule: sched ?? [120]
        }
        contexts.set(cid, ctx)
        maxActive = Math.max(maxActive, activeCount())
        return
      }
      if (ctx.closed) {
        protocolErrors.push(`texto depois do close_context em ${cid}`)
        return
      }
      if (typeof j.text !== 'string') {
        protocolErrors.push(`frame de texto sem text em ${cid}`)
        return
      }
      if (j.text && !/\s$/.test(j.text))
        protocolErrors.push(`pedaço sem espaço final: ${JSON.stringify(j.text)}`)
      ctx.buffer += j.text
      if (j.flush === true) {
        ctx.flushed = true
        flushCount++
        if (state.dropOnFirstFlush && conn.index === 0) {
          ws.terminate()
          return
        }
        const text = ctx.buffer.trim()
        ctx.buffer = ''
        if (text) await generate(cid, ctx, text)
        return
      }
      // chunk_length_schedule: com o 1º limiar atingido, gera o que já tem (áudio antes do flush)
      const limit = ctx.schedule[Math.min(ctx.generated, ctx.schedule.length - 1)]
      if (ctx.buffer.length >= limit) {
        const text = ctx.buffer.trim()
        ctx.buffer = ''
        ctx.generated++
        void generate(cid, ctx, text)
      }
    })
    ws.on('close', (code) => {
      clearTimeout(idleTimer)
      conn.closed = true
      conn.closeCode = code
      for (const c of contexts.values()) c.dropped = true
    })
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    requests,
    connections,
    protocolErrors,
    get maxActive() {
      return maxActive
    },
    get flushCount() {
      return flushCount
    },
    /** Todos os frames de texto (sem init) de todas as conexões, na ordem. */
    textFrames() {
      return connections.flatMap((c) =>
        c.frames.filter((f) => (typeof f.text === 'string' && f.text !== ' ') || f.flush)
      )
    },
    async close() {
      for (const c of wss.clients) c.terminate()
      wss.close()
      await new Promise((r) => server.close(() => r()))
    }
  }
}
