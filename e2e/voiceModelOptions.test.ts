// Seletor ÚNICO de modelo de Configurações → Áudio (lógica PURA de
// `src/renderer/src/lib/voice/voiceModelOptions.ts` e as linhas do editor "Parâmetros" de
// `lib/voice/apiParams.ts`): grupos "Local (CPU)"/"Local (GPU)" só com modelo instalado (sem
// instalado, nenhum grupo local), escolher uma linha grava modo/backend + provedor + motor +
// modelo de uma vez, visibilidade do interruptor do híbrido e a busca de Configurações levando à
// sub-tela "Modelos locais".
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceModelOptions.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { VoiceModelInfo } from '@shared/ipc'
import type { GpuEngineStatus, GpuStatus } from '@shared/gpuVoice'
import {
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  type SttSettings,
  type TtsSettings
} from '@shared/voice'
import { apiParamSpecs } from '@shared/voiceParams'
import {
  applySttPick,
  applyTtsPick,
  hybridToggleVisible,
  KOKORO_OPTION,
  LOCAL_CPU_GROUP,
  LOCAL_GPU_GROUP,
  setHybrid,
  sttLocalGroups,
  sttModelRef,
  ttsLocalGroups,
  ttsModelRef
} from '../src/renderer/src/lib/voice/voiceModelOptions.ts'
import { apiParamRows, setApiParamValue } from '../src/renderer/src/lib/voice/apiParams.ts'
import { filterSettingsNav } from '../src/renderer/src/lib/settingsNav.ts'

const model = (
  over: Partial<VoiceModelInfo> & Pick<VoiceModelInfo, 'id' | 'kind' | 'engine'>
): VoiceModelInfo => ({
  name: over.id,
  description: '',
  languages: ['mul'],
  version: '1',
  sizeBytes: 100,
  hasDownload: true,
  state: 'notInstalled',
  installedBytes: null,
  ...over
})

const CATALOG = (installed: string[] = []): VoiceModelInfo[] =>
  [
    model({ id: 'ggml-base', kind: 'stt', engine: 'whisper.cpp', name: 'ggml-base' }),
    model({ id: 'vosk-model-small-pt-0.3', kind: 'stt', engine: 'vosk', name: 'Vosk pt' }),
    model({ id: 'kokoro-onnx', kind: 'tts', engine: 'kokoro', name: 'Kokoro ONNX' }),
    model({ id: 'kokoro-voice-pf-dora', kind: 'tts', engine: 'kokoro', name: 'pf_dora' })
  ].map((m) => (installed.includes(m.id) ? { ...m, state: 'installed' as const } : m))

const engine = (over: Partial<GpuEngineStatus> & Pick<GpuEngineStatus, 'id'>): GpuEngineStatus => ({
  kind: over.id === 'whisper-large-v3-turbo' ? 'stt' : 'tts',
  label: over.id,
  license: { name: 'Apache-2.0', url: 'https://x', commercial: true },
  sizeMb: 2000,
  vramMb: 3000,
  languages: ['pt'],
  ptBR: 'ok',
  streaming: true,
  voices: [{ id: 'cc0-faber', label: 'Faber', source: 'cc0', accent: 'pt-BR' }],
  install: { state: 'absent' },
  compat: { level: 'ok', reasons: [] },
  ...over
})
const gpu = (installed: string[]): GpuStatus => ({
  platform: { os: 'linux', arch: 'x64', diskFreeMb: 200_000 },
  gpus: [],
  runtime: { state: 'installed', version: 'x', sizeMb: 6000 },
  engines: ['omnivoice', 'xtts-v2', 'whisper-large-v3-turbo'].map((id) =>
    engine({
      id: id as GpuEngineStatus['id'],
      install: { state: installed.includes(id) ? 'installed' : 'absent' }
    })
  ),
  server: { state: 'stopped', engines: [] }
})

const STT_API: SttSettings = {
  ...DEFAULT_STT_SETTINGS,
  api: { providerId: 'groq', model: 'whisper-large-v3-turbo' }
}
const TTS_API: TtsSettings = {
  ...DEFAULT_TTS_SETTINGS,
  backend: 'api',
  api: { providerId: 'or', model: 'elevenlabs/eleven-flash-v2.5', voice: 'sarah' }
}

