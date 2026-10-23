// Worker falso do motor local de TTS (mesmo protocolo de `src/main/voice/ttsWorker.ts`) para os
// testes do host (`e2e/ttsWorker.test.ts`): sem onnxruntime. Comandos pelo conteúdo do pedido:
// - text 'crash' → o processo morre (simula crash nativo, exit 3);
// - text começando com 'slow' → bloqueia o processo por 150 ms (como o session.run do ORT);
// - modelPath contendo 'bad' → erro `model`; 'noruntime' → `runtime`; text 'noespeak' → `espeak-missing`.
// O "WAV" devolvido carrega o pid e o texto (o teste confere o respawn). Pedidos em série; `cancel`
// marca o alvo na chegada (fora da fila), como o worker real.
let lastDone = 0
const cancelled = new Set()
let chain = Promise.resolve()
process.on('message', (req) => {
  if (!req || typeof req.id !== 'number') return
  if (req.type === 'cancel') {
    if (req.target > lastDone) cancelled.add(req.target)
    return
  }
  chain = chain.then(async () => {
    // deixa as mensagens já recebidas (ex.: cancel) serem processadas antes da vez deste pedido
    await new Promise((r) => setImmediate(r))
    try {
      if (cancelled.has(req.id))
        return process.send?.({ id: req.id, ok: false, code: 'aborted', message: 'cancelado' })
      if (req.type === 'probe')
        return process.send?.({ id: req.id, ok: true, value: { available: true, reason: null } })
      if (req.type === 'unload') return process.send?.({ id: req.id, ok: true, value: null })
      if (req.type !== 'synthesize')
        return process.send?.({ id: req.id, ok: false, code: 'internal', message: '?' })
      if (req.modelPath.includes('bad'))
        return process.send?.({ id: req.id, ok: false, code: 'model', message: 'arquivo inválido' })
      if (req.modelPath.includes('noruntime'))
        return process.send?.({ id: req.id, ok: false, code: 'runtime', message: 'sem .node' })
      if (req.text === 'noespeak')
        return process.send?.({
          id: req.id,
          ok: false,
          code: 'espeak-missing',
          message: 'espeak-ng não encontrado no sistema'
        })
      if (req.text === 'crash') process.exit(3)
      if (req.text.startsWith('slow')) {
        const end = Date.now() + 150
        while (Date.now() < end) {
          /* ocupado (bloqueio síncrono) */
        }
      }
      const audio = new TextEncoder().encode(`pid:${process.pid} t:${req.text}`)
      return process.send?.({
        id: req.id,
        ok: true,
        value: { audio, sampleRate: 24000, phonemeMs: 1, inferMs: 1, loadMs: 0 }
      })
    } finally {
      cancelled.delete(req.id)
      lastDone = Math.max(lastDone, req.id)
    }
  })
})
process.on('disconnect', () => process.exit(0))
