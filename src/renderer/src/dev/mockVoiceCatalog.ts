// Mock da descoberta de modelos/vozes de áudio (`voice.catalog`) para o build de desenvolvimento
// (screenshots/E2E sem backend). Os dados do OpenRouter são um recorte REAL de
// `/api/v1/models?output_modalities=speech|transcription` (2026-10-23) passado pelos mesmos
// parsers do main; o ElevenLabs direto é um recorte do formato de `/v1/models` + `/v1/voices`.
// A curadoria da chamada (`curateVoiceModels`) é a mesma do main: no TTS só aparecem os modelos
// medidos rápidos com pt-BR; os outros vão em `hiddenModels`.
import {
  curateVoiceModels,
  parseElevenLabsModels,
  parseElevenLabsVoices,
  parseOpenRouterAudioModels,
  OPENAI_TTS_VOICES,
  type VoiceCatalogRequest,
  type VoiceCatalogView
} from '@shared/voiceCatalog'
import type { Provider } from '@shared/types'

const ELEVEN_21 = [
  'george',
  'sarah',
  'adam',
  'alice',
  'bella',
  'bill',
  'brian',
  'callum',
  'charlie',
  'chris',
  'daniel',
  'eric',
  'harry',
  'jessica',
  'laura',
  'liam',
  'lily',
  'matilda',
  'river',
  'roger',
  'will'
]

const tts = (id: string, name: string, price: string, voices: string[]): unknown => ({
  id,
  name,
  description: `${name} — modelo de fala.`,
  architecture: { output_modalities: ['speech'] },
  pricing: { prompt: price, completion: '0' },
  supported_voices: voices
})
const stt = (id: string, name: string, price: string): unknown => ({
  id,
  name,
  description: `${name} — modelo de transcrição.`,
  architecture: { output_modalities: ['transcription'] },
  pricing: { prompt: price, completion: '0' },
  supported_voices: []
})

const OPENROUTER_SPEECH = {
  data: [
    tts('elevenlabs/eleven-flash-v2.5', 'ElevenLabs: Eleven Flash v2.5', '0.00004', ELEVEN_21),
    tts('elevenlabs/eleven-turbo-v2.5', 'ElevenLabs: Eleven Turbo v2.5', '0.00004', ELEVEN_21),
    tts(
      'elevenlabs/eleven-multilingual-v2',
      'ElevenLabs: Eleven Multilingual v2',
      '0.00008',
      ELEVEN_21
    ),
    tts('elevenlabs/eleven-v4-turbo', 'ElevenLabs: Eleven v4 Turbo', '0.00004', ELEVEN_21),
    tts('google/gemini-3.8-flash-tts', 'Google: Gemini 3.8 Flash TTS', '0.0000005', [
      'Zephyr',
      'Puck',
      'Charon',
      'Kore'
    ]),
    tts('hexgrad/kokoro-82m', 'hexgrad: Kokoro 82M', '0.00000062', [
      'pf_dora',
      'pm_alex',
      'af_heart',
      'bm_daniel'
    ]),
    tts('microsoft/mai-voice-2', 'Microsoft AI: MAI-Voice-2', '0.000022', [
      'en-US-Harper:MAI-Voice-2',
      'es-MX-Valeria:MAI-Voice-2'
    ]),
    tts('microsoft/mai-voice-2.1-flash', 'Microsoft AI: MAI-Voice-2.1-Flash', '0.000015', [
      'en-US-Harper:MAI-Voice-2.1-Flash',
      'es-MX-Valeria:MAI-Voice-2.1-Flash',
      'pt-BR-Caio:MAI-Voice-2.1-Flash',
      'pt-BR-Luana:MAI-Voice-2.1-Flash',
      'pt-PT-Rui:MAI-Voice-2.1-Flash'
    ]),
    tts('fish-audio/s1', 'Fish Audio: S1', '0.000015', []),
    tts('x-ai/grok-voice-tts-1.0', 'xAI: Grok Voice TTS 1.0', '0.000015', [
      'eve',
      'ara',
      'rex',
      'sal',
      'leo'
    ])
  ]
}

const OPENROUTER_TRANSCRIPTION = {
  data: [
    stt('openai/whisper-large-v3-turbo', 'OpenAI: Whisper Large V3 Turbo', '0.00000333'),
    stt('openai/gpt-4o-mini-transcribe', 'OpenAI: GPT-4o Mini Transcribe', '0.00000125'),
    stt('elevenlabs/scribe-v2', 'ElevenLabs: Scribe v2', '0.0000611111111111'),
    stt('deepgram/nova-3', 'Deepgram: Nova-3', '0.0000716666666667'),
    stt(
      'mistralai/voxtral-mini-transcribe-3-0',
      'Mistral: Voxtral Mini Transcribe 3',
      '0.0000583333'
    ),
    stt('google/gemini-3.5-transcribe', 'Google: Gemini 3.5 Transcribe', '0.0000016')
  ]
}

