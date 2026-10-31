#!/usr/bin/env node
// Protocolo de sync: a fonte é docs/ deste repositório (pai). Os repos que o consomem guardam cópias
// byte a byte (precisam delas soltos: testes, build do servidor).
//   node scripts/protocol.mjs sync   → copia docs/ para os repos filhos
//   node scripts/protocol.mjs check  → falha se alguma cópia divergir (ou faltar)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = [
  'SYNC_PROTOCOL.md',
  ...readdirSync(join(root, 'docs/test-vectors'))
    .filter((f) => f.endsWith('.json') || f === 'generate.ts')
    .map((f) => `test-vectors/${f}`)
]
// O mobile vendora o protocolo por conta própria (npm run vendor:check, em src/vendor/protocol).
const TARGETS = ['ClearChatDesktop/docs', 'ClearChatWebsite/docs']

const mode = process.argv[2]
if (mode !== 'sync' && mode !== 'check') {
  console.error('uso: node scripts/protocol.mjs sync|check')
  process.exit(2)
}

let drift = 0
for (const target of TARGETS) {
  if (!existsSync(join(root, target))) {
    console.warn(`(pulando ${target}: repositório não clonado)`)
    continue
  }
  for (const f of FILES) {
    const src = join(root, 'docs', f)
    const dst = join(root, target, f)
    const same = existsSync(dst) && readFileSync(src).equals(readFileSync(dst))
    if (same) continue
    if (mode === 'sync') {
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(src, dst)
      console.log(`copiado  ${target}/${f}`)
    } else {
      drift++
      console.error(`diverge  ${target}/${f}`)
    }
  }
}
if (drift) {
  console.error(`\n${drift} arquivo(s) fora de sincronia — edite em docs/ e rode: node scripts/protocol.mjs sync`)
  process.exit(1)
}
if (mode === 'check') console.log('protocolo idêntico em todos os repositórios')
