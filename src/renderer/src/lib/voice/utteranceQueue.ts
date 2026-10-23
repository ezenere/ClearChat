// Fila de utterances da chamada de voz (renderer): toca os bytes wav/mp3 das sentenças na ordem,
// SEM sobreposição, com estados `idle`/`playing`. Barge-in = `cancel()` (pausa o atual e descarta
// a fila). O player é injetável (testes usam fake; a fábrica padrão é `new Audio` com blob URL,
// liberado ao terminar). Ver SPEC.md → "Áudio → Chamada de voz (meia-duplex)".
import type { VoiceCallUtteranceEvent } from '@shared/ipc'

export type UtteranceState = 'idle' | 'playing'

/** Player de uma utterance (o mínimo que a fila precisa — `new Audio` satisfaz). */
export interface UtterancePlayer {
  play(): void | Promise<void>
  pause(): void
  /** O áudio terminou (toque completo). */
  onended: (() => void) | null
  /** Falha ao carregar/tocar (a fila segue para a próxima). */
  onerror: (() => void) | null
  /** Volume 0..1 (a fila propaga `setVolume`). */
  volume: number
  /** Libera recursos (blob URL etc.) — chamado ao terminar/cancelar. */
  dispose?(): void
}

/** Fábrica de player por utterance (bytes + mime → player pronto para `play`). */
export type PlayerFactory = (audio: Uint8Array, mime: string) => UtterancePlayer

/** Player padrão: blob URL + `new Audio` (sem dependências; liberado no `dispose`). */
class DomAudioPlayer implements UtterancePlayer {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly #el: HTMLAudioElement
  readonly #url: string

  constructor(audio: Uint8Array, mime: string) {
    // cópia exata: o buffer de origem pode ser uma visão maior (bytes do IPC)
    const copy = audio.slice()
    this.#url = URL.createObjectURL(new Blob([copy], { type: mime }))
    this.#el = new Audio(this.#url)
    this.#el.onended = () => this.onended?.()
    this.#el.onerror = () => this.onerror?.()
  }

  get volume(): number {
    return this.#el.volume
  }

  set volume(v: number) {
    this.#el.volume = v
  }

  /** Devolve a promise do `<audio>`: rejeição (autoplay/decodificação) chega à fila, que avança. */
  play(): Promise<void> {
    return this.#el.play()
  }

  pause(): void {
    this.#el.pause()
  }

  dispose(): void {
    this.#el.pause()
    this.#el.onended = null
    this.#el.onerror = null
    URL.revokeObjectURL(this.#url)
  }
}

export function domPlayerFactory(audio: Uint8Array, mime: string): UtterancePlayer {
  return new DomAudioPlayer(audio, mime)
}

export interface UtteranceQueueOptions {
  /** Fábrica de players (padrão `domPlayerFactory`). */
  playerFactory?: PlayerFactory
  /** Mudança de estado ('idle' = fila vazia e nada tocando; 'playing' = há áudio em curso). */
  onState?: (state: UtteranceState) => void
  /** Início/fim da reprodução de cada utterance (timeline da chamada — cancelas não emitem 'end'). */
  onItem?: (e: { item: VoiceCallUtteranceEvent; phase: 'start' | 'end' }) => void
}

/**
 * Fila de reprodução (uma por chamada). `enqueue` aceita qualquer ordem de chegada e toca
 * estritamente na ordem; `cancel()` (barge-in) pausa o que estiver tocando e descarta o resto —
 * o texto da resposta segue completo no histórico. `state`/`pending` alimentam a UI.
 */
export class UtteranceQueue {
  #factory: PlayerFactory
  #onState: ((state: UtteranceState) => void) | undefined
  #onItem: ((e: { item: VoiceCallUtteranceEvent; phase: 'start' | 'end' }) => void) | undefined
  #queue: VoiceCallUtteranceEvent[] = []
  #current: UtterancePlayer | null = null
  #currentItem: VoiceCallUtteranceEvent | null = null
  #state: UtteranceState = 'idle'
  #volume = 1

  constructor(options: UtteranceQueueOptions = {}) {
    this.#factory = options.playerFactory ?? domPlayerFactory
    this.#onState = options.onState
    this.#onItem = options.onItem
  }

  get state(): UtteranceState {
    return this.#state
  }

  /** Utterances aguardando (não inclui a que está tocando). */
  get pending(): number {
    return this.#queue.length
  }

  /** Volume 0..1 (propagado ao player atual e aos seguintes). */
  get volume(): number {
    return this.#volume
  }

  setVolume(volume: number): void {
    this.#volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
    if (this.#current) this.#current.volume = this.#volume
  }

  /** Enfileira uma utterance (bytes completos) — toca na ordem, sem sobreposição. */
  enqueue(utterance: VoiceCallUtteranceEvent): void {
    this.#queue.push(utterance)
    void this.#pump()
  }

  /** Barge-in/parada: pausa o atual e descarta a fila (nada mais toca até o próximo enqueue). */
  cancel(): void {
    this.#queue = []
    const cur = this.#current
    this.#current = null
    this.#currentItem = null
    if (cur) {
      try {
        cur.pause()
      } catch {
        /* player já parado */
      }
      cur.dispose?.()
    }
    this.#setState('idle')
  }

  /**
   * Cancela UMA utterance pelo id (ex.: filler interrompido pela 1ª sentença da resposta): na
   * fila → só descarta; tocando → pausa/limpa e avança para a seguinte. Id desconhecido = sem efeito.
   */
  drop(id: string): void {
    this.#queue = this.#queue.filter((u) => u.id !== id)
    if (this.#currentItem?.id !== id) return
    const cur = this.#current
    this.#current = null
    this.#currentItem = null
    if (cur) {
      try {
        cur.pause()
      } catch {
        /* player já parado */
      }
      cur.dispose?.()
    }
    if (!this.#queue.length) this.#setState('idle')
    else void this.#pump()
  }

  async #pump(): Promise<void> {
    if (this.#current) return
    const next = this.#queue.shift()
    if (!next) return
    this.#setState('playing')
    let player: UtterancePlayer | null = null
    let settled = false
    let started = false
    const done = (): void => {
      if (settled) return
      settled = true
      // só age se este player ainda for o atual (cancel()/drop() + enqueue novo tornam o done
      // velho: o play() interrompido rejeita depois e não pode derrubar quem está tocando agora)
      if (this.#current !== player) return
      this.#current = null
      this.#currentItem = null
      player?.dispose?.()
      if (started) this.#onItem?.({ item: next, phase: 'end' })
      if (!this.#queue.length) this.#setState('idle')
      void this.#pump()
    }
    try {
      player = this.#factory(next.audio, next.mime)
    } catch {
      // bytes ilegíveis: pula para a próxima (player/current continuam null → done avança)
      done()
      return
    }
    this.#current = player
    this.#currentItem = next
    player.volume = this.#volume
    player.onended = done
    player.onerror = done
    started = true
    this.#onItem?.({ item: next, phase: 'start' })
    try {
      await player.play()
    } catch {
      done()
    }
  }

  #setState(state: UtteranceState): void {
    if (this.#state === state) return
    this.#state = state
    this.#onState?.(state)
  }
}
