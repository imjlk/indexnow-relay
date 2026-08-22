import { describe, expect, test } from 'bun:test'

import { normalizeSubmitUrl } from '../src/core/url.ts'

describe('normalizeSubmitUrl', () => {
  test('keeps canonical URLs as-is', () => {
    expect(normalizeSubmitUrl('https://www.example.com/posts/hello')).toEqual({
      url: 'https://www.example.com/posts/hello',
      host: 'www.example.com',
    })
  })

  test('lowercases the host and keeps the path', () => {
    const { url, host } = normalizeSubmitUrl('HTTPS://BLOG.Example.COM/A/b')
    expect(host).toBe('blog.example.com')
    expect(url).toBe('https://blog.example.com/A/b')
  })

  test('strips the fragment', () => {
    const { url } = normalizeSubmitUrl('https://www.example.com/page#section')
    expect(url).toBe('https://www.example.com/page')
  })

  test('drops default ports', () => {
    expect(normalizeSubmitUrl('https://www.example.com:443/x').url).toBe('https://www.example.com/x')
    expect(normalizeSubmitUrl('http://www.example.com:80/x').url).toBe('http://www.example.com/x')
  })

  test('keeps non-default ports', () => {
    expect(normalizeSubmitUrl('http://localhost:3000/x').url).toBe('http://localhost:3000/x')
  })

  test('fills in the root path', () => {
    expect(normalizeSubmitUrl('https://www.example.com').url).toBe('https://www.example.com/')
  })

  test('rejects non-http schemes', () => {
    expect(() => normalizeSubmitUrl('ftp://www.example.com/file')).toThrow()
    expect(() => normalizeSubmitUrl('file:///etc/passwd')).toThrow()
  })

  test('rejects relative URLs', () => {
    expect(() => normalizeSubmitUrl('/just/a/path')).toThrow()
  })

  test('rejects oversized URLs', () => {
    const huge = 'https://www.example.com/' + 'a'.repeat(3000)
    expect(() => normalizeSubmitUrl(huge)).toThrow()
  })
})
