// "Minhas vozes" do Modo avançado (GPU local): clonar uma voz a partir de 6–10 s de fala — gravada
// aqui (pilha de captura do ditado, `AudioCapture` a 24 kHz, com medidor de nível e contagem
// regressiva; texto sugerido em pt-BR) ou enviada como arquivo (wav/mp3/ogg/webm — decodificado no
// renderer e convertido em WAV PCM16 mono 24 kHz) —, transcrição opcional (Qwen precisa; com o
// whisper da GPU instalado há "transcrever automaticamente"), nome, prévia e `gpu.addUserVoice`.
// Lista as vozes salvas com remover.
import { Mic, Play, Square, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../../lib/api'
import { AudioCapture } from '../../../lib/audio/capture'
import { floatToPcm16, resampleMono } from '../../../lib/audio/pcm'
import { captureErrorText } from '../../../lib/voice/dictation'
import {
  CLONE_ACCEPT,
  CLONE_IDEAL_MAX_S,
  CLONE_IDEAL_MIN_S,
  CLONE_SUGGESTED_TEXT,
  pcm16ToWav,
  sampleDurationProblem,
  userVoicesOf
} from '../../../lib/voice/gpu/gpuUi'
import type { GpuStatus, GpuVoice } from '../../../lib/voice/gpu/types'
import { gpuApi } from '../../../lib/voice/gpu/types'
import { refreshGpuStatus, setGpuCloneOpen, useGpuStore } from '../../../lib/voice/gpu/useGpuStatus'
import { playAudioBytes } from '../../../lib/voice/voiceSettingsHelpers'
import { useVoiceSettings } from '../../../lib/voice/voiceSettings'
import { cn } from '../../../lib/format'
import { Button, IconButton, Label } from '../../ui/controls'
import { HelpTip } from '../../ui/Tooltip'
import { DismissibleError } from '../voiceSettingsParts'
import { Badge } from './gpuParts'

/** Taxa da amostra salva (a dos motores; 16 kHz também clona, 24 kHz guarda mais timbre). */
const SAMPLE_RATE = 24000
/** Gravação para sozinha aqui (o ideal é 6–10 s). */
const RECORD_MAX_S = CLONE_IDEAL_MAX_S

interface Sample {
  wav: ArrayBuffer
  seconds: number
  source: 'record' | 'upload'
  fileName?: string
}

/** Decodifica um arquivo de áudio e devolve WAV PCM16 mono na taxa da amostra. */
async function fileToWav(file: File): Promise<{ wav: ArrayBuffer; seconds: number }> {
  const ctx = new AudioContext()
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer())
    const mono = new Float32Array(buf.length)
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c)
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels
    }
    const pcm = floatToPcm16(resampleMono(mono, buf.sampleRate, SAMPLE_RATE))
    return { wav: pcm16ToWav(pcm, SAMPLE_RATE), seconds: buf.duration }
  } finally {
    void ctx.close().catch(() => void 0)
  }
}

