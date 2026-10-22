// Settings de áudio (`src/main/voice.ts`) no repositório REAL (db.ts/repo.ts com o módulo
// `electron` substituído por stub — padrão de e2e/branches.test.ts): round-trip normalizado dos 4
// grupos, proteção da apiKey (PROTECTED_SETTINGS + máscara em get/set — a chave real nunca sai do
// main) e escrita por cima do valor mascarado preservando a chave real (espelho de
// webSearchApiKeys). Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTECTED_SETTINGS } from '../src/shared/webSearchSettings.ts'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  type SttSettings,
  type TtsSettings
} from '../src/shared/voice.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-voice-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

process.env.CLEARCHAT_TEST_USERDATA = TMP
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export default { app }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

type VoiceMod = typeof import('../src/main/voice.ts')
type RepoMod = typeof import('../src/main/repo.ts')
let voiceMod: VoiceMod | null = null
let repoMod: RepoMod | null = null
async function voice(): Promise<VoiceMod> {
  voiceMod ??= await import('../src/main/voice.ts')
  return voiceMod
}
async function repo(): Promise<RepoMod> {
  repoMod ??= await import('../src/main/repo.ts')
  return repoMod
}
after(async () => {
  if (repoMod) (await import('../src/main/db.ts')).closeDb()
})

const realSttKey = async (): Promise<string> =>
  (await repo()).settingsRepo.get<SttSettings>('sttSettings')?.api.apiKey ?? ''
const realTtsKey = async (): Promise<string> =>
  (await repo()).settingsRepo.get<TtsSettings>('ttsSettings')?.api.apiKey ?? ''

// ---------------- proteção ----------------

test('PROTECTED_SETTINGS cobre as settings com chave (stt/tts/webSearch) e não as demais', () => {
  assert.ok(PROTECTED_SETTINGS.includes('webSearchApiKeys'))
  assert.ok(PROTECTED_SETTINGS.includes('sttSettings'))
  assert.ok(PROTECTED_SETTINGS.includes('ttsSettings'))
  assert.ok(!PROTECTED_SETTINGS.includes('audioInput'))
  assert.ok(!PROTECTED_SETTINGS.includes('voiceCallDefaults'))
})

// ---------------- round-trip normalizado ----------------

test('audioInput: set normaliza e grava; get devolve o mesmo (silenceStopMs 0 preservado)', async () => {
  const v = await voice()
  const saved = v.setVoiceSetting('audioInput', {
    deviceId: '  mic-1  ',
    pttKey: 'Ctrl+K',
    silenceStopMs: 0,
    language: ''
  })
  assert.deepEqual(saved, {
    deviceId: 'mic-1',
    pttEnabled: true,
    pttKey: 'Ctrl+K',
    silenceStopEnabled: true,
    silenceStopMs: 0,
    language: 'pt-BR'
  })
  assert.deepEqual(v.getVoiceSettingsView().audioInput, saved)
  // lixo volta aos padrões
  assert.deepEqual(v.setVoiceSetting('audioInput', 42), DEFAULT_AUDIO_INPUT)
  assert.deepEqual(v.getVoiceSettingsView().audioInput, DEFAULT_AUDIO_INPUT)
})

test('voiceCallDefaults: parcial completa com os padrões; get devolve o gravado', async () => {
  const v = await voice()
  const saved = v.setVoiceSetting('voiceCallDefaults', {
    enabled: false,
    interjections: { cooldownMs: 1000 },
    fillers: {}
  })
  assert.equal(saved.enabled, false)
  assert.equal(saved.interjections.cooldownMs, 1000)
  assert.equal(
    saved.interjections.enabled,
    DEFAULT_VOICE_CALL_DEFAULTS.interjections.enabled,
    'campos ausentes completam com o padrão'
  )
  assert.deepEqual(saved.fillers, DEFAULT_VOICE_CALL_DEFAULTS.fillers)
  assert.deepEqual(v.getVoiceSettingsView().voiceCallDefaults, saved)
})

// ---------------- apiKey: máscara + preservação ----------------

test('sttSettings: a chave real fica no banco; get/set devolvem a máscara', async () => {
  const v = await voice()
  const saved = v.setVoiceSetting('sttSettings', {
    api: { apiKey: 'gsk-abcdefghijklmnop', model: 'm1' }
  })
  assert.equal(saved.api.apiKey, 'gsk-…mnop', 'set devolve mascarado')
  assert.equal(saved.api.model, 'm1')
  assert.equal(await realSttKey(), 'gsk-abcdefghijklmnop', 'chave real gravada no banco')
  assert.equal(
    v.getVoiceSettingsView().sttSettings.api.apiKey,
    'gsk-…mnop',
    'get devolve mascarado'
  )
  assert.equal(
    v.getVoiceSettings().stt.api.apiKey,
    'gsk-abcdefghijklmnop',
    'o main (sessão de transcrição) lê a chave real'
  )
  assert.deepEqual(
    v.setVoiceSetting('sttSettings', saved),
    saved,
    'set com os valores do get = no-op'
  )
})

