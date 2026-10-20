/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
// Fonte REMOTA de arquivos do renderer (src/renderer/src/lib/remoteFiles.ts) com um "main" falso:
// download em pedaços (progresso, pedaços em voo, montagem, resposta curta), cancelamento, cache
// (conferência de tamanho/mtime, LRU), só o necessário para a prévia + completar no "Salvar como…",
// motivos de falha (host offline, negado, host antigo → "Arquivo no <host>"), present_file de outro
// dispositivo / deste dispositivo, aba Arquivos do host, CSP injetada no HTML; e os temporários do
// "Abrir no app" (src/main/viewerTemp.ts). Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRemoteSources,
  withViewerCsp,
  type RemoteFsSender
} from '../src/renderer/src/lib/remoteFiles'
import type { FileSource } from '../src/renderer/src/lib/fileResource'
import { VIEWER_LIMITS, VIEWER_REMOTE_HTML_CSP } from '../src/shared/fileViewer'
import { isExecutableName, safeFileName, type RemoteReadResult } from '../src/shared/remoteFs'
import type { PresentFilesRecord } from '../src/shared/types'
import { cleanViewerTemp, setViewerTempDir, writeViewerTemp } from '../src/main/viewerTemp'

const TMP = mkdtempSync(join(tmpdir(), 'cc-remotefiles-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const CHUNK = 64 * 1024
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function pseudo(n: number, header: number[] = []): Uint8Array {
  const b = new Uint8Array(n)
  let x = 12345
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    b[i] = x >>> 24
  }
  b.set(header)
  return b
}

/** Host falso: arquivos em memória, atraso por pedido, contagem de pedidos e em voo. */
function fakeHost(opts: { chunkCap?: number; delayMs?: number } = {}) {
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  const reads: { path: string; offset: number; length: number }[] = []
  const saved: { name: string; bytes: Uint8Array }[] = []
  const opened: { name: string; bytes: Uint8Array }[] = []
  let inFlight = 0
  let maxInFlight = 0
  let failWith: RemoteReadResult | null = null
  let onRead: ((offset: number) => void) | null = null
  const sender: RemoteFsSender = {
    async listDir(_chatId, path) {
      if (failWith && !failWith.ok) return failWith
      return {
        ok: true,
        dir: path || '/host/raiz',
        root: '/host/raiz',
        confine: true,
        truncated: false,
        entries: [
          { name: 'sub', kind: 'dir', mtime: 1 },
          { name: 'a.txt', kind: 'file', size: 3, mtime: 2 }
        ]
      }
    },
    async readChunk(_chatId, path, offset, length) {
      reads.push({ path, offset, length })
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await sleep(opts.delayMs ?? 2)
        onRead?.(offset)
        if (failWith) return failWith
        const f = files.get(path)
        if (!f) return { ok: false, reason: 'missing', message: 'Arquivo não encontrado.' }
        const len = Math.min(length, opts.chunkCap ?? Infinity)
        return {
          ok: true,
          size: f.bytes.length,
          mtime: f.mtime,
          offset,
          data: f.bytes.slice(offset, offset + len)
        }
      } finally {
        inFlight--
      }
    },
    async saveBytes(name, bytes) {
      saved.push({ name, bytes })
      return true
    },
    async openBytes(name, bytes) {
      opened.push({ name, bytes })
    }
  }
  return {
    sender,
    files,
    reads,
    saved,
    opened,
    get maxInFlight() {
      return maxInFlight
    },
    fail(r: RemoteReadResult | null) {
      failWith = r
    },
    onRead(fn: ((offset: number) => void) | null) {
      onRead = fn
    }
  }
}

const HOST = { deviceId: 'dev-host', name: 'PC do escritório' }
function sources(h: ReturnType<typeof fakeHost>, extra: Record<string, any> = {}) {
  const records = new Map<string, PresentFilesRecord>()
  const r = createRemoteSources(
    h.sender,
    {
      presented: (_c, id) => records.get(id) ?? null,
      myDeviceId: () => 'dev-eu',
      host: () => HOST,
      ...extra
    },
    { chunkBytes: CHUNK, concurrency: 3, cacheFiles: 2, cacheBytes: 4 * 1024 * 1024 }
  )
  return { ...r, records, src: r.file('c1') }
}
const browse = (path: string) => ({ chatId: 'c1', source: 'browse' as const, path })