const ELEVEN_MODELS = [
  {
    model_id: 'eleven_flash_v2_5',
    name: 'Eleven Flash v2.5',
    description: 'Ultra low latency model. Supports 32 languages.',
    can_do_text_to_speech: true,
    languages: [
      { language_id: 'pt', name: 'Portuguese' },
      { language_id: 'en', name: 'English' }
    ]
  },
  {
    model_id: 'eleven_multilingual_v2',
    name: 'Eleven Multilingual v2',
    description: 'Our most life-like, emotionally rich model.',
    can_do_text_to_speech: true,
    languages: [
      { language_id: 'pt', name: 'Portuguese' },
      { language_id: 'en', name: 'English' }
    ]
  },
  {
    model_id: 'eleven_english_sts_v2',
    name: 'Eleven English v2 (STS)',
    can_do_text_to_speech: false
  }
]

const ELEVEN_VOICES = {
  voices: [
    {
      voice_id: 'EXAVITQu4vr4xnSDxMaL',
      name: 'Sarah - Mature, Reassuring, Confident',
      labels: { gender: 'female', accent: 'american' },
      preview_url: 'https://storage.example/sarah.mp3',
      verified_languages: [
        { language: 'pt', locale: 'pt-BR', preview_url: 'https://storage.example/sarah-pt.mp3' },
        { language: 'en', locale: 'en-US' }
      ]
    },
    {
      voice_id: 'JBFqnCBsd6RMkjVDRZzb',
      name: 'George - Warm Storyteller',
      labels: { gender: 'male', accent: 'british' },
      preview_url: 'https://storage.example/george.mp3',
      verified_languages: [{ language: 'en', locale: 'en-GB' }]
    }
  ]
}

/** `voice.catalog` do mock. `providers()` lê o estado atual do mock. */
export function createMockVoiceCatalog(
  providers: () => Provider[],
  delay: <T>(v: T, ms?: number) => Promise<T>
): {
  list(input: VoiceCatalogRequest): Promise<VoiceCatalogView>
  preview(input: { url: string }): Promise<{ audio: Uint8Array; mime: string }>
} {
  const base = (input: VoiceCatalogRequest): VoiceCatalogView => ({
    capability: input.capability,
    providerId: input.providerId,
    source: 'none',
    models: [],
    voices: [],
    freeText: true,
    error: null,
    hint: null,
    fetchedAt: Date.now()
  })
  return {
    list: async (input) => {
      const v = base(input)
      const p = input.providerId ? providers().find((x) => x.id === input.providerId) : null
      if (!p)
        return delay({
          ...v,
          error: input.providerId
            ? 'o provedor escolhido não existe mais (Configurações → Provedores)'
            : null,
          hint: input.providerId
            ? null
            : 'escolha um provedor em Configurações → Áudio para listar os modelos'
        })
      const url = p.baseUrl
      if (/openrouter\.ai/.test(url)) {
        const r = parseOpenRouterAudioModels(
          input.capability === 'stt' ? OPENROUTER_TRANSCRIPTION : OPENROUTER_SPEECH,
          input.capability
        )
        const cur = curateVoiceModels(r.models, input.capability, 'openrouter')
        return delay(
          {
            ...v,
            source: 'openrouter',
            freeText: false,
            voices: r.voices,
            models: cur.models,
            ...(cur.curated ? { curated: true, hiddenModels: cur.hidden } : {})
          },
          300
        )
      }
      if (/elevenlabs\.io/.test(url)) {
        if (input.capability === 'stt')
          return delay({
            ...v,
            freeText: false,
            hint: 'o ElevenLabs direto só serve a fala (TTS) aqui'
          })
        const cur = curateVoiceModels(parseElevenLabsModels(ELEVEN_MODELS), 'tts', 'elevenlabs')
        return delay(
          {
            ...v,
            source: 'elevenlabs',
            freeText: false,
            models: cur.models,
            curated: true,
            hiddenModels: cur.hidden,
            voices: parseElevenLabsVoices(ELEVEN_VOICES)
          },
          300
        )
      }
      // Groq cadastrado em Provedores: com a chave lista os whisper; sem chave, 401
      if (/groq\.com/.test(url) && p.apiKey)
        return delay(
          {
            ...v,
            source: 'openai',
            freeText: true,
            models:
              input.capability === 'stt'
                ? [
                    { id: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo' },
                    { id: 'whisper-large-v3', label: 'whisper-large-v3' }
                  ]
                : []
          },
          250
        )
      if (/groq\.com/.test(url))
        return delay({
          ...v,
          source: 'openai',
          error: 'chave de API inválida ou sem permissão para listar (HTTP 401) — Invalid API Key',
          hint: 'digite o id do modelo (o endpoint não lista modelos)'
        })
      return delay({
        ...v,
        source: 'openai',
        voices:
          input.capability === 'tts' ? OPENAI_TTS_VOICES.map((id) => ({ id, label: id })) : [],
        hint: 'o endpoint não listou modelos — digite o id'
      })
    },
    preview: async ({ url }) => {
      if (!/^https:\/\/storage\.example\//.test(url))
        throw new Error('prévia de voz desconhecida — atualize a lista de vozes')
      return delay({ audio: mockToneWav(660), mime: 'audio/wav' }, 150)
    }
  }
}

/** WAV falso (seno, 0,5 s a 24 kHz) — prévia/teste de voz do mock. */
export function mockToneWav(hz: number): Uint8Array {
  const samples = 12_000
  const buf = new Uint8Array(44 + samples * 2)
  const view = new DataView(buf.buffer)
  const ascii = (o: number, t: string): void =>
    [...t].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 24_000, true)
  view.setUint32(28, 48_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++)
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / 24_000) * 6000), true)
  return buf
}