test('grupos locais: nenhum sem modelo instalado; CPU/GPU aparecem só com o tipo certo instalado', () => {
  assert.deepEqual(sttLocalGroups(CATALOG(), null, STT_API), [], 'nada instalado: sem grupo local')
  assert.deepEqual(
    sttLocalGroups(CATALOG(), gpu(['omnivoice']), STT_API),
    [],
    'motor de FALA não conta no STT'
  )
  assert.deepEqual(
    ttsLocalGroups(CATALOG(['kokoro-voice-pf-dora']), null, TTS_API),
    [],
    'só voz sem pesos não conta'
  )
  const stt = sttLocalGroups(CATALOG(['ggml-base']), gpu(['whisper-large-v3-turbo']), STT_API)
  assert.deepEqual(
    stt.map((g) => [g.id, g.name, g.options.map((o) => o.id)]),
    [
      [LOCAL_CPU_GROUP, 'Local (CPU)', ['ggml-base']],
      [LOCAL_GPU_GROUP, 'Local (GPU)', ['whisper-large-v3-turbo']]
    ]
  )
  const tts = ttsLocalGroups(
    CATALOG(['kokoro-onnx']),
    gpu(['omnivoice', 'whisper-large-v3-turbo']),
    TTS_API
  )
  assert.deepEqual(
    tts.map((g) => [g.id, g.options.map((o) => o.id)]),
    [
      [LOCAL_CPU_GROUP, [KOKORO_OPTION]],
      [LOCAL_GPU_GROUP, ['omnivoice']]
    ]
  )
  // seleção atual num local não instalado: aparece marcada (o campo avisa "não instalado")
  const stale = ttsLocalGroups(CATALOG(), null, { ...DEFAULT_TTS_SETTINGS, backend: 'local' })
  assert.deepEqual(
    stale.map((g) => g.options.map((o) => [o.id, o.installed])),
    [[[KOKORO_OPTION, false]]]
  )
})

test('escolher no seletor grava tudo de uma vez (modo/backend + provedor + motor + modelo)', () => {
  const models = CATALOG(['ggml-base', 'vosk-model-small-pt-0.3', 'kokoro-onnx'])
  // STT: local CPU (motor da linha)
  const local = applySttPick(
    STT_API,
    { providerId: LOCAL_CPU_GROUP, model: 'vosk-model-small-pt-0.3' },
    models
  )
  assert.equal(local.mode, 'local')
  assert.deepEqual(local.local, {
    engine: 'vosk',
    model: 'vosk-model-small-pt-0.3',
    installed: true
  })
  assert.deepEqual(sttModelRef(local), {
    providerId: LOCAL_CPU_GROUP,
    model: 'vosk-model-small-pt-0.3'
  })
  // STT: GPU
  const g = applySttPick(
    local,
    { providerId: LOCAL_GPU_GROUP, model: 'whisper-large-v3-turbo' },
    models
  )
  assert.equal(g.mode, 'gpu')
  assert.deepEqual(g.gpu, { engine: 'whisper-large-v3-turbo' })
  assert.deepEqual(sttModelRef(g), { providerId: LOCAL_GPU_GROUP, model: 'whisper-large-v3-turbo' })
  // STT: provedor (o híbrido continua se já estava)
  const api = applySttPick(g, { providerId: 'or', model: 'openai/whisper-large-v3-turbo' }, models)
  assert.equal(api.mode, 'api')
  assert.deepEqual([api.api.providerId, api.api.model], ['or', 'openai/whisper-large-v3-turbo'])
  const hy = applySttPick(
    { ...STT_API, mode: 'hybrid' },
    { providerId: 'or', model: 'x/y' },
    models
  )
  assert.equal(hy.mode, 'hybrid')
  // TTS: Kokoro / GPU / provedor
  const k = applyTtsPick(
    TTS_API,
    { providerId: LOCAL_CPU_GROUP, model: KOKORO_OPTION },
    { models, gpu: null }
  )
  assert.equal(k.backend, 'local')
  assert.deepEqual(k.local, { engine: 'kokoro', voice: 'pf_dora', installed: true })
  assert.deepEqual(ttsModelRef(k), { providerId: LOCAL_CPU_GROUP, model: KOKORO_OPTION })
  const st = gpu(['omnivoice'])
  const o = applyTtsPick(
    k,
    { providerId: LOCAL_GPU_GROUP, model: 'omnivoice' },
    { models, gpu: st }
  )
  assert.equal(o.backend, 'gpu')
  assert.equal(o.gpu?.engine, 'omnivoice')
  assert.equal(o.gpu?.voice, 'cc0-faber', 'voz sugerida do motor')
  const el = applyTtsPick(
    o,
    { providerId: 'xi', model: 'eleven_flash_v2_5' },
    { models, gpu: st, voice: null }
  )
  assert.equal(el.backend, 'api')
  assert.deepEqual(
    [el.api.providerId, el.api.model, el.api.voice],
    ['xi', 'eleven_flash_v2_5', null]
  )
  assert.equal(el.gpu?.engine, 'omnivoice', 'o bloco da GPU fica guardado')
})

