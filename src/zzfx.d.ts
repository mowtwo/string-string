declare module 'zzfx' {
  export function zzfx(...params: number[]): AudioBufferSourceNode
  export const ZZFX: {
    volume: number
    z: AudioContext | null
    play(...params: number[]): AudioBufferSourceNode
    buildSamples(...params: number[]): number[]
    playSamples(samples: number[][], volume?: number, rate?: number, pan?: number, loop?: boolean): AudioBufferSourceNode
  }
  export class ZZFXSound {
    constructor(params?: number[])
    play(volume?: number, pitch?: number, randomness?: number, pan?: number, loop?: boolean): AudioBufferSourceNode | undefined
  }
}
