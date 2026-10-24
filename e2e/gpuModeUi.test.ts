// Lógica PURA da UI do "Modo avançado (GPU local)" (`src/renderer/src/lib/voice/gpu/gpuUi.ts`):
// veredito do hardware, ordem dos motores, compat → estado do botão, rótulos, agrupamento/ordem das
// vozes, voz padrão, prontidão (painéis e pré-checagem da chamada — `callReadiness.ts`) e o WAV da
// amostra. Sem DOM, sem Electron. Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STT_SETTINGS, DEFAULT_TTS_SETTINGS } from '@shared/voice'
import type { SttSettings, TtsSettings } from '@shared/voice'
import {
  compatUi,
  defaultGpuVoice,
  engineAction,
  formatLatency,
  formatGpuParam,
  formatMb,
  gpuCallPlan,
  gpuConfigFor,
  gpuParamRows,
  gpuServerLine,
  gpuSttProblems,
  gpuTtsProblems,
  groupGpuVoices,
  hardwareVerdict,
  installedTtsEngines,
  measuredLine,
  pcm16ToWav,
  progressPct,
  sampleDurationProblem,
  savedGpuParams,
  setGpuParam,
  sortGpuEngines,
  sttWithGpuParams,
  ttsWithGpuParams,
  userVoicesOf
} from '../src/renderer/src/lib/voice/gpu/gpuUi.ts'
import { GPU_ENGINE_PARAMS, XTTS_DEFAULT_SPEED } from '@shared/gpuVoice'
import { normalizeSttSettings, normalizeTtsSettings } from '@shared/voice'
import type {
  GpuEngineStatus,
  GpuStatus,
  SttSettingsGpu,
  TtsSettingsGpu
} from '../src/renderer/src/lib/voice/gpu/types.ts'
import { voiceCallReadiness } from '../src/renderer/src/lib/voice/callReadiness.ts'

const engine = (over: Partial<GpuEngineStatus> & Pick<GpuEngineStatus, 'id'>): GpuEngineStatus => ({
  kind: over.id === 'whisper-large-v3-turbo' ? 'stt' : 'tts',
  label: over.id,
  license: { name: 'Apache-2.0', url: 'https://x', commercial: true },
  sizeMb: 2000,
  vramMb: 3000,
  languages: ['pt'],
  ptBR: 'ok',
  streaming: true,
  voices: [],
  install: { state: 'absent' },
  compat: { level: 'ok', reasons: [] },
  ...over
})

const status = (over: Partial<GpuStatus> = {}): GpuStatus => ({
  platform: { os: 'linux', arch: 'x64', diskFreeMb: 200_000 },
  gpus: [
    {
      vendor: 'nvidia',
      name: 'RTX 3080 Ti',
      vramTotalMb: 12288,
      vramFreeMb: 9000,
      driver: '615',
      cudaMax: '13.4'
    }
  ],
  runtime: { state: 'installed', version: 'x', sizeMb: 6000 },
  engines: [
    engine({ id: 'omnivoice', install: { state: 'installed' } }),
    engine({ id: 'whisper-large-v3-turbo', install: { state: 'installed' } })
  ],
  server: { state: 'running', engines: ['omnivoice'] },
  ...over
})

// ---------------- números ----------------

test('formatMb e formatLatency: pt-BR, ms abaixo de 250 e segundos com 1 casa', () => {
  assert.equal(formatMb(512), '512 MB')
  assert.equal(formatMb(1640), '1,6 GB')
  assert.equal(formatMb(12288), '12 GB')
  assert.equal(formatMb(null), '—')
  assert.equal(formatLatency(116), '~120 ms')
  assert.equal(formatLatency(198), '~200 ms')
  assert.equal(formatLatency(597), '~0,6 s')
  assert.equal(formatLatency(1264), '~1,3 s')
  assert.equal(
    measuredLine('tts', { firstAudioMs: 597, rtf: 0.158 }),
    '~0,6 s até o 1º áudio · 6,3× o tempo real'
  )
  assert.equal(
    measuredLine('tts', { firstAudioMs: 116, rtf: 0.05 }),
    '~120 ms até o 1º áudio · 20× o tempo real'
  )
  assert.equal(measuredLine('stt', { firstAudioMs: 102, rtf: 0.02 }), '~100 ms por frase')
})

test('progressPct: 0–100, fração 0–1 aceita, null indeterminado', () => {
  assert.equal(progressPct({ pct: 42.4 }), 42)
  assert.equal(progressPct({ pct: 0.5 }), 50)
  assert.equal(progressPct({ pct: 140 }), 100)
  assert.equal(progressPct({ pct: null }), null)
  assert.equal(progressPct(undefined), null)
})

