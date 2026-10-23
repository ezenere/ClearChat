// Protocolo de mensagens entre o main e o processo do motor local de STT (`sttWorker.ts`).
// Só tipos (nenhum código em runtime): o worker não importa nada do app além disto, para o bundle
// dele continuar autocontido (sem chunk compartilhado com o main). Ver SPEC → "Runtime local de STT".

/** main → worker. `id` casa a resposta com o pedido. */
export type SttWorkerRequest =
  /** Carrega o binding nativo (`@napi-rs/whisper`) e responde se ele é utilizável. */
  | { id: number; type: 'probe' }
  /**
   * Transcreve as amostras (Float32 mono 16 kHz) com o modelo do caminho dado. O worker mantém UM
   * modelo carregado (cache): caminho diferente descarta o anterior antes de carregar o novo.
   */
  | {
      id: number
      type: 'transcribe'
      modelPath: string
      samples: Float32Array
      /** ISO-639-1 ('pt'); null = detecção automática. */
      language: string | null
      nThreads: number
      /**
       * Contexto do encoder em quadros de 20 ms (ausente/0 = o do modelo, 1500 = 30 s). As parciais
       * mandam ~duração + margem: o whisper sempre codifica 30 s de mel e, com o contexto reduzido,
       * a janela de 1–10 s custa ~3× menos CPU sem perder qualidade (medido — SPEC → "Runtime local
       * de STT"). O worker limita ao contexto do modelo.
       */
      audioCtx?: number
      /** Teto de tokens do texto (ausente/0 = sem teto) — corta laços de repetição nas parciais. */
      maxTokens?: number
    }
  /** Descarta o modelo carregado (libera a referência; o processo segue vivo). */
  | { id: number; type: 'unload' }

/** Categoria do erro do worker (o host traduz em `SttError` legível). */
export type SttWorkerErrorCode =
  /** O binding nativo não carrega nesta instalação/plataforma. */
  | 'runtime'
  /** O arquivo do modelo não abre (inválido/corrompido). */
  | 'model'
  /** Falha na inferência ou pedido inválido. */
  | 'internal'

/** worker → main. */
export type SttWorkerResponse =
  | { id: number; ok: true; value: SttWorkerProbeResult | SttWorkerTranscribeResult | null }
  | { id: number; ok: false; code: SttWorkerErrorCode; message: string }

export interface SttWorkerProbeResult {
  available: boolean
  /** Motivo legível quando `available` é false. */
  reason: string | null
}

export interface SttWorkerTranscribeResult {
  text: string
  /** Tempo de inferência dentro do worker (sem a carga do modelo). */
  inferMs: number
  /** Tempo de carga do modelo nesta chamada (0 = já estava em cache). */
  loadMs: number
}
