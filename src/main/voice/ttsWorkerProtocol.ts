// Protocolo de mensagens entre o main e o processo do motor local de TTS (`ttsWorker.ts`).
// Só tipos (nenhum código em runtime): o worker importa só isto, `kokoroCore.ts` e `wav.ts` (puros),
// para o bundle dele não puxar nada do main. Ver SPEC → "Serviço de TTS → Processo do motor local".

/** main → worker. `id` casa a resposta com o pedido. */
export type TtsWorkerRequest =
  /** Carrega o binding nativo (`onnxruntime-node`) e responde se ele é utilizável. */
  | { id: number; type: 'probe' }
  /**
   * Sintetiza `text` com o modelo/voz dos caminhos dados e devolve o WAV 24 kHz mono. O worker
   * mantém UMA sessão ONNX carregada (caminho diferente solta a anterior) e os voice packs em cache.
   */
  | { id: number; type: 'synthesize'; modelPath: string; voicePath: string; text: string }
  /**
   * Cancela o pedido `target`: se ele ainda não começou a inferência, sai com erro `aborted` (a
   * inferência em curso não é interrompível — o host descarta a resposta).
   */
  | { id: number; type: 'cancel'; target: number }
  /** Solta a sessão e os voice packs carregados (o processo segue vivo). */
  | { id: number; type: 'unload' }

/** Categoria do erro do worker (o host traduz em `TtsError` `config` legível). */
export type TtsWorkerErrorCode =
  | 'runtime' // onnxruntime-node não carrega nesta instalação/plataforma
  | 'model' // modelo/voz inválidos (arquivo corrompido, banco de estilos curto)
  | 'espeak-missing' // espeak-ng ausente (mensagem já traz a dica da plataforma)
  | 'espeak' // falha/tempo esgotado na fonemização
  | 'input' // texto sem fonemas / fora do vocabulário / áudio vazio
  | 'aborted' // cancelado antes da inferência
  | 'internal' // demais falhas / pedido inválido

/** worker → main. */
export type TtsWorkerResponse =
  | { id: number; ok: true; value: TtsWorkerProbeResult | TtsWorkerSynthResult | null }
  | { id: number; ok: false; code: TtsWorkerErrorCode; message: string }

export interface TtsWorkerProbeResult {
  available: boolean
  /** Motivo legível quando `available` é false. */
  reason: string | null
}

export interface TtsWorkerSynthResult {
  /** WAV PCM16 mono a `sampleRate`. */
  audio: Uint8Array
  sampleRate: number
  /** Fonemização (espeak-ng) dentro do worker. */
  phonemeMs: number
  /** Inferência ONNX dentro do worker. */
  inferMs: number
  /** Carga da sessão nesta chamada (0 = já estava em cache). */
  loadMs: number
}