// ---------------- ordem e compat ----------------

test('sortGpuEngines: OmniVoice, XTTS, VibeVoice, Qwen 0.6B, Qwen 1.7B, Whisper; desconhecido no fim', () => {
  const ids = [
    'whisper-large-v3-turbo',
    'qwen3-tts-1.7b',
    'zzz',
    'xtts-v2',
    'omnivoice',
    'vibevoice-realtime',
    'qwen3-tts-0.6b'
  ]
  assert.deepEqual(
    sortGpuEngines(ids.map((id) => ({ id }))).map((e) => e.id),
    [
      'omnivoice',
      'xtts-v2',
      'vibevoice-realtime',
      'qwen3-tts-0.6b',
      'qwen3-tts-1.7b',
      'whisper-large-v3-turbo',
      'zzz'
    ]
  )
})

test('compatUi: bloqueado não instala; aviso pede confirmação; ok instala direto', () => {
  const b = compatUi({ level: 'blocked', reasons: ['pouca VRAM', 'driver velho'] })
  assert.equal(b.canInstall, false)
  assert.equal(b.reason, 'pouca VRAM · driver velho')
  const w = compatUi({ level: 'warn', reasons: ['CPU'] })
  assert.equal(w.canInstall, true)
  assert.equal(w.confirm, true)
  const ok = compatUi({ level: 'ok', reasons: [] })
  assert.equal(ok.confirm, false)
  assert.equal(ok.tone, 'success')
})

test('engineAction: estado × compat × runtime × outra instalação', () => {
  const e = engine({ id: 'xtts-v2' })
  assert.deepEqual(engineAction(e, true, false), {
    action: 'install',
    label: 'Instalar',
    disabled: false,
    why: null,
    note: null
  })
  // sem o runtime o backend instala o runtime antes: não desabilita, só avisa
  const noRt = engineAction(e, false, false)
  assert.equal(noRt.disabled, false)
  assert.match(noRt.note ?? '', /runtime/)
  assert.match(engineAction(e, true, true).why ?? '', /aguarde/)
  const blocked = engine({
    id: 'qwen3-tts-1.7b',
    compat: { level: 'blocked', reasons: ['precisa de 7 GB'] }
  })
  assert.deepEqual(engineAction(blocked, true, false), {
    action: 'install',
    label: 'Instalar',
    disabled: true,
    why: 'precisa de 7 GB'
  })
  assert.equal(
    engineAction(engine({ id: 'omnivoice', install: { state: 'installing' } }), true, true).action,
    'cancel'
  )
  assert.equal(
    engineAction(engine({ id: 'omnivoice', install: { state: 'installed' } }), true, false).action,
    'remove'
  )
  assert.equal(
    engineAction(engine({ id: 'omnivoice', install: { state: 'broken' } }), true, false).label,
    'Reinstalar'
  )
})

// ---------------- veredito ----------------

test('hardwareVerdict: todos ok / sem NVIDIA / Apple / parcial / incompatível / disco', () => {
  assert.deepEqual(hardwareVerdict(status()), {
    level: 'ok',
    title: 'Sua GPU roda todos os motores',
    details: []
  })

  const none = hardwareVerdict(status({ gpus: [] }))
  assert.equal(none.level, 'warn')
  assert.equal(none.title, 'Sem GPU NVIDIA — vai rodar na CPU, lento para chamada')

  const mac = hardwareVerdict(
    status({
      platform: { os: 'darwin', arch: 'arm64', diskFreeMb: 100_000 },
      gpus: [
        {
          vendor: 'apple',
          name: 'Apple M2 Pro',
          vramTotalMb: null,
          vramFreeMb: null,
          driver: null,
          cudaMax: null
        }
      ]
    })
  )
  assert.equal(mac.level, 'warn')
  assert.match(mac.title, /^Apple M2 Pro: suporte experimental/)

  const partial = hardwareVerdict(
    status({
      engines: [
        engine({ id: 'omnivoice', compat: { level: 'warn', reasons: ['VRAM livre'] } }),
        engine({
          id: 'qwen3-tts-1.7b',
          label: 'Qwen 1.7B',
          compat: { level: 'blocked', reasons: ['VRAM'] }
        }),
        engine({ id: 'xtts-v2' })
      ]
    })
  )
  assert.equal(partial.level, 'warn')
  assert.equal(partial.title, 'Sua GPU roda 1 de 3 motores sem ressalvas')
  assert.deepEqual(partial.details, ['1 motor pode não rodar bem', '1 motor bloqueado: Qwen 1.7B'])

  const blocked = hardwareVerdict(
    status({
      engines: [engine({ id: 'omnivoice', compat: { level: 'blocked', reasons: ['GPU Kepler'] } })]
    })
  )
  assert.deepEqual(blocked, { level: 'blocked', title: 'Incompatível: GPU Kepler', details: [] })
  const rtBlocked = hardwareVerdict(
    status({
      runtime: {
        state: 'absent',
        version: null,
        sizeMb: null,
        compat: { level: 'blocked', reasons: ['sem CUDA 12'] }
      }
    })
  )
  assert.equal(rtBlocked.title, 'Incompatível: sem CUDA 12')

  const disk = hardwareVerdict(
    status({
      platform: { os: 'linux', arch: 'x64', diskFreeMb: 4000 },
      runtime: { state: 'absent', version: null, sizeMb: 6000 }
    })
  )
  assert.equal(disk.level, 'warn')
  assert.match(
    disk.details.join(' '),
    /Pouco espaço em disco: 3,9 GB livres \(o runtime pede ~5,9 GB\)/
  )

  const vram = hardwareVerdict(
    status({
      gpus: [
        {
          vendor: 'nvidia',
          name: 'x',
          vramTotalMb: 8192,
          vramFreeMb: 1500,
          driver: null,
          cudaMax: null
        }
      ]
    })
  )
  assert.match(vram.details.join(' '), /Pouca VRAM livre agora \(1,5 GB\)/)
})

