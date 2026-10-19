// Cripto do sync (src/main/sync/crypto.ts) contra os vetores do contrato (docs/test-vectors/*.json),
// byte a byte. Ver docs/SYNC_PROTOCOL.md §3.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  aadCommand,
  aadCommandResult,
  aadRecord,
  aadStream,
  aadWrap,
  b64u,
  blobIdFromSha256,
  checkKdfParams,
  decryptBlob,
  deriveSubkeys,
  encryptBlob,
  formatRecoveryKey,
  frameJson,
  fromB64u,
  fromHex,
  hex,
  hkdf,
  keyProof,
  open,
  openJson,
  parseRecoveryKey,
  passwordKek,
  recoveryKek,
  seal,
  sealJson,
  sha256,
  skillRecordId,
  unframeJson,
  unwrapDek,
  utf8,
  wrapDek,
  type KdfParams
} from '../src/main/sync/crypto'

const DIR = resolve(import.meta.dirname, '..', 'docs', 'test-vectors')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vec = (name: string): any => JSON.parse(readFileSync(join(DIR, name), 'utf8'))

test('kdf: Argon2id com parâmetros de produção e de teste (NFC = NFD)', async () => {
  const v = vec('kdf.json')
  for (const c of v.cases) {
    const fast = c.kdf.m < 19456
    const kek = await passwordKek(c.password, fromB64u(c.salt), c.kdf as KdfParams, fast)
    assert.equal(hex(kek), c.kek_hex, c.name)
    if (c.password_nfd_utf8_hex) {
      const nfd = Buffer.from(c.password_nfd_utf8_hex, 'hex').toString('utf8')
      const kek2 = await passwordKek(nfd, fromB64u(c.salt), c.kdf as KdfParams, fast)
      assert.equal(hex(kek2), c.kek_hex, 'NFD')
    }
  }
  // parâmetros rápidos nunca aceitos do servidor
  assert.throws(() => checkKdfParams(v.cases[1].kdf))
  assert.throws(() => checkKdfParams({ ...v.cases[0].kdf, m: 1048577 }))
  assert.throws(() => checkKdfParams({ ...v.cases[0].kdf, alg: 'argon2i' }))
  checkKdfParams(v.cases[0].kdf)
})

test('recovery: formato, leitura tolerante, checksum e KEK', () => {
  const v = vec('recovery.json')
  const entropy = fromHex(v.entropy_hex)
  assert.equal(formatRecoveryKey(entropy), v.formatted)
  for (const s of v.parse_accepts) assert.equal(hex(parseRecoveryKey(s)), v.entropy_hex)
  for (const s of v.parse_rejects) assert.throws(() => parseRecoveryKey(s))
  assert.equal(hex(recoveryKek(entropy, fromB64u(v.salt))), v.kek_hex)
})

test('keys: subchaves, key_proof/verifier e wraps com AAD', () => {
  const v = vec('keys.json')
  const sk = deriveSubkeys(fromHex(v.dek_hex))
  assert.equal(hex(sk.record), v.subkeys['clearchat/v1/record'])
  assert.equal(hex(sk.blob), v.subkeys['clearchat/v1/blob'])
  assert.equal(hex(sk.blobId), v.subkeys['clearchat/v1/blob-id'])
  assert.equal(hex(sk.stream), v.subkeys['clearchat/v1/stream'])
  assert.equal(hex(sk.recordId), v.subkeys['clearchat/v1/record-id'])
  assert.equal(hex(sk.keyVerify), v.subkeys['clearchat/v1/key-verify'])
  const p = keyProof(sk)
  assert.equal(p.key_proof, v.key_proof)
  assert.equal(p.verifier, v.verifier)
  for (const w of v.wraps) {
    const aad = aadWrap(v.user_id, w.slot)
    assert.equal(Buffer.from(aad).toString('utf8'), w.aad_utf8)
    const out = wrapDek(fromHex(w.kek_hex), fromHex(v.dek_hex), aad, fromHex(w.nonce_hex))
    assert.deepEqual(out, w.wrap)
    assert.equal(hex(unwrapDek(fromHex(w.kek_hex), w.wrap, aad)), v.dek_hex)
    // senha errada = falha GCM
    assert.throws(() => unwrapDek(new Uint8Array(32), w.wrap, aad))
  }
})

