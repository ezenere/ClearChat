// Vozes do catálogo do provedor (TTS por API) em grupos para o `VoicePicker`: recomendadas para
// pt-BR, Português (Brasil), Português, Multilíngue e Outros idiomas — mantendo a ordem pt-first de
// `orderVoicesForPt`. Separado das peças (componentes) por causa do fast refresh.
import type { VoiceCatalogVoice } from '@shared/voiceCatalog'
import { VoiceBadges, type VoicePickerGroup } from './voiceSettingsParts'

/** Vozes do catálogo em grupos por idioma (a ordem pt-first de `orderVoicesForPt` é mantida). */
export function groupCatalogVoices(voices: VoiceCatalogVoice[]): VoicePickerGroup[] {
  const groups: { key: string; title: string; test: (v: VoiceCatalogVoice) => boolean }[] = [
    { key: 'recommended', title: 'Recomendadas para pt-BR', test: (v) => !!v.recommended },
    {
      key: 'pt-br',
      title: 'Português (Brasil)',
      test: (v) => /^pt[-_ ]?br$|brasil/i.test(v.language ?? '') || /brasil/i.test(v.accent ?? '')
    },
    {
      key: 'pt',
      title: 'Português',
      test: (v) => /^pt|portugu/i.test(v.language ?? '')
    },
    { key: 'mul', title: 'Multilíngue', test: (v) => /multi/i.test(v.language ?? '') },
    { key: 'other', title: 'Outros idiomas', test: () => true }
  ]
  const out: VoicePickerGroup[] = groups.map((g) => ({ key: g.key, title: g.title, voices: [] }))
  for (const v of voices) {
    const i = groups.findIndex((g) => g.test(v))
    out[i].voices.push({
      id: v.id,
      label: v.label,
      badges: <VoiceBadges v={{ ...v, recommended: false }} />,
      meta: v.id !== v.label.toLowerCase() ? v.id : undefined
    })
  }
  return out.filter((g) => g.voices.length)
}