test('download em pedaços: progresso, até 3 em voo, bytes montados, imagem vira blob URL', async () => {
  const h = fakeHost({ delayMs: 5 })
  const png = pseudo(300_000, [0x89, 0x50, 0x4e, 0x47])
  h.files.set('/host/raiz/foto.png', { bytes: png, mtime: 10 })
  const { src } = sources(h)
  const progress: [number, number | undefined][] = []
  const r = await src.open(browse('/host/raiz/foto.png'), {
    onProgress: (l, t) => progress.push([l, t])
  })
  assert.ok(r.ok, JSON.stringify(r))
  if (!r.ok) return
  assert.equal(r.resource.info.kind, 'image')
  assert.equal(r.resource.info.mime, 'image/png')
  assert.equal(r.resource.info.size, png.length)
  assert.match(r.resource.url ?? '', /^blob:/)
  const blob = await (await fetch(r.resource.url!)).arrayBuffer().catch(() => null)
  if (blob) assert.deepEqual(new Uint8Array(blob), png)
  assert.equal(h.reads.length, Math.ceil(png.length / CHUNK))
  assert.ok(h.maxInFlight <= 3 && h.maxInFlight >= 2, `em voo: ${h.maxInFlight}`)
  // progresso cresce até o total
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] > progress[i - 1][0])
  assert.deepEqual(progress.at(-1), [png.length, png.length])
  // sem "Mostrar na pasta" para arquivo remoto
  assert.deepEqual(src.capabilities, { reveal: false, openNative: true, saveAs: true })
  assert.equal(r.resource.showInFolder, undefined)
  r.resource.dispose()
})

test('texto: só até o teto da prévia; Salvar como… completa (uma vez) e Abrir no app reaproveita', async () => {
  const h = fakeHost()
  const big = 'linha de log\n'.repeat(Math.ceil((VIEWER_LIMITS.textMaxBytes + 300_000) / 13))
  const bytes = new TextEncoder().encode(big)
  h.files.set('/host/raiz/app.log', { bytes, mtime: 1 })
  const { src } = sources(h)
  const r = await src.open(browse('/host/raiz/app.log'))
  assert.ok(r.ok)
  if (!r.ok) return
  const fetched = h.reads.reduce((n, x) => n + x.length, 0)
  assert.equal(fetched, VIEWER_LIMITS.textMaxBytes, 'só o que a prévia mostra')
  const t = await r.resource.readText()
  assert.equal(t.truncated, true)
  assert.equal(t.size, bytes.length)
  assert.ok(t.content.startsWith('linha de log\n'))
  const before = h.reads.length
  await r.resource.saveAs!()
  assert.equal(h.saved.length, 1)
  assert.equal(h.saved[0].name, 'app.log')
  assert.deepEqual(h.saved[0].bytes, bytes, 'arquivo inteiro')
  const afterSave = h.reads.length
  assert.ok(afterSave > before)
  await r.resource.openExternal!()
  assert.equal(h.reads.length, afterSave, 'já completo: nada de novo')
  assert.deepEqual(h.opened[0].bytes, bytes)
})

test('tipo sem prévia: só o começo; resposta curta (host com teto menor) volta para a fila', async () => {
  const h = fakeHost({ chunkCap: 40_000 })
  const zip = pseudo(250_000, [0x50, 0x4b, 0x03, 0x04])
  h.files.set('/host/raiz/dados.zip', { bytes: zip, mtime: 3 })
  const { src } = sources(h)
  const r = await src.open(browse('/host/raiz/dados.zip'))
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.resource.info.kind, 'binary')
  assert.equal(r.resource.url, null)
  assert.equal(h.reads.length, 1, 'só o primeiro pedido')
  await r.resource.saveAs!()
  assert.deepEqual(h.saved[0].bytes, zip, 'montado mesmo com respostas curtas')
})

test('cancelar: para de pedir pedaços e devolve "Cancelado."', async () => {
  const h = fakeHost({ delayMs: 15 })
  h.files.set('/host/raiz/doc.pdf', { bytes: pseudo(900_000, [0x25, 0x50, 0x44, 0x46]), mtime: 1 })
  const { src } = sources(h)
  const ctl = new AbortController()
  h.onRead((off) => {
    if (off >= CHUNK * 2) ctl.abort()
  })
  const r = await src.open(browse('/host/raiz/doc.pdf'), { signal: ctl.signal })
  assert.ok(!r.ok && r.message === 'Cancelado.')
  const n = h.reads.length
  assert.ok(n < Math.ceil(900_000 / CHUNK), `parou cedo (${n} pedidos)`)
  await sleep(80)
  assert.equal(h.reads.length, n, 'nada depois do cancelamento')
})

