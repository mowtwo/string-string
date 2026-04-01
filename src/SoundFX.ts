import { ZZFX, ZZFXSound } from 'zzfx'

// ZzFX params: [volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay, tremolo]

const SOUNDS = {
  // short low thud
  bounce: [0.8, 0.02, 120, 0.01, 0.01, 0.12, 2, 1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.05, 0],
  // high blip
  pop: [0.5, 0.01, 600, 0, 0, 0.04, 0, 1, 0, 0, 200, 0.01, 0, 0, 0, 0, 0, 0.4, 0, 0],
  // descending zap
  laser: [0.4, 0.02, 700, 0, 0.05, 0.15, 3, 1, -200, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.1, 0],
  // rumble + noise
  explosion: [0.7, 0.05, 50, 0.01, 0.1, 0.4, 4, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0.3, 0.1, 0],
  // tiny tick
  click: [0.2, 0, 1000, 0, 0, 0.015, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
  // noise burst high-pass
  shatter: [0.5, 0.05, 200, 0, 0.05, 0.25, 4, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0.4, 0.05, 0],
  // laser hitting text - short sizzle
  laserHit: [0.3, 0.02, 300, 0, 0, 0.06, 4, 0, 100, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.3, 0, 0],
  // wall bounce - quiet ping
  wallBounce: [0.12, 0, 1200, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0],
} as const

type SoundName = keyof typeof SOUNDS

export class SoundFX {
  private cached: Map<SoundName, ZZFXSound> = new Map()
  private _volume = 0.5
  private _muted = true

  constructor() {
    // precache all sounds
    for (const [name, params] of Object.entries(SOUNDS)) {
      this.cached.set(name as SoundName, new ZZFXSound([...params]))
    }
  }

  get volume() { return this._volume }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v))
    ZZFX.volume = this._volume
  }

  get muted() { return this._muted }
  set muted(m: boolean) {
    this._muted = m
    ZZFX.volume = m ? 0 : this._volume
  }

  ensure() {
    if (!ZZFX.z) ZZFX.z = new AudioContext()
    if (ZZFX.z.state === 'suspended') ZZFX.z.resume()
  }

  /** Expose AudioContext for recording capture */
  getAudioContext(): AudioContext | null { return ZZFX.z }
  /** Expose destination for MediaStream capture */
  getDestination(): AudioNode | null { return ZZFX.z?.destination ?? null }

  /** Call on visibilitychange/focus to resume suspended context */
  resume() {
    if (ZZFX.z?.state === 'suspended') ZZFX.z.resume()
  }

  private play(name: SoundName, vol = 1) {
    if (this._muted) return
    this.ensure()
    this.cached.get(name)?.play(vol)
  }

  bounce() { this.play('bounce') }
  pop() { this.play('pop') }
  laser() { this.play('laser') }
  explosion() { this.play('explosion') }
  click() { this.play('click') }
  shatter() { this.play('shatter') }
  laserHit() { this.play('laserHit') }
  wallBounce() { this.play('wallBounce') }
}
