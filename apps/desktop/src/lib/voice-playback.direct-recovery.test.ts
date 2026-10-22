import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyError } from '@/store/notifications'
import { $voicePlayback } from '@/store/voice-playback'

import { startSpeechStream, stopVoicePlayback } from './voice-playback'

vi.mock('@/lib/voice-client-direct', async importOriginal => ({
  ...(await importOriginal<object>()),
  directTtsConfig: async () => ({
    mode: 'direct',
    wire: 'elevenlabs-tts',
    provider: 'elevenlabs',
    base_url: 'https://voice.test/v1',
    api_key: 'test-fixture',
    model: 'eleven_turbo_v2',
    voice: 'voice',
    speed: null,
    min_len: 1
  })
}))

vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))

class CompletingAudio extends EventTarget {
  static played = 0
  src: string
  pause = vi.fn()

  constructor(src: string) {
    super()
    this.src = src
  }

  async play() {
    CompletingAudio.played += 1
    queueMicrotask(() => this.dispatchEvent(new Event('ended')))
  }
}

const audioResponse = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })

const spokenText = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).text)

async function speakReply() {
  const session = await startSpeechStream({ source: 'voice-conversation' })
  expect(session).not.toBeNull()
  session!.append('First sentence. Second sentence. Third sentence.')
  session!.finish()
  await vi.advanceTimersByTimeAsync(0)

  return session!
}

function pendingRequest() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
  )
}

describe('client-direct sentence recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    CompletingAudio.played = 0
    vi.stubGlobal('Audio', CompletingAudio)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-audio')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.mocked(notifyError).mockClear()
  })

  afterEach(() => {
    stopVoicePlayback()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('retries the second ElevenLabs sentence once, then speaks the tail without replaying the first', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(audioResponse())

    vi.stubGlobal('fetch', fetchMock)
    const session = await speakReply()

    expect(CompletingAudio.played).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    await expect(session.done).resolves.toBe('done')
    expect(spokenText(fetchMock)).toEqual([
      'First sentence.',
      'Second sentence.',
      'Second sentence.',
      'Third sentence.'
    ])
    expect(CompletingAudio.played).toBe(3)
    expect(notifyError).not.toHaveBeenCalled()
    expect($voicePlayback.get().status).toBe('idle')
  })

  it('shows terminal rejection after speech began, drops the tail, and releases the speaking state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(new Response('secret provider response', { status: 401 }))

    vi.stubGlobal('fetch', fetchMock)
    const session = await speakReply()

    await expect(session.done).resolves.toBe('done')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(notifyError).toHaveBeenCalledOnce()
    expect(String(vi.mocked(notifyError).mock.calls[0][0])).toContain('HTTP 401')
    expect(String(vi.mocked(notifyError).mock.calls[0][0])).not.toContain('secret provider response')
    expect($voicePlayback.get().status).toBe('idle')
  })

  it('Stop aborts a pending first request and never asks the caller to replay it', async () => {
    const fetchMock = pendingRequest()
    vi.stubGlobal('fetch', fetchMock)
    const session = await speakReply()
    const signal = fetchMock.mock.calls[0][1]!.signal!

    stopVoicePlayback()
    await expect(session.done).resolves.toBe('done')
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(CompletingAudio.played).toBe(0)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('Stop during Retry-After cancels the wait and never resumes the queued speech', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '3' } }))

    vi.stubGlobal('fetch', fetchMock)
    const session = await speakReply()

    stopVoicePlayback()
    await expect(session.done).resolves.toBe('done')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(CompletingAudio.played).toBe(1)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('bounds a hung request, reports failure, and releases the speaking state', async () => {
    const hanging = pendingRequest()
    const fetchMock = vi.fn().mockResolvedValueOnce(audioResponse()).mockImplementation(hanging)
    vi.stubGlobal('fetch', fetchMock)
    const session = await speakReply()
    let completed = false
    void session.done.then(() => {
      completed = true
    })

    await vi.advanceTimersByTimeAsync(29_999)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(session.done).resolves.toBe('done')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(notifyError).toHaveBeenCalledOnce()
    expect($voicePlayback.get().status).toBe('idle')
  })
})