// ---------------- vozes ----------------

test('groupGpuVoices: modelo (pt-BR → outras → pt-PT), CC0 e minhas (por nome); motor sem clonagem só embutidas', () => {
  const e = engine({
    id: 'qwen3-tts-0.6b',
    voices: [
      { id: 'u2', label: 'Zé', source: 'user' },
      { id: 'pt', label: 'Ryan', source: 'builtin', accent: 'pt-PT' },
      { id: 'cc0', label: 'Livre', source: 'cc0', accent: 'pt-BR' },
      { id: 'u1', label: 'ana', source: 'user' },
      { id: 'br', label: 'Bia', source: 'builtin', accent: 'pt-BR' },
      { id: 'en', label: 'Amy', source: 'builtin', accent: 'other' }
    ]
  })
  const g = groupGpuVoices(e)
  assert.deepEqual(
    g.map((x) => [x.key, x.voices.map((v) => v.id)]),
    [
      ['builtin', ['br', 'en', 'pt']],
      ['cc0', ['cc0']],
      ['user', ['u1', 'u2']]
    ]
  )
  assert.deepEqual(
    groupGpuVoices(
      engine({
        id: 'vibevoice-realtime',
        voices: [{ id: 'w', label: 'Mulher', source: 'builtin' }]
      })
    ).map((x) => x.key),
    ['builtin']
  )
  // OmniVoice (só clona, sem embutidas): grupos de clonagem mesmo vazios, sem "Vozes do modelo"
  assert.deepEqual(
    groupGpuVoices(engine({ id: 'omnivoice' })).map((x) => x.key),
    ['cc0', 'user']
  )
})

test('defaultGpuVoice e gpuConfigFor: CC0 → pt-BR embutida → minha; mantém a voz que existe; passos do OmniVoice', () => {
  assert.equal(
    defaultGpuVoice({
      voices: [
        { id: 'pt', label: 'pt', source: 'builtin', accent: 'pt-PT' },
        { id: 'u', label: 'u', source: 'user' },
        { id: 'c', label: 'c', source: 'cc0' }
      ]
    }),
    'c'
  )
  assert.equal(
    defaultGpuVoice({
      voices: [
        { id: 'pt', label: 'pt', source: 'builtin', accent: 'pt-PT' },
        { id: 'br', label: 'br', source: 'builtin', accent: 'pt-BR' }
      ]
    }),
    'br'
  )
  assert.equal(defaultGpuVoice({ voices: [] }), null)
  const omni = engine({
    id: 'omnivoice',
    voices: [{ id: 'u', label: 'u', source: 'user' }],
    options: { steps: 16 }
  })
  assert.deepEqual(gpuConfigFor(omni, null), { engine: 'omnivoice', voice: 'u', steps: 16 })
  assert.deepEqual(gpuConfigFor(omni, { engine: 'xtts-v2', voice: 'u', steps: 32 }), {
    engine: 'omnivoice',
    voice: 'u',
    steps: 32
  })
  const xtts = engine({ id: 'xtts-v2', voices: [{ id: 'a', label: 'a', source: 'builtin' }] })
  assert.deepEqual(gpuConfigFor(xtts, { engine: 'omnivoice', voice: 'u', steps: 16 }), {
    engine: 'xtts-v2',
    voice: 'a'
  })
})

