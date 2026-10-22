// Catálogo de componentes locais de áudio (SPEC → "Áudio → Componentes locais (download)"): os
// modelos de STT/TTS que o app pode baixar e instalar em `<userData>/models/`. Só dados + helpers
// puros, sem Electron (o gerenciador de download/manifest vive em `models.ts`; a inferência é outra
// fatia). Cada entrada traz a URL-fonte e a origem dos números; tudo consultado em 2026-10-22.
//
// Fontes (2026-10-22):
// - whisper.cpp: URL-base `https://huggingface.co/ggerganov/whisper.cpp` — é a fonte que o script
//   oficial `models/download-ggml-model.sh` do whisper.cpp usa (`src="https://huggingface.co/ggerganov/whisper.cpp"`,
//   `pfx="resolve/main/ggml"` → `…/resolve/main/ggml-<modelo>.bin`). O `models/README.md` aponta
//   para `https://huggingface.co/ggml-org/whisper.cpp`, mas esse repositório responde 401/404 no
//   lugar do conteúdo (o vivo é o `ggerganov`). ATENÇÃO: os artefatos são `.bin` em formato **ggml**
//   (magic 0x67676d6c = "ggml" little-endian), NÃO `.gguf` — os nomes reais conferidos na árvore do
//   repositório são `ggml-tiny.bin`, `ggml-base.bin`, `ggml-small.bin` e `ggml-large-v3-turbo.bin`.
//   Tamanhos exatos e sha256 = campo `lfs.oid` de
//   `https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main` (confere com o header
//   `x-linked-etag` do download — ambos o sha256 do conteúdo). Existe também a linha quantizada
//   (`-q5_1`/`-q8_0`) e a `.en` no mesmo repositório; não entram por enquanto.
// - Vosk: `https://alphacephei.com/vosk/models` (tabela "Portuguese/Brazilian Portuguese") —
//   `vosk-model-small-pt-0.3.zip`, Apache-2.0, 31M na tabela (Content-Length exato conferido no
//   HEAD: 32.453.112 bytes). A fonte **não publica sha256** → `sha256Oficial: null` e a verificação
//   cai na regra de tamanho exato + magic bytes (ver `expectedMagic`). O `vosk-model-pt-fb` é
//   **GPL-3.0** e fica de fora por licença.
// - Nemotron: `https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b` — o download é um
//   **GGUF único** Q8_0 (`nemotron-3.5-asr-streaming-0.6b.q8_0.gguf`, 742.090.464 bytes), então
//   entra; sha256 = `lfs.oid` da API do HF. O checkpoint `.nemo` (2,37 GB) e os demais arquivos do
//   repositório não são suportados (o runtime carrega um GGUF por modelo). Licença OpenMDW-1.1.
// - Kokoro/Chatterbox (TTS): placeholders **sem download** até a fatia de TTS preencher URL,
//   tamanho, hash e idiomas (`url: null`). Licenças dos MOTORES conferidas nas fontes
//   (hexgrad/Kokoro-82M: Apache-2.0; resemble-ai/chatterbox: MIT) — o artefato concreto ainda será
//   escolhido na fatia de TTS.
import type { SttLocalEngine, TtsLocalEngine } from '@shared/voice'

export type LocalModelKind = 'stt' | 'tts'
export type LocalModelEngine = SttLocalEngine | TtsLocalEngine

export interface LocalModelCatalogEntry {
  /** Id estável da entrada (usado no manifest e na API). */
  id: string
  kind: LocalModelKind
  engine: LocalModelEngine
  /** Nome de exibição. */
  name: string
  description: string
  /** Idiomas cobertos; `'mul'` = multilingue. */
  languages: string[]
  /** Versão do artefato no catálogo (copiada para o manifest na instalação). */
  version: string
  /** Tamanho EXATO em bytes publicado pelo host (usado na verificação por tamanho). */
  sizeBytes: number
  /**
   * sha256 oficial publicado para o artefato (HF = `lfs.oid`; confere com `x-linked-etag`).
   * `null` = a fonte não publica hash (ex.: Vosk) → a verificação usa tamanho exato + magic bytes.
   */
  sha256Oficial: string | null
  /** URL https do download; `null` = placeholder sem download (preenchido na fatia de TTS). */
  url: string | null
  license: string
  notes?: string
}