test('sttSettings: escrever por cima do valor mascarado preserva a chave real', async () => {
  const v = await voice()
  v.setVoiceSetting('sttSettings', { api: { apiKey: 'gsk-SECRETKEY123456', model: 'm1' } })
  // a UI ecoa o grupo com a MÁSCARA no lugar da chave (formulário) e mexe em outra coisa
  const view = v.getVoiceSettingsView().sttSettings
  assert.equal(view.api.apiKey, 'gsk-…3456')
  const saved = v.setVoiceSetting('sttSettings', { ...view, api: { ...view.api, model: 'm2' } })
  assert.equal(saved.api.model, 'm2')
  assert.equal(await realSttKey(), 'gsk-SECRETKEY123456', 'a chave real não foi apagada')
  // escrever a própria chave real também preserva (sem efeito)
  const saved2 = v.setVoiceSetting('sttSettings', {
    api: { apiKey: 'gsk-SECRETKEY123456', model: 'm3' }
  })
  assert.equal(saved2.api.model, 'm3')
  assert.equal(await realSttKey(), 'gsk-SECRETKEY123456')
})

test("sttSettings: '' e null removem a chave; ausente/lixo preservam; string nova substitui", async () => {
  const v = await voice()
  const KEY = 'gsk-KEEPME9876543210'
  // campo ausente → preserva
  v.setVoiceSetting('sttSettings', { api: { apiKey: KEY } })
  v.setVoiceSetting('sttSettings', { api: { model: 'x' } })
  assert.equal(await realSttKey(), KEY, 'apiKey ausente preserva a chave')
  // lixo (não-string) → preserva
  v.setVoiceSetting('sttSettings', { api: { apiKey: 123 } })
  assert.equal(await realSttKey(), KEY, 'apiKey lixo não apaga a chave')
  // grupo inteiro lixo → vai aos padrões, mas a chave sobrevive
  v.setVoiceSetting('sttSettings', 'garbage')
  assert.equal(await realSttKey(), KEY, 'grupo lixo não apaga a chave')
  // string nova (aparada) → substitui
  const saved = v.setVoiceSetting('sttSettings', { api: { apiKey: '  gsk-newkey-0000001111  ' } })
  assert.equal(await realSttKey(), 'gsk-newkey-0000001111')
  assert.equal(saved.api.apiKey, 'gsk-…1111')
  // '' e null removem (ação explícita de limpar, como em webSearch.setKey)
  v.setVoiceSetting('sttSettings', { api: { apiKey: '' } })
  assert.equal(await realSttKey(), '')
  v.setVoiceSetting('sttSettings', { api: { apiKey: KEY } })
  v.setVoiceSetting('sttSettings', { api: { apiKey: null } })
  assert.equal(await realSttKey(), '')
  assert.equal(v.getVoiceSettingsView().sttSettings.api.apiKey, '', 'sem chave → máscara vazia')
})

test('ttsSettings: mesma proteção da apiKey (máscara + preservação) e local: null preservado', async () => {
  const v = await voice()
  const saved = v.setVoiceSetting('ttsSettings', {
    backend: 'api',
    api: { apiKey: 'tvly-abcdefghijkl', model: 't1' }
  })
  assert.equal(saved.api.apiKey, 'tvly-…ijkl')
  assert.equal(await realTtsKey(), 'tvly-abcdefghijkl')
  const view = v.getVoiceSettingsView().ttsSettings
  const saved2 = v.setVoiceSetting('ttsSettings', {
    ...view,
    api: { ...view.api, model: 't2' },
    local: null
  })
  assert.equal(saved2.api.model, 't2')
  assert.equal(saved2.local, null, 'local: null = limpeza explícita preservada')
  assert.equal(await realTtsKey(), 'tvly-abcdefghijkl', 'escrita por cima da máscara preserva')
  // sem apiKey no form → preserva; vazio → remove
  v.setVoiceSetting('ttsSettings', { api: {} })
  assert.equal(await realTtsKey(), 'tvly-abcdefghijkl')
  v.setVoiceSetting('ttsSettings', { api: { apiKey: '' } })
  assert.equal(await realTtsKey(), '')
  assert.deepEqual(v.setVoiceSetting('ttsSettings', 42), DEFAULT_TTS_SETTINGS, 'lixo → padrões')
})

test('setVoiceSetting: grupo desconhecido é erro legível', async () => {
  const v = await voice()
  assert.throws(() => v.setVoiceSetting('nope' as never, {}), /desconhecido/)
})