test('userVoicesOf e installedTtsEngines: dedup por id e ordem da UI', () => {
  const s = status({
    engines: [
      engine({
        id: 'xtts-v2',
        install: { state: 'installed' },
        voices: [{ id: 'u1', label: 'B', source: 'user' }]
      }),
      engine({
        id: 'omnivoice',
        install: { state: 'installed' },
        voices: [
          { id: 'u1', label: 'B', source: 'user' },
          { id: 'u2', label: 'a', source: 'user' }
        ]
      }),
      engine({ id: 'qwen3-tts-0.6b' }),
      engine({ id: 'whisper-large-v3-turbo', install: { state: 'installed' } })
    ]
  })
  assert.deepEqual(
    userVoicesOf(s).map((v) => v.id),
    ['u2', 'u1']
  )
  assert.deepEqual(
    installedTtsEngines(s).map((e) => e.id),
    ['omnivoice', 'xtts-v2']
  )
  assert.deepEqual(installedTtsEngines(null), [])
})

// ---------------- prontidão ----------------

const TTS_GPU = (gpu: TtsSettingsGpu['gpu']): TtsSettingsGpu => ({
  ...DEFAULT_TTS_SETTINGS,
  backend: 'gpu',
  gpu
})
const STT_GPU: SttSettingsGpu = {
  ...DEFAULT_STT_SETTINGS,
  mode: 'gpu',
  gpu: { engine: 'whisper-large-v3-turbo' }
}

test('gpuTtsProblems: runtime ausente/quebrado, motor ausente/bloqueado, voz sumida, servidor', () => {
  const omniCc0 = engine({
    id: 'omnivoice',
    label: 'OmniVoice',
    install: { state: 'installed' },
    voices: [{ id: 'c', label: 'c', source: 'cc0' }]
  })
  const cfg = TTS_GPU({ engine: 'omnivoice', voice: 'c' })
  assert.deepEqual(gpuTtsProblems({ ...cfg, backend: 'api' }, status()), [])
  assert.deepEqual(gpuTtsProblems(cfg, status({ engines: [omniCc0] })), [])
  assert.match(gpuTtsProblems(cfg, null)[0].text, /não está disponível/)
  assert.match(
    gpuTtsProblems(cfg, status({ runtime: { state: 'absent', version: null, sizeMb: null } }))[0]
      .text,
    /instale o runtime em Configurações → Áudio → Modelos locais/
  )
  assert.match(
    gpuTtsProblems(
      cfg,
      status({
        runtime: { state: 'broken', version: null, sizeMb: null, error: 'libcudnn\nstack' }
      })
    )[0].text,
    /runtime está com problema \(libcudnn\) — reinstale/
  )
  assert.match(
    gpuTtsProblems(cfg, status({ engines: [{ ...omniCc0, install: { state: 'absent' } }] }))[0]
      .text,
    /instale o motor OmniVoice/
  )
  const blocked = gpuTtsProblems(
    cfg,
    status({ engines: [{ ...omniCc0, compat: { level: 'blocked', reasons: ['VRAM'] } }] })
  )
  assert.equal(blocked[0].level, 'error')
  assert.match(blocked[0].text, /não roda neste computador: VRAM/)
  const warn = gpuTtsProblems(
    cfg,
    status({ engines: [{ ...omniCc0, compat: { level: 'warn', reasons: ['CPU'] } }] })
  )
  assert.deepEqual(
    warn.map((p) => p.level),
    ['warn']
  )
  assert.match(
    gpuTtsProblems(
      TTS_GPU({ engine: 'omnivoice', voice: 'sumiu' }),
      status({ engines: [omniCc0] })
    )[0].text,
    /não existe mais/
  )
  assert.match(
    gpuTtsProblems(
      TTS_GPU({ engine: 'omnivoice', voice: null }),
      status({ engines: [{ ...omniCc0, voices: [] }] })
    )[0].text,
    /precisa de uma voz de referência/
  )
  const stopped = gpuTtsProblems(
    cfg,
    status({ engines: [omniCc0], server: { state: 'stopped', engines: [] } })
  )
  assert.deepEqual(
    stopped.map((p) => p.level),
    ['info']
  )
  const srvErr = gpuTtsProblems(
    cfg,
    status({ engines: [omniCc0], server: { state: 'error', engines: [], error: 'OOM' } })
  )
  // falha anterior do servidor NÃO barra (o próximo uso sobe de novo): aviso
  assert.equal(srvErr[0].level, 'warn')
  assert.match(
    srvErr[0].text,
    /servidor local da GPU falhou da última vez \(OOM\) — ele tenta subir de novo/
  )
  assert.match(gpuTtsProblems(TTS_GPU(null), status())[0].text, /escolha um motor/)
})