/** URL-base dos modelos ggml do whisper.cpp (fonte usada pelo script oficial). */
const WHISPER_HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
/** URL-base dos artefatos publicados no HF para o Nemotron 3.5 ASR Streaming. */
const NEMOTRON_HF_BASE =
  'https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/main'

export const LOCAL_MODEL_CATALOG: readonly LocalModelCatalogEntry[] = [
  // ---------------- STT: whisper.cpp (ggml .bin) ----------------
  {
    id: 'ggml-tiny',
    kind: 'stt',
    engine: 'whisper.cpp',
    name: 'Whisper tiny (ggml)',
    description:
      'Whisper tiny convertido para ggml (whisper.cpp) — o menor e mais rápido, para máquinas fracas.',
    languages: ['mul'],
    version: '1',
    sizeBytes: 77_691_713,
    sha256Oficial: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    url: `${WHISPER_HF_BASE}/ggml-tiny.bin`,
    license: 'MIT',
    notes: 'Fonte: HF ggerganov/whisper.cpp (tamanho/sha256 = API tree do HF, 2026-10-22).'
  },
  {
    id: 'ggml-base',
    kind: 'stt',
    engine: 'whisper.cpp',
    name: 'Whisper base (ggml)',
    description:
      'Whisper base convertido para ggml (whisper.cpp) — bom equilíbrio entre velocidade e precisão.',
    languages: ['mul'],
    version: '1',
    sizeBytes: 147_951_465,
    sha256Oficial: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    url: `${WHISPER_HF_BASE}/ggml-base.bin`,
    license: 'MIT',
    notes: 'Fonte: HF ggerganov/whisper.cpp (tamanho/sha256 = API tree do HF, 2026-10-22).'
  },
  {
    id: 'ggml-small',
    kind: 'stt',
    engine: 'whisper.cpp',
    name: 'Whisper small (ggml)',
    description: 'Whisper small convertido para ggml (whisper.cpp) — mais preciso, mais lento.',
    languages: ['mul'],
    version: '1',
    sizeBytes: 487_601_967,
    sha256Oficial: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    url: `${WHISPER_HF_BASE}/ggml-small.bin`,
    license: 'MIT',
    notes: 'Fonte: HF ggerganov/whisper.cpp (tamanho/sha256 = API tree do HF, 2026-10-22).'
  },
  {
    id: 'ggml-large-v3-turbo',
    kind: 'stt',
    engine: 'whisper.cpp',
    name: 'Whisper large-v3-turbo (ggml)',
    description:
      'Whisper large-v3-turbo convertido para ggml (whisper.cpp) — o mais preciso; pesado para CPU fraca.',
    languages: ['mul'],
    version: '1',
    sizeBytes: 1_624_555_275,
    sha256Oficial: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    url: `${WHISPER_HF_BASE}/ggml-large-v3-turbo.bin`,
    license: 'MIT',
    notes: 'Fonte: HF ggerganov/whisper.cpp (tamanho/sha256 = API tree do HF, 2026-10-22).'
  },
  // ---------------- STT: Vosk ----------------
  {
    id: 'vosk-model-small-pt-0.3',
    kind: 'stt',
    engine: 'vosk',
    name: 'Vosk small pt-BR 0.3',
    description:
      'Vosk small pt-BR (Kaldi) — modelo leve em português do Brasil; artefato é um .zip (a extração é da fatia de runtime).',
    languages: ['pt-BR'],
    version: '0.3',
    sizeBytes: 32_453_112,
    // a fonte (alphacephei) não publica sha256 — verificação por tamanho exato + magic bytes (PK)
    sha256Oficial: null,
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip',
    license: 'Apache-2.0',
    notes:
      'Sem sha256 publicado (confere com a página de modelos, 2026-10-22): verificação por tamanho exato (Content-Length 32.453.112) + magic bytes. O vosk-model-pt-fb (GPL-3.0) fica de fora por licença.'
  },
  // ---------------- STT: Nemotron ----------------
  {
    id: 'nemotron-3.5-asr-streaming-0.6b',
    kind: 'stt',
    engine: 'nemotron',
    name: 'Nemotron 3.5 ASR Streaming 0.6B (GGUF Q8_0)',
    description:
      'NVIDIA Nemotron 3.5 ASR Streaming 0.6B — streaming multilíngue (40 language-locales), GGUF Q8_0 único.',
    languages: ['mul'],
    version: '0.6b',
    sizeBytes: 742_090_464,
    sha256Oficial: '3fc991d3badad7277c11030a7519832cddaf2057aafed6d4b25147e953a070b1',
    url: `${NEMOTRON_HF_BASE}/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf`,
    license: 'OpenMDW-1.1',
    notes:
      'Download = um .gguf único (o checkpoint .nemo de 2,37 GB e os demais arquivos do repositório não são suportados). Tamanho/sha256 = API tree do HF, 2026-10-22.'
  },
  // ---------------- TTS: placeholders (fatia de TTS preenche) ----------------
  {
    id: 'kokoro',
    kind: 'tts',
    engine: 'kokoro',
    name: 'Kokoro',
    description:
      'Kokoro-82M (TTS) — motor local padrão do app; artefato/voz concretos a definir na fatia de TTS.',
    languages: [],
    version: '1',
    sizeBytes: 0,
    sha256Oficial: null,
    url: null,
    license: 'Apache-2.0',
    notes:
      'Preenchido na fatia de TTS (URL, tamanho, sha256, idiomas e voice pack). Licença do motor conferida em hexgrad/Kokoro-82M.'
  },
  {
    id: 'chatterbox',
    kind: 'tts',
    engine: 'chatterbox',
    name: 'Chatterbox',
    description:
      'Resemble AI Chatterbox (TTS com clonagem de voz) — artefato concreto a definir na fatia de TTS.',
    languages: [],
    version: '1',
    sizeBytes: 0,
    sha256Oficial: null,
    url: null,
    license: 'MIT',
    notes:
      'Preenchido na fatia de TTS (URL, tamanho, sha256, idiomas). Licença do motor conferida em resemble-ai/chatterbox.'
  }
]