test('cache: reabrir confere tamanho/mtime (0 bytes); mudou → busca de novo; LRU por quantidade', async () => {
  const h = fakeHost()
  h.files.set('/host/raiz/a.md', { bytes: new TextEncoder().encode('# A'), mtime: 1 })
  h.files.set('/host/raiz/b.md', { bytes: new TextEncoder().encode('# B'), mtime: 1 })
  h.files.set('/host/raiz/c.md', { bytes: new TextEncoder().encode('# C'), mtime: 1 })
  const { src, cache } = sources(h)
  assert.ok((await src.open(browse('/host/raiz/a.md'))).ok)
  h.reads.length = 0
  const again = await src.open(browse('/host/raiz/a.md'))
  assert.ok(again.ok)
  assert.deepEqual(h.reads, [{ path: '/host/raiz/a.md', offset: 0, length: 0 }])
  if (again.ok) assert.equal((await again.resource.readText()).content, '# A')
  // mudou no host → cache descartado
  h.files.set('/host/raiz/a.md', { bytes: new TextEncoder().encode('# A2'), mtime: 2 })
  h.reads.length = 0
  const changed = await src.open(browse('/host/raiz/a.md'))
  assert.ok(changed.ok)
  assert.equal(h.reads.length, 2)
  if (changed.ok) assert.equal((await changed.resource.readText()).content, '# A2')
  // LRU (cacheFiles: 2)
  await src.open(browse('/host/raiz/b.md'))
  await src.open(browse('/host/raiz/c.md'))
  assert.deepEqual(cache.keys(), ['c1\n/host/raiz/b.md', 'c1\n/host/raiz/c.md'])
})

test('arquivo mudou no meio do download → erro claro', async () => {
  const h = fakeHost({ delayMs: 3 })
  const f = { bytes: pseudo(400_000, [0x89, 0x50, 0x4e, 0x47]), mtime: 1 }
  h.files.set('/host/raiz/x.png', f)
  const { src } = sources(h)
  h.onRead((off) => {
    if (off > 0) f.mtime = 99
  })
  const r = await src.open(browse('/host/raiz/x.png'))
  assert.ok(!r.ok && r.reason === 'error' && /mudou no host/.test(r.message))
})

test('falhas: host offline, negado, host antigo (→ "Arquivo no <host>"), grande demais', async () => {
  const h = fakeHost()
  const { src } = sources(h)
  h.fail({
    ok: false,
    reason: 'host-offline',
    message: 'O host (PC) está offline.',
    deviceName: 'PC'
  })
  let r = await src.open(browse('/host/raiz/a'))
  assert.deepEqual(r, {
    ok: false,
    reason: 'host-offline',
    message: 'O host (PC) está offline.',
    deviceName: 'PC'
  })
  h.fail({ ok: false, reason: 'denied', message: 'Acesso negado: fora da raiz.' })
  r = await src.open(browse('/etc/passwd'))
  assert.ok(!r.ok && r.reason === 'denied')
  h.fail({ ok: false, reason: 'unsupported', message: 'atualize o app nele', deviceName: 'PC' })
  r = await src.open(browse('/host/raiz/a'))
  assert.ok(!r.ok && r.reason === 'remote' && r.deviceName === 'PC')
  h.fail(null)
  const small = createRemoteSources(
    h.sender,
    { presented: () => null, myDeviceId: () => null, host: () => HOST },
    { chunkBytes: CHUNK, maxFileBytes: 100_000 }
  ).file('c1')
  h.files.set('/host/raiz/big.pdf', { bytes: pseudo(150_000, [0x25, 0x50, 0x44, 0x46]), mtime: 1 })
  r = await small.open(browse('/host/raiz/big.pdf'))
  assert.ok(!r.ok && /grande demais/.test(r.message))
})