test('gpuSttProblems: whisper ausente / instalado', () => {
  assert.deepEqual(gpuSttProblems(STT_GPU, status()), [])
  assert.match(
    gpuSttProblems(
      STT_GPU,
      status({ engines: [engine({ id: 'whisper-large-v3-turbo', label: 'Whisper' })] })
    )[0].text,
    /instale o motor Whisper/
  )
  assert.deepEqual(gpuSttProblems({ ...STT_GPU, mode: 'api' }, null), [])
})

test('voiceCallReadiness com GPU: só erros barram; texto aponta o Modo avançado', () => {
  const omni = engine({
    id: 'omnivoice',
    label: 'OmniVoice',
    install: { state: 'installed' },
    voices: [{ id: 'c', label: 'c', source: 'cc0' }],
    compat: { level: 'warn', reasons: ['VRAM livre'] }
  })
  const view = {
    sttSettings: STT_GPU as unknown as SttSettings,
    ttsSettings: TTS_GPU({ engine: 'omnivoice', voice: 'c' }) as unknown as TtsSettings
  }
  const ok = status({
    engines: [omni, engine({ id: 'whisper-large-v3-turbo', install: { state: 'installed' } })],
    server: { state: 'stopped', engines: [] }
  })
  assert.deepEqual(voiceCallReadiness(view, null, ok), [])
  const missing = status({ engines: [{ ...omni, install: { state: 'absent' } }] })
  const p = voiceCallReadiness(view, null, missing)
  assert.equal(p.length, 2)
  assert.equal(
    p[0],
    'Transcrição (GPU local): o motor “whisper-large-v3-turbo” não existe nesta versão — escolha outro.'
  )
  assert.equal(
    p[1],
    'Fala (GPU local): instale o motor OmniVoice em Configurações → Áudio → Modelos locais.'
  )
  assert.match(
    voiceCallReadiness(view, null, null).join(' '),
    /Fala \(GPU local\): o modo GPU local não está disponível/
  )
})

// ---------------- amostra ----------------

test('pcm16ToWav: cabeçalho RIFF/PCM mono e dados', () => {
  const pcm = new Int16Array([0, 1000, -1000, 32767])
  const wav = new DataView(pcm16ToWav(pcm, 24000))
  const str = (o: number, n: number): string =>
    String.fromCharCode(...Array.from({ length: n }, (_, i) => wav.getUint8(o + i)))
  assert.equal(str(0, 4), 'RIFF')
  assert.equal(str(8, 4), 'WAVE')
  assert.equal(wav.getUint16(22, true), 1)
  assert.equal(wav.getUint32(24, true), 24000)
  assert.equal(wav.getUint32(40, true), 8)
  assert.equal(wav.byteLength, 52)
  assert.equal(wav.getInt16(46, true), 1000)
})

test('sampleDurationProblem: < 3 s ou > 30 s = erro, fora do ideal = aviso, 6–15 s = ok', () => {
  assert.equal(sampleDurationProblem(2)?.level, 'error')
  assert.equal(sampleDurationProblem(3.5)?.level, 'warn')
  assert.equal(sampleDurationProblem(40)?.level, 'error')
  assert.equal(sampleDurationProblem(5.5)?.level, 'warn')
  assert.equal(sampleDurationProblem(8), null)
  assert.equal(sampleDurationProblem(14), null)
  assert.equal(sampleDurationProblem(20)?.level, 'warn')
})

test('voiceCallReadiness com GPU sem status detalhado: usa o probe do main (runtime.gpuTts/gpuStt)', () => {
  const view = {
    sttSettings: STT_GPU as unknown as SttSettings,
    ttsSettings: TTS_GPU({ engine: 'xtts-v2', voice: null }) as unknown as TtsSettings
  }
  const ok = { available: true, reason: null }
  const runtime = {
    whisper: ok,
    onnxruntime: ok,
    espeak: ok,
    sttLocal: ok,
    ttsLocal: ok,
    gpuTts: { available: false, reason: 'o motor XTTS-v2 não está instalado' },
    gpuStt: ok
  }
  assert.deepEqual(voiceCallReadiness(view, runtime, null), [
    'Fala (GPU local): o motor XTTS-v2 não está instalado.'
  ])
  assert.deepEqual(voiceCallReadiness(view, { ...runtime, gpuTts: ok }, null), [])
})

// ---------------- liga sozinho: servidor, plano da chamada, prontidão, ditado ----------------