export function GpuUserVoices({
  status,
  whisperInstalled
}: {
  status: GpuStatus | null
  whisperInstalled: boolean
}): React.JSX.Element {
  const voices = userVoicesOf(status)
  const adding = useGpuStore((s) => s.cloneOpen)
  const setAdding = setGpuCloneOpen
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const reveal = useGpuStore((s) => s.reveal)
  const revealTarget = useGpuStore((s) => s.revealTarget)

  // link "Gravar ou enviar uma voz…" do painel de Fala: o store abre o formulário; aqui só rola
  useEffect(() => {
    if (!reveal || revealTarget !== 'voices') return
    const t = setTimeout(
      () => root.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      60
    )
    return () => clearTimeout(t)
  }, [reveal, revealTarget])

  const remove = (v: GpuVoice): void => {
    const gpu = gpuApi()
    if (!gpu) return
    setRemoving(v.id)
    setError(null)
    void gpu
      .removeUserVoice(v.id)
      .then(() => refreshGpuStatus())
      .catch((e) => setError(`Não foi possível remover “${v.label}”: ${errorMessage(e)}`))
      .finally(() => setRemoving(null))
  }

  return (
    <div
      ref={root}
      className="rounded-xl border border-border bg-elevated/40 px-3.5 py-3"
      data-testid="gpu-user-voices"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-fg/90">Minhas vozes</span>
        <HelpTip label="Minhas vozes" wide>
          <p>
            Clone uma voz para os motores que clonam (OmniVoice, XTTS-v2, Qwen3-TTS): 6–10 s de fala
            limpa, sem música nem eco, de uma pessoa só. A amostra fica no computador e só é usada
            pelo servidor local da GPU.
          </p>
          <p>
            Use a <b>sua própria voz</b> ou uma que você tenha autorização para usar. Não clone a
            voz de outra pessoa sem o consentimento dela.
          </p>
          <p>
            O Qwen3-TTS precisa também do texto exato que foi falado na amostra (transcrição); os
            outros motores usam só o áudio.
          </p>
        </HelpTip>
        {!adding && (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            icon={<Mic className="size-3.5" />}
            data-testid="gpu-voice-add"
            onClick={() => setAdding(true)}
          >
            Adicionar voz
          </Button>
        )}
      </div>
      {voices.length > 0 ? (
        <ul className="mt-2 space-y-1" aria-label="Minhas vozes" data-testid="gpu-user-voice-list">
          {voices.map((v) => (
            <li
              key={v.id}
              className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1 text-[12px]"
              data-testid={`gpu-user-voice-${v.id}`}
            >
              <span className="min-w-0 flex-1 truncate">{v.label}</span>
              <IconButton
                size="xs"
                label={`Remover a voz ${v.label}`}
                data-testid={`gpu-user-voice-remove-${v.id}`}
                disabled={removing === v.id}
                onClick={() => remove(v)}
              >
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        !adding && (
          <p className="mt-1 text-[11.5px] text-subtle">
            Nenhuma voz sua ainda — grave ou envie 6–10 s de fala para clonar.
          </p>
        )
      )}
      {error && (
        <div className="mt-2">
          <DismissibleError
            error={error}
            onDismiss={() => setError(null)}
            testId="gpu-user-voice-error"
            dismissLabel="Dispensar erro de Minhas vozes"
          />
        </div>
      )}
      {adding && (
        <CloneForm
          whisperInstalled={whisperInstalled}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            void refreshGpuStatus()
          }}
        />
      )}
    </div>
  )
}

function CloneForm({
  whisperInstalled,
  onClose,
  onSaved
}: {
  whisperInstalled: boolean
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const deviceId = useVoiceSettings((s) => s.view.audioInput.deviceId)
  const [rec, setRec] = useState<{ startedAt: number; elapsed: number; level: number } | null>(null)
  const [sample, setSample] = useState<Sample | null>(null)
  const [name, setName] = useState('Minha voz')
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<'decode' | 'transcribe' | 'save' | null>(null)
  const [playing, setPlaying] = useState(false)
  const capture = useRef<AudioCapture | null>(null)
  const chunks = useRef<Int16Array[]>([])
  const player = useRef<{ el: HTMLAudioElement; url: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const canTranscribe = whisperInstalled && !!gpuApi()?.transcribe

  const stopPlayer = (): void => {
    const p = player.current
    player.current = null
    if (p) {
      p.el.pause()
      URL.revokeObjectURL(p.url)
    }
    setPlaying(false)
  }

  const finishRecording = useCallback(async (): Promise<void> => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    const c = capture.current
    capture.current = null
    await c?.stop()
    setRec(null)
    const parts = chunks.current
    chunks.current = []
    const total = parts.reduce((n, p) => n + p.length, 0)
    if (!total) {
      setError('Nada foi gravado — confira o microfone.')
      return
    }
    const pcm = new Int16Array(total)
    let o = 0
    for (const p of parts) {
      pcm.set(p, o)
      o += p.length
    }
    setSample({ wav: pcm16ToWav(pcm, SAMPLE_RATE), seconds: total / SAMPLE_RATE, source: 'record' })
  }, [])

  // desmontar (fechar o modal/formulário) libera o microfone e para a prévia
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current)
      void capture.current?.stop()
      capture.current = null
      stopPlayer()
    },
    []
  )

  const startRecording = async (): Promise<void> => {
    setError(null)
    setNotice(null)
    stopPlayer()
    setSample(null)
    chunks.current = []
    const c = new AudioCapture({ sampleRate: SAMPLE_RATE, silence: false })
    capture.current = c
    c.on('pcm', (chunk) => chunks.current.push(chunk))
    c.on('level', (level) => setRec((r) => (r ? { ...r, level } : r)))
    c.on('ended', () => void finishRecording())
    try {
      await c.start(deviceId)
    } catch (e) {
      capture.current = null
      setError(captureErrorText(e as Error))
      return
    }
    if (c.fellBack) setNotice('Microfone salvo não encontrado — gravando com o padrão do sistema.')
    const startedAt = Date.now()
    setRec({ startedAt, elapsed: 0, level: 0 })
    timer.current = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000
      setRec((r) => (r ? { ...r, elapsed } : r))
      if (elapsed >= RECORD_MAX_S) void finishRecording()
    }, 100)
  }

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setError(null)
    setNotice(null)
    stopPlayer()
    setBusy('decode')
    try {
      const { wav, seconds } = await fileToWav(file)
      setSample({ wav, seconds, source: 'upload', fileName: file.name })
      if (name === 'Minha voz') setName(file.name.replace(/\.[^.]+$/, '').slice(0, 40) || name)
    } catch (e) {
      setSample(null)
      setError(
        `Não foi possível ler “${file.name}” como áudio (${errorMessage(e)}). Use wav, mp3, ogg ou webm.`
      )
    } finally {
      setBusy(null)
    }
  }

  const preview = (): void => {
    if (playing) return stopPlayer()
    if (!sample) return
    setPlaying(true)
    player.current = playAudioBytes(
      new Uint8Array(sample.wav),
      'audio/wav',
      () => {
        player.current = null
        setPlaying(false)
      },
      (msg) => {
        player.current = null
        setPlaying(false)
        setError(`Prévia: ${msg}`)
      }
    )
  }

  const transcribe = (): void => {
    const t = gpuApi()?.transcribe
    if (!t || !sample) return
    setBusy('transcribe')
    setError(null)
    void t({ audio: sample.wav.slice(0) })
      .then((r) => setTranscript(r.text.trim()))
      .catch((e) => setError(`Transcrição falhou: ${errorMessage(e)}`))
      .finally(() => setBusy(null))
  }

  const problem = sample ? sampleDurationProblem(sample.seconds) : null
  const canSave = !!sample && problem?.level !== 'error' && !!name.trim() && !busy && !rec

  const save = (): void => {
    const gpu = gpuApi()
    if (!gpu || !sample || !canSave) return
    setBusy('save')
    setError(null)
    void gpu
      .addUserVoice({
        name: name.trim(),
        audio: sample.wav.slice(0),
        ...(transcript.trim() ? { transcript: transcript.trim() } : {})
      })
      .then(() => onSaved())
      .catch((e) => setError(`Não foi possível salvar a voz: ${errorMessage(e)}`))
      .finally(() => setBusy(null))
  }

  const remaining = rec ? Math.max(0, Math.ceil(RECORD_MAX_S - rec.elapsed)) : 0
  const meter = rec ? Math.min(1, Math.sqrt(rec.level) * 2.2) : 0

  return (
    <div
      className="mt-2 space-y-3 rounded-lg border border-border/70 px-2.5 py-2.5"
      data-testid="gpu-clone-form"
    >
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-fg/90">Nova voz</span>
        <IconButton size="xs" label="Fechar nova voz" className="ml-auto" onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <div>
        <Label
          help={`Leia em voz alta, no seu ritmo normal, num lugar silencioso. A gravação para sozinha em ${RECORD_MAX_S} s (o ideal é ${CLONE_IDEAL_MIN_S}–${CLONE_IDEAL_MAX_S} s).`}
        >
          Texto sugerido para ler
        </Label>
        <p
          className="rounded-md bg-white/[0.03] px-2 py-1.5 text-[12px] leading-relaxed text-fg/85"
          data-testid="gpu-clone-suggested"
        >
          {CLONE_SUGGESTED_TEXT}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {rec ? (
          <Button
            size="sm"
            variant="danger"
            icon={<Square className="size-3" fill="currentColor" />}
            data-testid="gpu-clone-stop"
            onClick={() => void finishRecording()}
          >
            Parar ({remaining} s)
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            icon={<Mic className="size-3.5" />}
            data-testid="gpu-clone-record"
            disabled={!!busy}
            onClick={() => void startRecording()}
          >
            {sample?.source === 'record' ? 'Gravar de novo' : 'Gravar'}
          </Button>
        )}
        <span className="text-[11.5px] text-faint">ou</span>
        <Button
          size="sm"
          variant="secondary"
          icon={<Upload className="size-3.5" />}
          disabled={!!rec || !!busy}
          loading={busy === 'decode'}
          data-testid="gpu-clone-upload"
          onClick={() => fileInput.current?.click()}
        >
          Enviar arquivo
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept={CLONE_ACCEPT}
          className="hidden"
          aria-label="Arquivo de áudio da voz"
          data-testid="gpu-clone-file"
          onChange={(e) => {
            void onFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <span className="text-[10.5px] text-subtle">wav, mp3, ogg ou webm</span>
      </div>

      {rec && (
        <div className="flex items-center gap-2" data-testid="gpu-clone-recording" role="status">
          <span className="size-2 animate-pulse rounded-full bg-danger" aria-hidden />
          <span className="text-[11.5px] text-fg/85 tabular-nums" data-testid="gpu-clone-countdown">
            Gravando… {rec.elapsed.toFixed(1).replace('.', ',')} s · faltam {remaining} s
          </span>
          <div
            className="h-1.5 w-40 overflow-hidden rounded-full bg-elevated"
            role="meter"
            aria-label="Nível do microfone"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(meter * 100)}
            data-testid="gpu-clone-level"
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-75',
                meter > 0.9 ? 'bg-warning' : 'bg-success'
              )}
              style={{ width: `${Math.round(meter * 100)}%` }}
            />
          </div>
        </div>
      )}
      {notice && <p className="text-[11.5px] text-warning">{notice}</p>}

      {sample && !rec && (
        <div className="flex flex-wrap items-center gap-2" data-testid="gpu-clone-sample">
          <Button
            size="sm"
            variant="ghost"
            icon={
              playing ? (
                <Square className="size-3" fill="currentColor" />
              ) : (
                <Play className="size-3.5" />
              )
            }
            data-testid="gpu-clone-preview"
            data-state={playing ? 'playing' : 'idle'}
            onClick={preview}
          >
            {playing ? 'Parar' : 'Ouvir amostra'}
          </Button>
          <span className="text-[11.5px] text-subtle tabular-nums" data-testid="gpu-clone-duration">
            {sample.source === 'upload' ? `${sample.fileName} · ` : 'gravação · '}
            {sample.seconds.toFixed(1).replace('.', ',')} s
          </span>
          {problem ? (
            <Badge
              tone={problem.level === 'error' ? 'danger' : 'warning'}
              testId="gpu-clone-duration-problem"
            >
              {problem.text}
            </Badge>
          ) : (
            <Badge tone="success">duração boa</Badge>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div>
          <Label>Nome</Label>
          <input
            type="text"
            value={name}
            maxLength={60}
            aria-label="Nome da voz"
            data-testid="gpu-clone-name"
            onChange={(e) => setName(e.target.value)}
            className="field h-8 w-full px-2 py-0 text-[12.5px]"
          />
        </div>
        <div>
          <Label
            help="O texto exato falado na amostra. Obrigatório para o Qwen3-TTS clonar (sem ele a voz não aparece no Qwen); OmniVoice e XTTS-v2 usam só o áudio."
            hint={
              <span className="flex items-center gap-2">
                {sample?.source === 'record' && transcript !== CLONE_SUGGESTED_TEXT && (
                  <button
                    type="button"
                    data-testid="gpu-clone-use-suggested"
                    onClick={() => setTranscript(CLONE_SUGGESTED_TEXT)}
                    className="text-accent-strong underline-offset-2 hover:underline"
                  >
                    li o texto sugerido
                  </button>
                )}
                {canTranscribe && (
                  <button
                    type="button"
                    data-testid="gpu-clone-transcribe"
                    disabled={!sample || !!busy}
                    onClick={transcribe}
                    className="text-accent-strong underline-offset-2 hover:underline disabled:opacity-40"
                  >
                    {busy === 'transcribe' ? 'transcrevendo…' : 'transcrever automaticamente'}
                  </button>
                )}
              </span>
            }
          >
            Transcrição (opcional)
          </Label>
          <textarea
            value={transcript}
            rows={2}
            aria-label="Transcrição da amostra"
            data-testid="gpu-clone-transcript"
            placeholder="O que foi falado na amostra…"
            onChange={(e) => setTranscript(e.target.value)}
            className="field w-full resize-y px-2 py-1 text-[12px]"
          />
        </div>
      </div>

      {error && (
        <DismissibleError
          error={error}
          onDismiss={() => setError(null)}
          testId="gpu-clone-error"
          dismissLabel="Dispensar erro da nova voz"
        />
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!canSave}
          loading={busy === 'save'}
          data-testid="gpu-clone-save"
          onClick={save}
        >
          Salvar voz
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        {!sample && <span className="text-[11.5px] text-subtle">grave ou envie uma amostra</span>}
      </div>
    </div>
  )
}
