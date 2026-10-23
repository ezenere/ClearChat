// Worker falso do motor local de STT (mesmo protocolo de `src/main/voice/sttWorker.ts`) para os
// testes do host (`e2e/sttWorker.test.ts`): sem binding nativo. Comandos pelo conteúdo do pedido:
// - transcribe com samples[0] === 9 → o processo morre (simula crash nativo, exit 3);
// - transcribe com language === 'slow' → responde depois de 150 ms;
// - modelPath contendo 'bad' → erro `model`; contendo 'noruntime' → erro `runtime`.
// O texto devolvido carrega o pid (o teste confere o respawn) e o modelo carregado.
let loaded = null
process.on('message', async (req) => {
  if (!req || typeof req.id !== 'number') return
  if (req.type === 'probe')
    return process.send?.({ id: req.id, ok: true, value: { available: true, reason: null } })
  if (req.type === 'unload') {
    loaded = null
    return process.send?.({ id: req.id, ok: true, value: null })
  }
  if (req.type === 'transcribe') {
    if (req.modelPath.includes('bad'))
      return process.send?.({ id: req.id, ok: false, code: 'model', message: 'arquivo inválido' })
    if (req.modelPath.includes('noruntime'))
      return process.send?.({ id: req.id, ok: false, code: 'runtime', message: 'sem .node' })
    if (!(req.samples instanceof Float32Array))
      return process.send?.({
        id: req.id,
        ok: false,
        code: 'internal',
        message: 'sem Float32Array'
      })
    if (req.samples[0] === 9) process.exit(3)
    if (req.language === 'slow') await new Promise((r) => setTimeout(r, 150))
    const loadMs = loaded === req.modelPath ? 0 : 1
    loaded = req.modelPath
    return process.send?.({
      id: req.id,
      ok: true,
      value: {
        text: `pid:${process.pid} n:${req.samples.length} m:${req.modelPath}`,
        inferMs: 1,
        loadMs
      }
    })
  }
})
process.on('disconnect', () => process.exit(0))
