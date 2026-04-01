import { ZZFX } from 'zzfx'

export class Recorder {
  private canvas: HTMLCanvasElement
  private captureAudio: boolean
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private audioDest: MediaStreamAudioDestinationNode | null = null
  private silenceOsc: OscillatorNode | null = null
  private origPlaySamples: (typeof ZZFX.playSamples) | null = null
  private mime = ''
  private _recording = false
  startTime = 0

  onStop: ((blob: Blob, mime: string) => void) | null = null

  constructor(canvas: HTMLCanvasElement, captureAudio = false) {
    this.canvas = canvas
    this.captureAudio = captureAudio
  }

  get recording() { return this._recording }

  start() {
    const videoStream = this.canvas.captureStream(60)
    const tracks = [...videoStream.getVideoTracks()]

    const ctx = ZZFX.z
    if (this.captureAudio && ctx) {
      this.audioDest = ctx.createMediaStreamDestination()
      const captureDest = this.audioDest

      // Keep audio track alive with a silent oscillator (gain=0)
      // Without this, MediaRecorder produces corrupt output when audio track has no data
      const silenceGain = ctx.createGain()
      silenceGain.gain.value = 0
      this.silenceOsc = ctx.createOscillator()
      this.silenceOsc.connect(silenceGain)
      silenceGain.connect(captureDest)
      this.silenceOsc.start()

      // Monkey-patch ZZFX.playSamples to also route final audio to capture
      // ZzFX chain: source → panner → gainNode → ctx.destination
      // We need gainNode to also connect to captureDest
      this.origPlaySamples = ZZFX.playSamples
      const audioCtx = ctx
      const sampleRate = 44100
      ZZFX.playSamples = function (samples: number[][], volume = 1, rate = 1, pan = 0, loop = false) {
        const channelCount = samples.length
        const sampleLength = samples[0].length
        const buffer = audioCtx.createBuffer(channelCount, sampleLength, sampleRate)
        const source = audioCtx.createBufferSource()
        samples.forEach((c, i) => buffer.getChannelData(i).set(c))
        source.buffer = buffer
        source.playbackRate.value = rate
        source.loop = loop
        const gainNode = audioCtx.createGain()
        gainNode.gain.value = ZZFX.volume * volume
        gainNode.connect(audioCtx.destination)
        gainNode.connect(captureDest) // also route to recording
        const pannerNode = new StereoPannerNode(audioCtx, { pan })
        source.connect(pannerNode).connect(gainNode)
        source.start()
        return source
      }

      tracks.push(...this.audioDest.stream.getAudioTracks())
    }

    const hasAudio = tracks.some(t => t.kind === 'audio')
    const combined = new MediaStream(tracks)

    // VP9 gives best quality for canvas recording
    if (hasAudio) {
      this.mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus' : 'video/webm'
    } else {
      this.mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm'
    }

    this.recorder = new MediaRecorder(combined, {
      mimeType: this.mime,
      videoBitsPerSecond: 5_000_000,
    })
    this.chunks = []

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }

    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mime })
      this.cleanup()
      this.onStop?.(blob, this.mime)
    }

    this.recorder.start(100)
    this._recording = true
    this.startTime = performance.now()
  }

  stop() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.requestData()
      this.recorder.stop()
    }
    this._recording = false
  }

  private cleanup() {
    if (this.silenceOsc) {
      try { this.silenceOsc.stop() } catch { /* */ }
      this.silenceOsc = null
    }
    if (this.origPlaySamples) {
      ZZFX.playSamples = this.origPlaySamples
      this.origPlaySamples = null
    }
    this.audioDest = null
  }

  static async convertToMp4(
    blob: Blob,
    onProgress?: (pct: number) => void,
  ): Promise<Blob> {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const { fetchFile } = await import('@ffmpeg/util')

    const ffmpeg = new FFmpeg()
    ffmpeg.on('progress', ({ progress }) => {
      onProgress?.(Math.round(Math.max(0, Math.min(1, progress)) * 100))
    })

    const useMT = typeof SharedArrayBuffer !== 'undefined'
    if (useMT) {
      const workerRes = await fetch('https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/esm/ffmpeg-core.worker.js')
      const workerBlob = new Blob([await workerRes.text()], { type: 'text/javascript' })
      await ffmpeg.load({
        coreURL: 'https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/esm/ffmpeg-core.js',
        wasmURL: 'https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/esm/ffmpeg-core.wasm',
        workerURL: URL.createObjectURL(workerBlob),
      })
    } else {
      await ffmpeg.load({
        coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js',
        wasmURL: 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm',
      })
    }

    await ffmpeg.writeFile('input.webm', await fetchFile(blob))
    await ffmpeg.exec([
      '-r', '60',
      '-i', 'input.webm',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'fastdecode',
      '-crf', '28',
      ...(useMT ? ['-threads', '4'] : []),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      'output.mp4',
    ])

    const data = await ffmpeg.readFile('output.mp4') as Uint8Array
    return new Blob([data.buffer as ArrayBuffer], { type: 'video/mp4' })
  }
}