test('gpuServerLine: parado / iniciando (fase) / em uso por / falhou — sem botão de Iniciar', () => {
  assert.deepEqual(gpuServerLine({ server: { state: 'stopped', engines: [] } }), {
    state: 'stopped',
    text: 'parado',
    hint: 'liga sozinho quando precisa, desliga após 15 min sem uso'
  })
  assert.equal(
    gpuServerLine({ server: { state: 'starting', engines: [], phase: 'Aquecendo OmniVoice…' } })
      .text,
    'iniciando — Aquecendo OmniVoice…'
  )
  assert.equal(
    gpuServerLine({
      server: { state: 'running', engines: ['omnivoice', 'whisper-large-v3-turbo'] }
    }).text,
    'em uso por: OmniVoice + Whisper large-v3-turbo'
  )
  const err = gpuServerLine({ server: { state: 'error', engines: [], error: 'OOM' } })
  assert.equal(err.text, 'falhou da última vez')
  assert.match(err.hint, /tenta de novo sozinho/)
})

test('gpuCallPlan: aviso de uso da GPU, VRAM necessária × livre (pouca = aviso), servidor já quente', () => {
  const omni = engine({ id: 'omnivoice', vramMb: 5100, install: { state: 'installed' } })
  const xtts = engine({ id: 'xtts-v2', vramMb: 3700, install: { state: 'installed' } })
  const wh = engine({ id: 'whisper-large-v3-turbo', vramMb: 1500, install: { state: 'installed' } })
  const st = (
    free: number,
    server: GpuStatus['server'] = { state: 'stopped', engines: [] }
  ): GpuStatus =>
    status({
      gpus: [
        {
          vendor: 'nvidia',
          name: 'NVIDIA GeForce RTX 3080 Ti',
          vramTotalMb: 12288,
          vramFreeMb: free,
          driver: '615',
          cudaMax: '13.4'
        }
      ],
      engines: [omni, xtts, wh],
      server
    })
  const ttsX = TTS_GPU({ engine: 'xtts-v2', voice: null })
  const sttApi = { ...STT_GPU, mode: 'api' } as SttSettingsGpu
  // sem GPU em nada → sem plano
  assert.equal(gpuCallPlan({ ...ttsX, backend: 'api' }, sttApi, st(9000)), null)
  const p = gpuCallPlan(ttsX, sttApi, st(9000))!
  assert.deepEqual(p.engines, ['xtts-v2'])
  assert.equal(p.needsStart, true)
  assert.equal(p.vramNeedMb, 3700)
  assert.equal(p.gpuName, 'RTX 3080 Ti')
  assert.equal(p.notice, 'A chamada vai usar sua GPU (RTX 3080 Ti) — ~3,6 GB de VRAM')
  assert.equal(p.warning, null)
  // fala + transcrição: soma; VRAM livre baixa (um jogo aberto) → aviso que NÃO barra
  const low = gpuCallPlan(TTS_GPU({ engine: 'omnivoice', voice: null }), STT_GPU, st(2150))!
  assert.deepEqual(low.engines, ['omnivoice', 'whisper-large-v3-turbo'])
  assert.equal(low.vramNeedMb, 6600)
  assert.equal(
    low.warning,
    'Pouca VRAM livre (2,1 GB de 6,4 GB) — a chamada pode falhar ou ficar lenta; feche outros programas que usam a GPU'
  )
  // servidor já rodando com os motores: nada a carregar, nada a avisar
  const warm = gpuCallPlan(
    ttsX,
    STT_GPU,
    st(500, { state: 'running', engines: ['xtts-v2', 'whisper-large-v3-turbo'] })
  )!
  assert.equal(warm.needsStart, false)
  assert.equal(warm.notice, null)
  assert.equal(warm.warning, null)
  // só falta o whisper: só ele conta
  const half = gpuCallPlan(ttsX, STT_GPU, st(9000, { state: 'running', engines: ['xtts-v2'] }))!
  assert.deepEqual(half.toLoad, ['whisper-large-v3-turbo'])
  assert.equal(half.vramNeedMb, 1500)
  // ditado: texto próprio
  assert.match(
    gpuCallPlan({ ...ttsX, backend: 'api' }, STT_GPU, st(9000), 'ditado')!.notice!,
    /^O ditado vai usar sua GPU/
  )
  // sem NVIDIA: avisa que roda na CPU
  assert.match(gpuCallPlan(ttsX, sttApi, status({ gpus: [], engines: [xtts] }))!.notice!, /CPU/)
})

