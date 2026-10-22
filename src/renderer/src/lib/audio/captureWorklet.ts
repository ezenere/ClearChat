// Worklet de captura de áudio (AudioWorklet) — roda no AudioWorkletGlobalScope, fora da thread de
// UI, e só faz o mixdown mono dos quadros de entrada e o envio em lotes para a thread principal
// (via port, transferindo o buffer — sem IPC, sem alocação por quadro).
//
// Importante para o build: este arquivo é empacotado pelo electron-vite via
// `import workletUrl from './captureWorklet.ts?worker&url'` (ver `capture.ts`), que o compila para
// JS e emite um asset `.js` servido ao `audioWorklet.addModule`. Por isso o código usa apenas
// sintaxe TypeScript *apagável* (sem enums/namespaces/propriedades de parâmetro), não tem exports
// (o bundle fica só com o efeito `registerProcessor`) e não importa nada de fora.
// `new URL('./captureWorklet.ts', import.meta.url)` NÃO funciona no build: o Vite embute o fonte
// TypeScript cru como `data:video/mp2t;base64,…` (MIME errado + sintaxe inválida).

declare const registerProcessor: (name: string, processorCtor: unknown) => void

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}

/** Nome registrado do processador — precisa casar com `CAPTURE_PROCESSOR_NAME` em `capture.ts`. */
const PROCESSOR_NAME = 'clearchat-capture'

/** Amostras por mensagem (~10 ms a 48 kHz): lote pequeno o bastante para o nível sair a ~30 Hz. */
const BATCH_SAMPLES = 512

interface CaptureWorkletMessage {
  samples: Float32Array
}

class CaptureProcessor extends AudioWorkletProcessor {
  readonly #batch: Float32Array = new Float32Array(BATCH_SAMPLES)
  #filled = 0

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const first = input[0]
    if (!first || first.length === 0) return true
    const channels = input.length
    for (let i = 0; i < first.length; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) {
        const ch = input[c]
        sum += ch ? ch[i] : 0
      }
      this.#batch[this.#filled++] = sum / channels
      if (this.#filled === BATCH_SAMPLES) this.#flush()
    }
    return true
  }

  #flush(): void {
    const samples = this.#batch.slice(0, this.#filled)
    this.#filled = 0
    const message: CaptureWorkletMessage = { samples }
    this.port.postMessage(message, [samples.buffer])
  }
}

registerProcessor(PROCESSOR_NAME, CaptureProcessor)