test('present_file: arquivo de um terceiro dispositivo não é buscado; o deste vai para a fonte local', async () => {
  const h = fakeHost()
  const localCalls: string[] = []
  const local: FileSource = {
    id: 'local',
    capabilities: { reveal: true, openNative: true, saveAs: false },
    open: async (t) => {
      localCalls.push(JSON.stringify(t))
      return { ok: false, reason: 'missing', message: 'x' }
    },
    check: async () => []
  }
  const { src, records } = sources(h, { local })
  records.set('m-outro', {
    deviceId: 'dev-velho',
    deviceName: 'Notebook antigo',
    files: [{ path: '/x/a.md', name: 'a.md' }]
  })
  records.set('m-host', {
    deviceId: 'dev-host',
    files: [{ path: '/host/raiz/h.md', name: 'h.md' }]
  })
  records.set('m-eu', { deviceId: 'dev-eu', files: [{ path: '/meu/e.md', name: 'e.md' }] })
  h.files.set('/host/raiz/h.md', { bytes: new TextEncoder().encode('# H'), mtime: 1 })
  const target = (messageId: string) => ({
    chatId: 'c1',
    source: 'present' as const,
    messageId,
    index: 0
  })
  const o = await src.open(target('m-outro'))
  assert.ok(!o.ok && o.reason === 'remote' && o.deviceName === 'Notebook antigo')
  assert.equal(h.reads.length, 0)
  assert.deepEqual(await src.check('c1', 'm-outro'), [
    { ok: false, reason: 'remote', deviceName: 'Notebook antigo' }
  ])
  const hostFile = await src.open(target('m-host'))
  assert.ok(hostFile.ok)
  assert.deepEqual(await src.check('c1', 'm-host'), [{ ok: true }])
  await src.open(target('m-eu'))
  assert.equal(localCalls.length, 1)
  const inv = await src.open({ ...target('m-host'), index: 5 })
  assert.ok(!inv.ok && inv.reason === 'invalid')
})

test('aba Arquivos do host: entradas com caminho do host; falhas mapeadas', async () => {
  const h = fakeHost()
  const { dir } = sources(h)
  const d = dir('c1')
  assert.equal(d, dir('c1'), 'memoizada por chat')
  const r = await d.listDir('c1', '')
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.root, '/host/raiz')
  assert.equal(r.confine, true)
  assert.deepEqual(
    r.entries.map((e) => [e.path, e.isDir]),
    [
      ['/host/raiz/sub', true],
      ['/host/raiz/a.txt', false]
    ]
  )
  h.fail({ ok: false, reason: 'host-offline', message: 'offline' })
  const off = await d.listDir('c1', '/host/raiz')
  assert.ok(!off.ok && off.reason === 'host-offline')
})

test('HTML remoto: CSP do visualizador injetada depois do doctype (bytes preservados)', async () => {
  const html = new TextEncoder().encode('<!DOCTYPE html>\n<html><body>oi</body></html>')
  const out = new TextDecoder().decode(withViewerCsp(html))
  assert.ok(out.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"'))
  assert.ok(out.includes(VIEWER_REMOTE_HTML_CSP))
  assert.ok(out.endsWith('\n<html><body>oi</body></html>'))
  const bare = new TextDecoder().decode(withViewerCsp(new TextEncoder().encode('<p>x</p>')))
  assert.ok(bare.startsWith('<meta http-equiv'))
  // pelo recurso: a blob URL leva a CSP; o texto/"Salvar como…" ficam com os bytes originais
  const h = fakeHost()
  h.files.set('/host/raiz/p.html', { bytes: html, mtime: 1 })
  const { src } = sources(h)
  const r = await src.open(browse('/host/raiz/p.html'))
  assert.ok(r.ok && r.resource.info.kind === 'html')
  if (!r.ok) return
  const served = await (await fetch(r.resource.url!)).text().catch(() => null)
  if (served != null) assert.ok(served.includes('Content-Security-Policy'))
  await r.resource.saveAs!()
  assert.deepEqual(h.saved[0].bytes, html)
})

test('temporários do "Abrir no app": pasta própria, 0600, recusa executáveis, teto, limpeza', () => {
  const dir = join(TMP, 'tmp-viewer')
  setViewerTempDir(dir)
  const p = writeViewerTemp('../../relatório.pdf', new Uint8Array([1, 2, 3]))
  assert.ok(p.startsWith(dir + '/'))
  assert.ok(p.endsWith('/relatório.pdf'))
  assert.deepEqual([...readFileSync(p)], [1, 2, 3])
  if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600)
  assert.throws(() => writeViewerTemp('instalar.exe', new Uint8Array(1)), /Salvar como/)
  assert.throws(() => writeViewerTemp('script.sh', new Uint8Array(1)), /executáveis/)
  assert.throws(() => writeViewerTemp('a.txt', 'não é Uint8Array' as any), /inválido/)
  assert.ok(isExecutableName('App.DESKTOP') && !isExecutableName('notas.md'))
  assert.equal(safeFileName('a/b\\c:d?.txt'), 'c_d_.txt')
  assert.equal(safeFileName('..'), 'arquivo')
  cleanViewerTemp()
  assert.equal(existsSync(dir), false)
})