test('voiceCallReadiness com GPU: servidor parado = ok (liga sozinho), com erro antes = não barra, motor ausente = erro', () => {
  const omni = engine({
    id: 'omnivoice',
    label: 'OmniVoice',
    install: { state: 'installed' },
    voices: [{ id: 'c', label: 'c', source: 'cc0' }]
  })
  const wh = engine({
    id: 'whisper-large-v3-turbo',
    label: 'Whisper',
    install: { state: 'installed' }
  })
  const view = {
    sttSettings: STT_GPU as unknown as SttSettings,
    ttsSettings: TTS_GPU({ engine: 'omnivoice', voice: 'c' }) as unknown as TtsSettings
  }
  for (const server of [
    { state: 'stopped' as const, engines: [] },
    { state: 'starting' as const, engines: [], phase: 'Iniciando OmniVoice…' },
    { state: 'error' as const, engines: [], error: 'o servidor da GPU caiu (código 1)' }
  ])
    assert.deepEqual(voiceCallReadiness(view, null, status({ engines: [omni, wh], server })), [])
  // pouca VRAM livre: a compat do motor vira aviso — também não barra
  const lowVram = {
    ...omni,
    compat: { level: 'warn' as const, reasons: ['VRAM livre agora: 2,1 GB'] }
  }
  assert.deepEqual(voiceCallReadiness(view, null, status({ engines: [lowVram, wh] })), [])
  // motor ausente: erro (barra com o caminho)
  assert.deepEqual(
    voiceCallReadiness(
      view,
      null,
      status({ engines: [omni, { ...wh, install: { state: 'absent' } }] })
    ),
    ['Transcrição (GPU local): instale o motor Whisper em Configurações → Áudio → Modelos locais.']
  )
})