/** Acha a entrada do catálogo por id (null quando não existe). */
export function findCatalogEntry(
  id: string,
  catalog: readonly LocalModelCatalogEntry[] = LOCAL_MODEL_CATALOG
): LocalModelCatalogEntry | null {
  return catalog.find((e) => e.id === id) ?? null
}

/**
 * Nome do arquivo instalado: o basename da URL do download (`ggml-tiny.bin`, `vosk-model-small-pt-0.3.zip`,
 * …). Entrada sem URL (placeholder de TTS) → null.
 */
export function catalogFileName(entry: LocalModelCatalogEntry): string | null {
  if (!entry.url) return null
  try {
    return basename(new URL(entry.url).pathname)
  } catch {
    return basename(entry.url)
  }
}

// basename local (sem depender de node:path neste módulo de dados puros)
function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

/**
 * Magic bytes esperados no início do arquivo, pela extensão da URL — regra de verificação usada
 * quando não há sha256 oficial (e como checagem barata sempre):
 * `.bin` → ggml (whisper.cpp: `6c 6d 67 67` = 0x67676d6c little-endian); `.gguf` → `GGUF`;
 * `.zip` → `PK\x03\x04`. Extensão desconhecida → null (sem checagem de magic).
 */
export function expectedMagic(entry: LocalModelCatalogEntry): Uint8Array | null {
  const name = catalogFileName(entry)?.toLowerCase() ?? ''
  if (name.endsWith('.bin')) return new Uint8Array([0x6c, 0x6d, 0x67, 0x67])
  if (name.endsWith('.gguf')) return new Uint8Array([0x47, 0x47, 0x55, 0x46])
  if (name.endsWith('.zip')) return new Uint8Array([0x50, 0x4b, 0x03, 0x04])
  return null
}
