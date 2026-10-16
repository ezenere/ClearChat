// Hora/data das mensagens (lib/dates.ts): dia local, "Hoje"/"Ontem", ano, fuso, agrupamento.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calendarDayDiff,
  dayKey,
  dayLabel,
  dayStarts,
  formatFullDateTime,
  formatTime,
  msUntilNextDay
} from '../src/renderer/src/lib/dates.ts'

/** Roda `fn` com outro fuso (process.env.TZ é relido pelo V8 a cada mudança). */
function withTZ(tz: string, fn: () => void): void {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

const local = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0): number =>
  new Date(y, mo - 1, d, h, mi, s).getTime()

test('formatTime / formatFullDateTime: 24 h, zeros à esquerda', () => {
  withTZ('America/Sao_Paulo', () => {
    assert.equal(formatTime(local(2026, 10, 16, 14, 28, 5)), '14:28')
    assert.equal(formatTime(local(2026, 1, 1, 0, 5)), '00:05')
    assert.equal(formatTime(local(2026, 1, 1, 23, 59)), '23:59')
    assert.equal(formatFullDateTime(local(2026, 10, 16, 14, 28, 5)), '16/10/2026 14:28:05')
    assert.equal(formatFullDateTime(local(2026, 3, 4, 7, 8, 9)), '04/03/2026 07:08:09')
  })
})

test('fuso: o mesmo instante cai em dias/horas diferentes', () => {
  const ts = Date.UTC(2026, 9, 16, 1, 30) // 16/10 01:30 UTC
  withTZ('UTC', () => {
    assert.equal(dayKey(ts), '2026-10-16')
    assert.equal(formatTime(ts), '01:30')
  })
  withTZ('America/Sao_Paulo', () => {
    assert.equal(dayKey(ts), '2026-10-15')
    assert.equal(formatTime(ts), '22:30')
  })
  withTZ('Asia/Tokyo', () => {
    assert.equal(dayKey(ts), '2026-10-16')
    assert.equal(formatTime(ts), '10:30')
  })
})

test('dayLabel: Hoje / Ontem / dia da semana / ano', () => {
  withTZ('America/Sao_Paulo', () => {
    const now = local(2026, 10, 16, 9, 0)
    assert.equal(dayLabel(local(2026, 10, 16, 0, 0, 1), now), 'Hoje')
    assert.equal(dayLabel(local(2026, 10, 16, 23, 59), now), 'Hoje')
    assert.equal(dayLabel(local(2026, 10, 15, 23, 59), now), 'Ontem')
    assert.equal(dayLabel(local(2026, 10, 15, 0, 0), now), 'Ontem')
    assert.equal(dayLabel(local(2026, 10, 14, 14, 0), now), 'qua., 14 de out.')
    assert.equal(dayLabel(local(2026, 1, 2), now), 'sex., 2 de jan.')
    assert.equal(dayLabel(local(2025, 12, 31), now), 'qua., 31 de dez. de 2025')
    // virada de ano: 31/12 é "Ontem" em 1º/1, sem ano
    assert.equal(dayLabel(local(2025, 12, 31, 22), local(2026, 1, 1, 8)), 'Ontem')
    // meia-noite: o que era "Hoje" vira "Ontem"
    const msg = local(2026, 10, 16, 23, 50)
    assert.equal(dayLabel(msg, local(2026, 10, 16, 23, 59, 59)), 'Hoje')
    assert.equal(dayLabel(msg, local(2026, 10, 17, 0, 0, 1)), 'Ontem')
  })
})

test('calendarDayDiff: dias de calendário, inclusive com horário de verão', () => {
  withTZ('America/New_York', () => {
    // DST termina em 01/11/2026 (dia de 25 h)
    assert.equal(calendarDayDiff(local(2026, 10, 31, 23, 30), local(2026, 11, 1, 23, 30)), 1)
    assert.equal(calendarDayDiff(local(2026, 11, 1, 0, 30), local(2026, 11, 2, 0, 10)), 1)
    // DST começa em 08/03/2026 (dia de 23 h)
    assert.equal(calendarDayDiff(local(2026, 3, 7, 0, 30), local(2026, 3, 8, 23, 30)), 1)
    assert.equal(calendarDayDiff(local(2026, 3, 8, 0, 30), local(2026, 3, 8, 23, 30)), 0)
  })
  assert.equal(calendarDayDiff(local(2026, 10, 1), local(2026, 10, 16)), 15)
})

test('dayStarts: primeiro item de cada dia (fuso local)', () => {
  withTZ('America/Sao_Paulo', () => {
    const items = [
      { id: 'a', createdAt: local(2026, 10, 14, 9) },
      { id: 'b', createdAt: local(2026, 10, 14, 23, 59) },
      { id: 'c', createdAt: local(2026, 10, 15, 0, 0) },
      { id: 'd', createdAt: local(2026, 10, 15, 8) },
      { id: 'e', createdAt: local(2026, 10, 16, 10) }
    ]
    assert.deepEqual([...dayStarts(items)], ['a', 'c', 'e'])
    assert.deepEqual([...dayStarts([])], [])
    assert.deepEqual([...dayStarts(items.slice(1, 2))], ['b'])
  })
  // mesmo instante, fuso diferente → agrupamento diferente
  const items = [
    { id: 'x', createdAt: Date.UTC(2026, 9, 15, 23, 0) },
    { id: 'y', createdAt: Date.UTC(2026, 9, 16, 1, 0) }
  ]
  withTZ('UTC', () => assert.deepEqual([...dayStarts(items)], ['x', 'y']))
  withTZ('America/Sao_Paulo', () => assert.deepEqual([...dayStarts(items)], ['x']))
})

test('msUntilNextDay: até logo depois da meia-noite local', () => {
  withTZ('America/Sao_Paulo', () => {
    const ms = msUntilNextDay(local(2026, 10, 16, 23, 59, 0))
    assert.equal(ms, 61_000)
    assert.ok(msUntilNextDay(local(2026, 10, 16, 0, 0, 0)) > 23 * 3_600_000)
  })
})