test('ditado com transcrição gpu: liga o servidor (whisper) e mostra "preparando a GPU…" só se demorar', async () => {
  const calls: unknown[] = []
  const listeners = new Set<(s: GpuStatus) => void>()
  let release: () => void = () => undefined
  const fakeGpu = {
    startServer: (ids?: string[]) => {
      calls.push(ids)
      return new Promise<void>((r) => (release = r))
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      voice: { gpu: fakeGpu },
      onVoiceGpuProgress: (cb: (s: GpuStatus) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    }
  }
  const prep = await import('../src/renderer/src/lib/voice/gpu/gpuPrepare.ts')
  // fora do modo gpu: nada
  await prep.prepareGpuForDictation({ mode: 'api' })
  assert.deepEqual(calls, [])
  const p = prep.prepareGpuForDictation({ mode: 'gpu' })
  assert.deepEqual(calls, [['whisper-large-v3-turbo']])
  assert.equal(prep.useGpuPrepare.getState().dictation, null, 'sem piscar antes do atraso')
  await new Promise((r) => setTimeout(r, prep.SHOW_AFTER_MS + 50))
  assert.equal(prep.useGpuPrepare.getState().dictation?.text, 'Preparando a GPU…')
  listeners.forEach((l) =>
    l(
      status({
        server: { state: 'starting', engines: [], phase: 'Aquecendo Whisper large-v3-turbo…' }
      })
    )
  )
  assert.equal(
    prep.useGpuPrepare.getState().dictation?.text,
    'Preparando a GPU… Aquecendo Whisper large-v3-turbo…'
  )
  release()
  await p
  assert.equal(prep.useGpuPrepare.getState().dictation, null)
  assert.equal(listeners.size, 0)
  // servidor já quente: resolve antes do atraso → nunca mostra
  const fast = prep.prepareGpuForDictation({ mode: 'gpu' })
  release()
  await fast
  await new Promise((r) => setTimeout(r, prep.SHOW_AFTER_MS + 50))
  assert.equal(prep.useGpuPrepare.getState().dictation, null)
  // falha ao subir: rejeita com o motivo (o ditado mostra) e limpa o estado
  fakeGpu.startServer = () => Promise.reject(new Error('GPU sem memória'))
  await assert.rejects(prep.prepareGpuForDictation({ mode: 'gpu' }), /GPU sem memória/)
  assert.equal(prep.useGpuPrepare.getState().dictation, null)
})

test('parâmetros (UI): linhas com padrão, mudar/restaurar grava só overrides, por motor, sobrevive à troca de motor', () => {
  const rows = gpuParamRows('xtts-v2', {})
  assert.deepEqual(
    rows.map((r) => r.spec.key),
    GPU_ENGINE_PARAMS['xtts-v2'].map((s) => s.key)
  )
  const speed = rows.find((r) => r.spec.key === 'speed')!
  assert.equal(speed.value, XTTS_DEFAULT_SPEED)
  assert.equal(speed.changed, false)
  assert.equal(speed.display, '1,15×')
  // mudar: limitado à faixa; voltar ao padrão tira a chave
  let o = setGpuParam('xtts-v2', {}, 'speed', 1.234)
  assert.deepEqual(o, { speed: 1.23 })
  o = setGpuParam('xtts-v2', o, 'speed', 9)
  assert.deepEqual(o, { speed: 1.5 })
  assert.equal(gpuParamRows('xtts-v2', o).find((r) => r.spec.key === 'speed')!.changed, true)
  assert.deepEqual(setGpuParam('xtts-v2', o, 'speed', XTTS_DEFAULT_SPEED), {})
  assert.deepEqual(setGpuParam('xtts-v2', o, 'nope', 1), o, 'chave desconhecida ignorada')
  // settings: por motor; vazio remove; o normalizador compartilhado preserva
  const base = normalizeTtsSettings({ backend: 'gpu', gpu: { engine: 'xtts-v2', voice: null } })
  const t1 = ttsWithGpuParams(base, 'xtts-v2', { speed: 1.3 })
  const t2 = ttsWithGpuParams(t1, 'omnivoice', { guidance_scale: 2.5 })
  assert.deepEqual(normalizeTtsSettings(t2).gpu?.params, {
    'xtts-v2': { speed: 1.3 },
    omnivoice: { guidance_scale: 2.5 }
  })
  assert.deepEqual(savedGpuParams('xtts-v2', t2, null), { speed: 1.3 })
  const t3 = ttsWithGpuParams(t2, 'xtts-v2', {})
  assert.deepEqual(t3.gpu?.params, { omnivoice: { guidance_scale: 2.5 } })
  assert.equal(ttsWithGpuParams(t3, 'omnivoice', {}).gpu?.params, undefined)
  // trocar de motor não perde os parâmetros de nenhum
  const xtts = engine({ id: 'xtts-v2', install: { state: 'installed' } })
  const omni = engine({ id: 'omnivoice', install: { state: 'installed' } })
  assert.deepEqual(gpuConfigFor(omni, t2.gpu).params, t2.gpu?.params)
  assert.deepEqual(gpuConfigFor(xtts, gpuConfigFor(omni, t2.gpu)).params, t2.gpu?.params)
  // whisper: sttSettings.gpu.params
  const stt = sttWithGpuParams(normalizeSttSettings({ mode: 'gpu' }), {
    beam_size: 3,
    vad_filter: true,
    language: 'pt'
  })
  assert.deepEqual(normalizeSttSettings(stt).gpu, {
    engine: 'whisper-large-v3-turbo',
    params: { beam_size: 3, vad_filter: true }
  })
  assert.deepEqual(savedGpuParams('whisper-large-v3-turbo', null, stt), {
    beam_size: 3,
    vad_filter: true
  })
  const lang = GPU_ENGINE_PARAMS['whisper-large-v3-turbo'].find((x) => x.key === 'language')!
  assert.equal(formatGpuParam(lang, 'auto'), 'Detectar')
  const vad = GPU_ENGINE_PARAMS['whisper-large-v3-turbo'].find((x) => x.key === 'vad_filter')!
  assert.equal(formatGpuParam(vad, true), 'ligado')
})

test('gpuCallPlan: motor já carregado não "carrega de novo"; a VRAM que o app libera ao trocar conta', () => {
  const omni = engine({
    id: 'omnivoice',
    vramMb: 5100,
    install: { state: 'installed' },
    vram: { loaded: false, availMb: 8500, releases: ['XTTS-v2'] }
  })
  const xtts = engine({
    id: 'xtts-v2',
    vramMb: 3700,
    install: { state: 'installed' },
    vram: { loaded: true, availMb: 3000, releases: [] }
  })
  const wh = engine({
    id: 'whisper-large-v3-turbo',
    vramMb: 1500,
    install: { state: 'installed' },
    vram: { loaded: true, availMb: 3000, releases: [] }
  })
  const st = status({
    gpus: [
      {
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 3080 Ti',
        vramTotalMb: 12288,
        vramFreeMb: 3000,
        vramOwnMb: 5500,
        driver: '615',
        cudaMax: '13.4'
      }
    ],
    engines: [omni, xtts, wh],
    server: { state: 'running', engines: ['xtts-v2', 'whisper-large-v3-turbo'] }
  })
  // XTTS (carregado) + whisper: nada a carregar, nada a avisar mesmo com 3 GB livres
  const warm = gpuCallPlan(TTS_GPU({ engine: 'xtts-v2', voice: null }), STT_GPU, st)!
  assert.deepEqual(warm.toLoad, [])
  assert.equal(warm.warning, null)
  // trocar para o OmniVoice: 3 GB livres + 5,5 GB do XTTS que o app libera ≥ 5,1 GB → sem aviso
  const swap = gpuCallPlan(TTS_GPU({ engine: 'omnivoice', voice: null }), STT_GPU, st)!
  assert.deepEqual(swap.toLoad, ['omnivoice'])
  assert.equal(swap.vramFreeMb, 8500)
  assert.equal(swap.warning, null)
})