test('híbrido: interruptor só com modelo de API escolhido E modelo local (CPU) instalado', () => {
  assert.equal(hybridToggleVisible(STT_API, CATALOG()), false, 'sem local instalado')
  assert.equal(hybridToggleVisible(STT_API, CATALOG(['ggml-base'])), true)
  assert.equal(
    hybridToggleVisible(
      { ...STT_API, api: { providerId: null, model: 'w' } },
      CATALOG(['ggml-base'])
    ),
    false,
    'sem modelo de API'
  )
  assert.equal(
    hybridToggleVisible({ ...STT_API, mode: 'local' }, CATALOG(['ggml-base'])),
    false,
    'modelo local escolhido: não há híbrido'
  )
  const on = setHybrid(STT_API, true, CATALOG(['ggml-base']))
  assert.equal(on.mode, 'hybrid')
  assert.deepEqual(on.local, { engine: 'whisper.cpp', model: 'ggml-base', installed: true })
  assert.equal(setHybrid(on, false, CATALOG(['ggml-base'])).mode, 'api')
})

test('editor de parâmetros remotos: "da voz (conta)" até mexer; restaurar tira a chave', () => {
  const specs = apiParamSpecs('tts', 'elevenlabs', 'eleven_flash_v2_5', { ws: true })
  const rows = apiParamRows(specs, { stability: 0.4 })
  const st = rows.find((r) => r.spec.key === 'stability')!
  assert.deepEqual([st.value, st.changed, st.unset, st.display], [0.4, true, false, '0,40'])
  const sp = rows.find((r) => r.spec.key === 'speed')!
  assert.deepEqual([sp.value, sp.changed, sp.unset, sp.display], [1, false, true, 'da voz (conta)'])
  assert.equal(sp.defaultDisplay, 'da voz (conta)')
  assert.equal(sp.hint, 'API: 1,00×')
  const fmt = rows.find((r) => r.spec.key === 'output_format')!
  assert.deepEqual([fmt.value, fmt.changed], ['pcm_24000', false])
  assert.match(fmt.spec.options!.find((o) => o.value === 'pcm_44100')!.note!, /exige plano Pro/)
  assert.deepEqual(setApiParamValue('tts', 'elevenlabs', { stability: 0.4 }, 'stability', null), {})
  assert.deepEqual(
    setApiParamValue('tts', 'elevenlabs', {}, 'output_format', 'pcm_24000'),
    {},
    'voltar ao padrão não grava'
  )
})

test('busca de Configurações: termos de modelos locais levam à sub-tela "Modelos locais"', () => {
  for (const q of ['kokoro', 'modelos locais', 'gpu', 'whisper', 'offline']) {
    const r = filterSettingsNav(q)
    assert.equal(r.best?.id, 'audio', q)
    assert.equal(r.bestSub?.target, 'audio:local', q)
  }
  const mic = filterSettingsNav('microfone')
  assert.equal(mic.best?.id, 'audio')
  assert.equal(mic.bestSub, null, 'termo da página principal: sem sub-tela')
  assert.match(
    filterSettingsNav('kokoro').groups[0].matches[0].keyword ?? '',
    /Modelos locais · kokoro/
  )
})
