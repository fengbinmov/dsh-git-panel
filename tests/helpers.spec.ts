/**
 * Tests for the presentation helpers shared by the change list and the review.
 *
 * The byte formatter is what a file with no text to diff reports instead, so it
 * has to stay readable across the whole range: a 3-byte stub and a 400 MB asset
 * both land in the same note.
 */
import { describe, expect, it } from 'vitest'
import { formatBytes } from '../src/client/git/helpers.ts'

describe('formatBytes', () => {
  it('stays exact below a kibibyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('steps up a unit as the number outgrows it', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB')
    expect(formatBytes(1024 ** 4)).toBe('1 TB')
  })

  it('drops the decimal once the number is wide enough to read without one', () => {
    // "512 KB" reads better than "512.0 KB"; "99.9 KB" still wants its decimal.
    expect(formatBytes(512 * 1024)).toBe('512 KB')
    expect(formatBytes(100 * 1024)).toBe('100 KB')
    expect(formatBytes(99.9 * 1024)).toBe('99.9 KB')
  })
})