test('records: envelopes cru e deflate, casos que devem falhar', () => {
  const v = vec('records.json')
  const key = fromHex(v.record_key_hex)
  for (const c of v.cases) {
    const aad = aadRecord(v.user_id, c.type, c.id, c.scope, c.rev)
    assert.equal(Buffer.from(aad).toString('utf8'), c.aad_utf8)
    // decifragem: open == frame, unframe == json
    const frame = open(key, aad, c.envelope)
    assert.equal(hex(frame), c.frame_hex)
    assert.equal(JSON.stringify(unframeJson(frame)), c.json)
    assert.equal(fromB64u(c.envelope.c).length, c.ciphertext_size)
    // cifragem com a moldura do vetor (deflate de outra lib pode diferir) → envelope idêntico
    assert.deepEqual(seal(key, aad, fromHex(c.frame_hex), fromHex(c.nonce_hex)), c.envelope)
    // a nossa moldura também abre igual
    if (!c.name.includes('deflate'))
      assert.equal(hex(frameJson(c.json, false)), c.frame_hex, 'moldura crua')
  }
  for (const f of v.must_fail) assert.throws(() => open(key, utf8(f.aad_utf8), f.envelope), f.name)
  // sealJson/openJson round-trip (com compressão acima de 1 KiB)
  const big = { sv: 1, text: 'x'.repeat(3000) }
  const env = sealJson(key, utf8('a'), big)
  assert.deepEqual(openJson(key, utf8('a'), env), big)
  assert.equal(open(key, utf8('a'), env)[0], 1, 'comprimido')
})

test('blobs: CCB1 em chunks (cifragem e decifragem exatas) e blob_id', () => {
  const v = vec('blobs.json')
  const sk = deriveSubkeys(fromHex(vec('keys.json').dek_hex))
  assert.equal(hex(sk.blob), v.blob_key_hex)
  assert.equal(hex(sk.blobId), v.blob_id_key_hex)
  for (const c of v.cases) {
    const pt = new Uint8Array(c.plaintext_len)
    for (let i = 0; i < pt.length; i++) pt[i] = (i * 7 + 3) % 256
    assert.equal(hex(sha256(pt)), c.plaintext_sha256_hex)
    const id = blobIdFromSha256(sk, sha256(pt))
    assert.equal(id, c.blob_id)
    assert.equal(hex(hkdf(sk.blob, fromHex(c.salt_hex), 'clearchat/v1/blob-file')), c.file_key_hex)
    const ct = encryptBlob(sk, v.user_id, id, pt, fromHex(c.salt_hex), c.chunk_log2)
    assert.equal(ct.length, c.ciphertext_len)
    assert.equal(hex(ct), c.ciphertext_hex)
    assert.equal(hex(sha256(ct)), c.ciphertext_sha256_hex)
    assert.equal(hex(decryptBlob(sk, v.user_id, id, fromHex(c.ciphertext_hex))), hex(pt))
    // truncar o último chunk → falha (flag final no nonce)
    if (ct.length > 21 + 16 + 1024)
      assert.throws(() => decryptBlob(sk, v.user_id, id, ct.subarray(0, ct.length - 10)))
    // outro blob_id na AAD → falha
    assert.throws(() => decryptBlob(sk, v.user_id, '0'.repeat(64), ct))
  }
})

test('realtime: envelopes de stream, comando e resultado', () => {
  const v = vec('realtime.json')
  const key = fromHex(v.stream_key_hex)
  const chatId = '3d6f0a52-7c1e-4b8a-9f2d-0e4c5b6a7d8e'
  const aads: Record<string, Uint8Array> = {
    stream: aadStream(v.user_id, chatId, 42, 17),
    command: aadCommand(v.user_id, chatId, 'cmd-7f3a'),
    'command-result': aadCommandResult(v.user_id, chatId, 'cmd-7f3a')
  }
  for (const c of v.cases) {
    const aad = aads[c.name]
    assert.equal(Buffer.from(aad).toString('utf8'), c.aad_utf8)
    assert.deepEqual(seal(key, aad, fromHex(c.frame_hex), fromHex(c.nonce_hex)), c.envelope)
    assert.equal(JSON.stringify(openJson(key, aad, c.envelope)), c.json)
  }
})

test('ids: skill e blob', () => {
  const v = vec('ids.json')
  const sk = deriveSubkeys(fromHex(vec('keys.json').dek_hex))
  assert.equal(hex(sk.recordId), v.record_id_key_hex)
  for (const s of v.skills) assert.equal(skillRecordId(sk, s.name), s.record_id)
  for (const b of v.blobs) {
    assert.equal(hex(sha256(utf8(b.plaintext_utf8))), b.plaintext_sha256_hex)
    assert.equal(blobIdFromSha256(sk, fromHex(b.plaintext_sha256_hex)), b.blob_id)
  }
  assert.equal(b64u(new Uint8Array([251, 255])), '-_8')
})
