import { useRef, useState, useEffect, useCallback } from 'react'
import Matter from 'matter-js'
import { SoundFX } from './SoundFX'
import { Recorder } from './Recorder'
import './App.css'

const sfx = new SoundFX()
sfx.muted = true

const { Engine, Composite, Bodies, Body, Constraint, Events } = Matter

const FONT_SIZE = 15
const LINE_HEIGHT = 24
const PAD = 28
const FONT = `${FONT_SIZE}px "DM Mono", monospace`
const MAX_CHARS_PER_LINE = 500
const MIN_LAYOUT_W = 320 // minimum text layout width
const DEFAULT_TEXT =
  'Every string has two meanings\n\nThe one you type\nand the one that pulls'

type ShapeKind = 'circle' | 'triangle' | 'square'
type ToolMode = 'drag' | ShapeKind | 'laser' | 'grenade'

interface CB { ch: string; body: Matter.Body; w: number }
interface RopeLine { chars: CB[]; released: boolean; pins: Matter.Constraint[] }
interface PlacedShape { body: Matter.Body; kind: ShapeKind; size: number }

interface LaserGun { x: number; y: number }
// Laser bullet: travels with fixed speed, bounces off walls/shapes, has a short trail
interface LaserBullet { x: number; y: number; dx: number; dy: number; trail: {x:number,y:number}[]; bounces: number; life: number; lastHitShape: number }
interface Explosion { x:number; y:number; t:number; r:number }

/* ── localStorage helpers ── */
const LS_PREFIX = 'ss_'
const loadLS = <T,>(key: string, def: T): T => {
  try { const v = localStorage.getItem(LS_PREFIX + key); return v !== null ? JSON.parse(v) as T : def } catch { return def }
}
const saveLS = (key: string, val: unknown) => {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(val)) } catch { /* */ }
}

/* ── pre-render a character glyph to an offscreen bitmap ── */
function renderGlyph(ch: string, w: number): OffscreenCanvas {
  const h = FONT_SIZE + 8
  const oc = new OffscreenCanvas(Math.ceil(w) + 4, h)
  const octx = oc.getContext('2d')!
  octx.font = FONT; octx.fillStyle = '#f0e6d3'; octx.textBaseline = 'middle'
  octx.fillText(ch, 2, h / 2)
  return oc
}

/* ── image → ASCII converter ── */
async function imageToAscii(file: File, maxW = 90): Promise<string> {
  const img = await createImageBitmap(file)
  const charRatio = 0.48 // monospace chars are ~2x taller than wide
  const tW = Math.min(maxW, img.width)
  const tH = Math.round((img.height / img.width) * tW * charRatio)

  const oc = new OffscreenCanvas(tW, tH)
  const ctx = oc.getContext('2d')!
  ctx.drawImage(img, 0, 0, tW, tH)
  const { data } = ctx.getImageData(0, 0, tW, tH)

  // grayscale
  const grays: number[] = []
  for (let i = 0; i < data.length; i += 4)
    grays.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])

  // Otsu threshold for subject extraction
  const hist = new Array(256).fill(0)
  for (const g of grays) hist[Math.min(255, Math.round(g))]++
  const total = grays.length
  let sumAll = 0
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]
  let bestThresh = 128, bestBetween = 0
  let w0 = 0, sum0 = 0
  for (let t = 0; t < 256; t++) {
    w0 += hist[t]; if (w0 === 0) continue
    const w1 = total - w0; if (w1 === 0) break
    sum0 += t * hist[t]
    const m0 = sum0 / w0, m1 = (sumAll - sum0) / w1
    const between = w0 * w1 * (m0 - m1) ** 2
    if (between > bestBetween) { bestBetween = between; bestThresh = t }
  }

  // 4-level mapping for cleaner ASCII
  const lines: string[] = []
  for (let y = 0; y < tH; y++) {
    let line = ''
    for (let x = 0; x < tW; x++) {
      const g = grays[y * tW + x]
      if (g < bestThresh * 0.5) line += '@'
      else if (g < bestThresh * 0.8) line += '#'
      else if (g < bestThresh) line += '*'
      else line += ' '
    }
    lines.push(line.trimEnd())
  }
  // trim empty top/bottom lines
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.join('\n')
}

const LASER_SPEED = 800 // px/s
const LASER_TRAIL = 18 // trail length in points
const LASER_MAX_BOUNCES = 3
const LASER_MAX_LIFE = 4 // seconds

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(DEFAULT_TEXT)
  const [fullscreen, setFullscreen] = useState(false)
  const [, setPhysOn] = useState(false)
  const [tool, setTool] = useState<ToolMode>('drag')
  const [showPanel, setShowPanel] = useState(false)
  const [showFps, setShowFps] = useState(() => loadLS('showFps', true))
  const [bounce, setBounce] = useState(() => loadLS('bounce', 0.9))
  const [floorH, setFloorH] = useState(() => loadLS('floorH', 10))
  const [soundOn, setSoundOn] = useState(() => loadLS('soundOn', false))
  const [soundVol, setSoundVol] = useState(() => loadLS('soundVol', 0.5))

  const [isRec, setIsRec] = useState(false)
  const [recBlob, setRecBlob] = useState<{ blob: Blob; mime: string; url: string } | null>(null)
  const [mp4Progress, setMp4Progress] = useState('')
  const recorderRef = useRef<Recorder | null>(null)
  const recStartRef = useRef(0)

  useEffect(() => { sfx.muted = !soundOn; sfx.volume = soundVol }, [soundOn, soundVol])

  // resume AudioContext when tab regains focus (browser suspends it when hidden)
  useEffect(() => {
    const resume = () => { if (!document.hidden) sfx.resume() }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('focus', resume)
    return () => { document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume) }
  }, [])

  interface Ripple { x: number; amp: number; t: number }

  const engineRef = useRef<Matter.Engine | null>(null)
  const ripplesRef = useRef<Ripple[]>([])
  const laserGunsRef = useRef<LaserGun[]>([])
  const laserBulletsRef = useRef<LaserBullet[]>([])
  const shapeHpRef = useRef<Map<Matter.Body, number>>(new Map())
  const grenBodiesRef = useRef<{body: Matter.Body; fuse: number}[]>([])
  const explosionsRef = useRef<Explosion[]>([])

  const getEngine = () => {
    if (!engineRef.current) {
      const eng = Engine.create({ gravity: { x: 0, y: 1.5, scale: 0.001 }, enableSleeping: true })
      // listen for floor collisions → spawn ripples
      Events.on(eng, 'collisionStart', (ev) => {
        const floor = wallsRef.current[0]
        if (!floor) return
        for (const pair of ev.pairs) {
          if (pair.bodyA !== floor && pair.bodyB !== floor) continue
          const other = pair.bodyA === floor ? pair.bodyB : pair.bodyA
          const vy = Math.abs(other.velocity.y)
          if (vy > 0.5) {
            const ripples = ripplesRef.current
            ripples.push({ x: other.position.x, amp: Math.min(vy * 3, 40), t: 0 })
            if (ripples.length > 20) ripples.splice(0, ripples.length - 20)
            if (vy > 0.8) sfx.bounce()
          }
        }
      })
      engineRef.current = eng
    }
    return engineRef.current
  }
  const linesRef = useRef<RopeLine[]>([])
  const shapesRef = useRef<PlacedShape[]>([])
  const redoRef = useRef<PlacedShape[]>([])
  const wallsRef = useRef<Matter.Body[]>([])
  const dragRef = useRef<Matter.Constraint | null>(null)
  const physRef = useRef(false)
  const fullscreenRef = useRef(false)
  const bounceRef = useRef(loadLS('bounce', 0.9))
  const showFpsRef = useRef(loadLS('showFps', true))
  const floorHRef = useRef(loadLS('floorH', 10))
  const glyphCache = useRef<Map<string, OffscreenCanvas>>(new Map())

  const selectedRef = useRef(-1)
  const shapeDragRef = useRef<{ idx: number; ox: number; oy: number } | null>(null)
  const shapeDrawRef = useRef<{ kind: ShapeKind; x: number; y: number; size: number } | null>(null)
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const isPanRef = useRef(false)
  const lastPanRef = useRef({ x: 0, y: 0 })

  // fps tracking
  const fpsRef = useRef({ frames: 0, last: 0, value: 0 })
  const fpsBodyRef = useRef<Matter.Body | null>(null)

  const canvasPos = (cx: number, cy: number) => {
    const r = canvasRef.current?.getBoundingClientRect()
    return r ? { x: cx - r.left, y: cy - r.top } : { x: 0, y: 0 }
  }
  const screenToWorld = (sx: number, sy: number) => ({
    x: (sx - panRef.current.x) / zoomRef.current,
    y: (sy - panRef.current.y) / zoomRef.current,
  })
  const findShapeAt = (wx: number, wy: number) => {
    for (let i = shapesRef.current.length - 1; i >= 0; i--) {
      const s = shapesRef.current[i]
      if (Math.hypot(s.body.position.x - wx, s.body.position.y - wy) < s.size / 2 + 10) return i
    }
    return -1
  }

  /* ── fire all laser guns toward a target point ── */
  const fireLasers = (tx: number, ty: number) => {
    if (laserGunsRef.current.length > 0) sfx.laser()
    for (const gun of laserGunsRef.current) {
      const dx = tx - gun.x, dy = ty - gun.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 1) continue
      laserBulletsRef.current.push({
        x: gun.x, y: gun.y, dx: dx / len, dy: dy / len,
        trail: [{ x: gun.x, y: gun.y }], bounces: 0, life: 0, lastHitShape: -1,
      })
    }
  }

  // Per-frame laser bullet update: move, bounce, hit detect
  const updateLasers = (dtSec: number) => {
    const cw = canvasRef.current?.width ?? 0, ch = canvasRef.current?.height ?? 0
    const fh = floorHRef.current, engine = getEngine()
    const floorY = ch - fh
    const bullets = laserBulletsRef.current
    for (let bi = bullets.length - 1; bi >= 0; bi--) {
      const b = bullets[bi]
      b.life += dtSec
      if (b.life > LASER_MAX_LIFE) { bullets.splice(bi, 1); continue }
      const step = LASER_SPEED * dtSec
      b.x += b.dx * step; b.y += b.dy * step
      b.trail.push({ x: b.x, y: b.y })
      if (b.trail.length > LASER_TRAIL) b.trail.shift()
      // wall bounce
      if ((b.x <= 0 || b.x >= cw) && b.bounces < LASER_MAX_BOUNCES) { b.dx = -b.dx; b.bounces++; b.x = Math.max(1, Math.min(cw - 1, b.x)); sfx.wallBounce() }
      if ((b.y <= 0 || b.y >= floorY) && b.bounces < LASER_MAX_BOUNCES) { b.dy = -b.dy; b.bounces++; b.y = Math.max(1, Math.min(floorY - 1, b.y)); sfx.wallBounce() }
      if (b.x < -50 || b.x > cw + 50 || b.y < -50 || b.y > ch + 50) { bullets.splice(bi, 1); continue }
      // hit detect: proximity check
      const hitR = 14
      // text: push harder
      for (const line of linesRef.current) {
        for (const { body } of line.chars) {
          if (Math.abs(body.position.x - b.x) < hitR && Math.abs(body.position.y - b.y) < hitR) {
            releasePinOnBody(body)
            Body.setVelocity(body, { x: b.dx * 8 + (Math.random() - 0.5) * 2, y: b.dy * 8 - 3 })
            sfx.laserHit()
          }
        }
      }
      // shapes: reflect off shape + deal damage
      for (let si = shapesRef.current.length - 1; si >= 0; si--) {
        if (si === b.lastHitShape) continue // skip shape we just bounced off
        const s = shapesRef.current[si]
        const dist = Math.hypot(s.body.position.x - b.x, s.body.position.y - b.y)
        if (dist < s.size / 2 + 10) {
          // damage
          const hp = (shapeHpRef.current.get(s.body) ?? 3) - 1
          if (hp <= 0) {
            Composite.remove(engine.world, s.body); shapeHpRef.current.delete(s.body)
            shapesRef.current.splice(si, 1)
            if (selectedRef.current === si) selectedRef.current = -1
            else if (selectedRef.current > si) selectedRef.current--
          } else {
            shapeHpRef.current.set(s.body, hp)
            // reflect off shape (shape bounces don't count toward wall bounce limit)
            const nx = b.x - s.body.position.x, ny = b.y - s.body.position.y
            const nl = Math.sqrt(nx * nx + ny * ny) || 1
            const dot = b.dx * (nx / nl) + b.dy * (ny / nl)
            b.dx -= 2 * dot * (nx / nl)
            b.dy -= 2 * dot * (ny / nl)
            // push outside shape
            b.x = s.body.position.x + (nx / nl) * (s.size / 2 + 14)
            b.y = s.body.position.y + (ny / nl) * (s.size / 2 + 14)
            b.lastHitShape = si
            sfx.pop()
          }
          break
        }
      }
      // clear lastHitShape if bullet moved far from it
      if (b.lastHitShape >= 0 && b.lastHitShape < shapesRef.current.length) {
        const ls = shapesRef.current[b.lastHitShape]
        if (Math.hypot(ls.body.position.x - b.x, ls.body.position.y - b.y) > ls.size / 2 + 20) b.lastHitShape = -1
      } else { b.lastHitShape = -1 }
    }
  }

  /* ── throw grenade: real physics body from screen edge ── */
  const throwGrenade = (tx: number, ty: number) => {
    const cw = canvasRef.current?.width ?? 0
    // pick start from a random screen edge
    const edge = Math.floor(Math.random() * 3)
    let sx: number, sy: number
    if (edge === 0) { sx = tx + (Math.random() - 0.5) * cw * 0.5; sy = -30 }
    else if (edge === 1) { sx = -30; sy = ty + (Math.random() - 0.5) * 100 }
    else { sx = cw + 30; sy = ty + (Math.random() - 0.5) * 100 }
    const body = Bodies.circle(sx, sy, 8, {
      restitution: 0.2, friction: 0.5, frictionAir: 0.005, density: 0.004,
      label: 'grenade',
    })
    // calculate velocity to reach target in ~40 frames, compensating for gravity
    // gravity per frame: g = 1.5 * 0.001 * 16.67 ≈ 0.025 per frame
    // over T frames: y_offset from gravity = 0.5 * g * T^2
    const T = 40 // target frames to arrive
    const gPerFrame = 1.5 * 0.001 * 16.67
    const vx = (tx - sx) / T
    const vy = (ty - sy) / T - 0.5 * gPerFrame * T // compensate for gravity pulling down
    Body.setVelocity(body, { x: vx, y: vy })
    Composite.add(getEngine().world, body)
    grenBodiesRef.current.push({ body, fuse: 0 })
  }

  /* ── grenade explosion ── */
  const explodeAt = (gx: number, gy: number) => {
    sfx.explosion()
    const radius = 120
    const engine = getEngine()
    explosionsRef.current.push({ x: gx, y: gy, t: 0, r: radius })
    // destroy shapes
    for (let i = shapesRef.current.length - 1; i >= 0; i--) {
      const s = shapesRef.current[i]
      if (Math.hypot(s.body.position.x - gx, s.body.position.y - gy) < radius) {
        Composite.remove(engine.world, s.body); shapeHpRef.current.delete(s.body)
        shapesRef.current.splice(i, 1)
        if (selectedRef.current === i) selectedRef.current = -1
        else if (selectedRef.current > i) selectedRef.current--
      }
    }
    // scatter text + break ropes
    for (const line of linesRef.current) {
      for (const { body } of line.chars) {
        const d = Math.hypot(body.position.x - gx, body.position.y - gy)
        if (d < radius) {
          releasePinOnBody(body)
          const a = Math.atan2(body.position.y - gy, body.position.x - gx)
          const f = (1 - d / radius) * 0.06
          Body.applyForce(body, body.position, { x: Math.cos(a) * f, y: Math.sin(a) * f - 0.02 })
        }
      }
    }
  }

  // Per-frame grenade update: check collisions via speed drop (body hit something)
  const updateGrenades = () => {
    const engine = getEngine()
    const grenades = grenBodiesRef.current
    for (let gi = grenades.length - 1; gi >= 0; gi--) {
      const g = grenades[gi]
      g.fuse += 1
      // explode if: body speed dropped sharply (hit something) after initial flight, or fuse > 300 frames (~5s)
      const speed = Math.hypot(g.body.velocity.x, g.body.velocity.y)
      const hitSomething = g.fuse > 15 && speed < 1.5
      if (hitSomething || g.fuse > 300) {
        explodeAt(g.body.position.x, g.body.position.y)
        Composite.remove(engine.world, g.body)
        grenades.splice(gi, 1)
      }
    }
  }

  /* ═══════ render loop ═══════ */
  useEffect(() => {
    const engine = getEngine()
    let raf = 0, last = 0
    const loop = (t: number) => {
      const dt = last ? Math.min(t - last, 33) : 16.67; last = t
      Engine.update(engine, dt)
      if (physRef.current) updatePins()

      // fps
      const fps = fpsRef.current
      fps.frames++
      if (t - fps.last >= 1000) { fps.value = fps.frames; fps.frames = 0; fps.last = t }

      const canvas = canvasRef.current
      if (canvas && canvas.width > 0) {
        const ctx = canvas.getContext('2d')!
        const z = zoomRef.current, px = panRef.current.x, py = panRef.current.y
        const cw = canvas.width, ch = canvas.height
        const dtSec = dt / 1000
        ctx.fillStyle = '#080808'
        ctx.fillRect(0, 0, cw, ch)

        ctx.save(); ctx.translate(px, py); ctx.scale(z, z)
        const sel = selectedRef.current

        // ── update systems ──
        updateLasers(dtSec)
        updateGrenades()
        const explosions = explosionsRef.current
        for (let ei = explosions.length - 1; ei >= 0; ei--) {
          explosions[ei].t += dtSec
          if (explosions[ei].t > 0.6) explosions.splice(ei, 1)
        }

        // ── trampoline floor ──
        const ripples = ripplesRef.current
        for (let ri = ripples.length - 1; ri >= 0; ri--) {
          ripples[ri].t += dtSec
          if (ripples[ri].amp * Math.exp(-ripples[ri].t * 2.5) < 0.15) ripples.splice(ri, 1)
        }
        const fh = floorHRef.current
        const floorY = ch - fh
        const step = 4

        // solid floor fill
        ctx.fillStyle = 'rgba(232,67,40,0.07)'
        ctx.fillRect(-2000, floorY, cw + 4000, fh + 100)
        // top edge gradient
        const edgeGrad = ctx.createLinearGradient(0, floorY - 4, 0, floorY + 8)
        edgeGrad.addColorStop(0, 'rgba(232,67,40,0)')
        edgeGrad.addColorStop(0.5, 'rgba(232,67,40,0.2)')
        edgeGrad.addColorStop(1, 'rgba(232,67,40,0.05)')
        ctx.fillStyle = edgeGrad
        ctx.fillRect(-2000, floorY - 4, cw + 4000, 12)

        // animated floor line with ripples
        ctx.strokeStyle = 'rgba(232,67,40,0.4)'; ctx.lineWidth = 2.5 / z
        ctx.beginPath()
        for (let fx = -100; fx <= cw + 100; fx += step) {
          let dy = 0
          for (const r of ripples) {
            const d = fx - r.x
            const a = r.amp * Math.exp(-r.t * 2.5)
            dy -= a * Math.exp(-d * d / (3000 + r.t * 8000)) * Math.cos(d * 0.06 - r.t * 14)
          }
          fx === -100 ? ctx.moveTo(fx, floorY + dy) : ctx.lineTo(fx, floorY + dy)
        }
        ctx.stroke()
        // spring coils
        if (fh > 6) {
          ctx.strokeStyle = 'rgba(232,67,40,0.06)'; ctx.lineWidth = 1.5 / z
          ctx.beginPath()
          for (let fx = -100; fx <= cw + 100; fx += 8) {
            let dy = 0
            for (const r of ripples) {
              const d = fx - r.x
              const a = r.amp * 0.4 * Math.exp(-r.t * 2.5)
              dy -= a * Math.exp(-d * d / (3000 + r.t * 8000)) * Math.cos(d * 0.06 - r.t * 14)
            }
            const zigzag = ((fx / 8) % 2 === 0 ? fh * 0.3 : fh * 0.7)
            fx === -100 ? ctx.moveTo(fx, floorY + zigzag + dy * 0.5) : ctx.lineTo(fx, floorY + zigzag + dy * 0.5)
          }
          ctx.stroke()
        }
        // ripple glow
        for (const r of ripples) {
          const a = r.amp * Math.exp(-r.t * 2.5)
          if (a > 2) {
            const grad = ctx.createRadialGradient(r.x, floorY, 0, r.x, floorY, a * 3 + 40)
            grad.addColorStop(0, `rgba(232,67,40,${Math.min(a * 0.012, 0.18)})`)
            grad.addColorStop(1, 'rgba(232,67,40,0)')
            ctx.fillStyle = grad
            ctx.fillRect(r.x - a * 3 - 40, floorY - a * 2, (a * 3 + 40) * 2, a * 4)
          }
        }

        // shapes (with HP-based opacity)
        for (let si = 0; si < shapesRef.current.length; si++) {
          const { body, kind, size } = shapesRef.current[si]
          const isSel = si === sel
          const hp = shapeHpRef.current.get(body) ?? 3
          const hpAlpha = hp / 3
          ctx.fillStyle = isSel ? `rgba(232,67,40,${0.22 * hpAlpha})` : `rgba(232,67,40,${0.12 * hpAlpha})`
          ctx.strokeStyle = isSel ? `rgba(240,77,50,${hpAlpha})` : `rgba(232,67,40,${0.45 * hpAlpha})`
          ctx.lineWidth = (isSel ? 2.5 : 2) / z
          if (isSel) ctx.setLineDash([6 / z, 4 / z])
          if (kind === 'circle') {
            ctx.beginPath(); ctx.arc(body.position.x, body.position.y, size / 2, 0, Math.PI * 2)
            ctx.fill(); ctx.stroke()
          } else {
            const v = body.vertices; ctx.beginPath(); ctx.moveTo(v[0].x, v[0].y)
            for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x, v[i].y)
            ctx.closePath(); ctx.fill(); ctx.stroke()
          }
          if (isSel) ctx.setLineDash([])
          if (isSel) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = `${11 / z}px "Outfit",sans-serif`
            ctx.textAlign = 'center'
            ctx.fillText('Del to remove', body.position.x, body.position.y + size / 2 + 16 / z)
            ctx.textAlign = 'left'
          }
        }

        // shape creation preview
        const sd = shapeDrawRef.current
        if (sd && sd.size > 5) {
          ctx.fillStyle = 'rgba(232,67,40,0.15)'; ctx.strokeStyle = 'rgba(232,67,40,0.5)'
          ctx.lineWidth = 2 / z; ctx.setLineDash([5 / z, 4 / z])
          const r = sd.size / 2
          if (sd.kind === 'circle') {
            ctx.beginPath(); ctx.arc(sd.x, sd.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          } else if (sd.kind === 'square') {
            ctx.beginPath(); ctx.rect(sd.x - r, sd.y - r, sd.size, sd.size); ctx.fill(); ctx.stroke()
          } else {
            ctx.beginPath()
            for (let i = 0; i < 3; i++) {
              const a = (i * 2 * Math.PI / 3) - Math.PI / 2
              i === 0 ? ctx.moveTo(sd.x + r * Math.cos(a), sd.y + r * Math.sin(a))
                : ctx.lineTo(sd.x + r * Math.cos(a), sd.y + r * Math.sin(a))
            }
            ctx.closePath(); ctx.fill(); ctx.stroke()
          }
          ctx.setLineDash([])
        }

        // rope lines
        const lines = linesRef.current
        if (physRef.current) {
          ctx.strokeStyle = 'rgba(232,67,40,0.25)'; ctx.lineWidth = 1.5 / z
          for (const line of lines) {
            if (line.chars.length < 2) continue
            ctx.beginPath()
            for (let i = 0; i < line.chars.length; i++) {
              const p = line.chars[i].body.position
              i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
            }
            ctx.stroke()
          }
        }

        // characters — use cached glyph bitmaps for speed
        const cache = glyphCache.current
        for (const line of lines) {
          for (const { ch, body, w } of line.chars) {
            if (!ch.trim()) continue
            let glyph = cache.get(ch)
            if (!glyph) { glyph = renderGlyph(ch, w); cache.set(ch, glyph) }
            ctx.save()
            ctx.translate(body.position.x, body.position.y)
            ctx.rotate(body.angle)
            ctx.drawImage(glyph, -w / 2 - 2, -(FONT_SIZE + 8) / 2)
            ctx.restore()
          }
        }

        // laser gun visuals (red diamonds)
        for (const gun of laserGunsRef.current) {
          ctx.save()
          ctx.translate(gun.x, gun.y)
          ctx.rotate(Math.PI / 4)
          ctx.fillStyle = 'rgba(255,40,40,0.7)'
          ctx.strokeStyle = 'rgba(255,80,80,0.9)'
          ctx.lineWidth = 2 / z
          ctx.fillRect(-6 / z, -6 / z, 12 / z, 12 / z)
          ctx.strokeRect(-6 / z, -6 / z, 12 / z, 12 / z)
          ctx.restore()
        }

        // laser bullets (snake trails)
        for (const b of laserBulletsRef.current) {
          const tr = b.trail
          if (tr.length < 2) continue
          ctx.save()
          ctx.lineCap = 'round'
          for (let i = 1; i < tr.length; i++) {
            const alpha = i / tr.length
            ctx.strokeStyle = `rgba(255,40,40,${alpha * 0.9})`
            ctx.lineWidth = (1 + alpha * 2.5) / z
            ctx.beginPath(); ctx.moveTo(tr[i - 1].x, tr[i - 1].y); ctx.lineTo(tr[i].x, tr[i].y); ctx.stroke()
          }
          // glow at head
          const head = tr[tr.length - 1]
          ctx.fillStyle = 'rgba(255,80,60,0.5)'
          ctx.beginPath(); ctx.arc(head.x, head.y, 4 / z, 0, Math.PI * 2); ctx.fill()
          ctx.restore()
        }

        // flying grenades (real physics bodies)
        for (const g of grenBodiesRef.current) {
          const p = g.body.position
          ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(60,60,60,0.9)'; ctx.fill()
          ctx.strokeStyle = 'rgba(218,165,32,0.8)'; ctx.lineWidth = 2 / z; ctx.stroke()
          // fuse spark
          const spark = (g.fuse * 0.3) % 1
          if (spark > 0.5) {
            ctx.fillStyle = 'rgba(255,200,50,0.7)'
            ctx.beginPath(); ctx.arc(p.x, p.y - 10, 3, 0, Math.PI * 2); ctx.fill()
          }
        }

        // explosions
        for (const ex of explosions) {
          const progress = ex.t / 0.6
          const alpha = Math.max(0, 1 - progress)
          const currentR = ex.r * progress
          if (currentR > 1) {
            const grad = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, currentR)
            grad.addColorStop(0, `rgba(255,200,50,${alpha * 0.5})`)
            grad.addColorStop(0.5, `rgba(255,80,20,${alpha * 0.3})`)
            grad.addColorStop(1, 'rgba(255,30,10,0)')
            ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(ex.x, ex.y, currentR, 0, Math.PI * 2); ctx.fill()
            ctx.strokeStyle = `rgba(255,180,50,${alpha * 0.7})`; ctx.lineWidth = 2 / z
            ctx.beginPath(); ctx.arc(ex.x, ex.y, currentR, 0, Math.PI * 2); ctx.stroke()
          }
        }

        // fps body (in world space)
        const fpsBody = fpsBodyRef.current
        if (fpsBody && showFpsRef.current) {
          ctx.save()
          ctx.translate(fpsBody.position.x, fpsBody.position.y)
          ctx.rotate(fpsBody.angle)
          // body outline
          ctx.strokeStyle = 'rgba(100,255,100,0.3)'; ctx.lineWidth = 1.5 / z
          ctx.strokeRect(-32, -11, 64, 22)
          // text
          ctx.fillStyle = 'rgba(100,255,100,0.8)'; ctx.font = `${13}px "DM Mono",monospace`
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(`${fps.value} FPS`, 0, 0)
          ctx.restore()
        }

        ctx.restore()

        // ── HUD (screen space) ──
        if (!physRef.current && lines.length > 0) {
          ctx.fillStyle = 'rgba(232,67,40,0.35)'; ctx.font = '11px "Outfit",sans-serif'
          ctx.textAlign = 'center'; ctx.letterSpacing = '2px'
          ctx.fillText('CLICK & DRAG TO UNLEASH', cw / 2, ch - 28)
          ctx.textAlign = 'left'; ctx.letterSpacing = '0px'
        }
        if (z !== 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.font = '11px "DM Mono",monospace'
          ctx.textAlign = 'right'
          ctx.fillText(`${Math.round(z * 100)}%`, cw - 16, ch - 16)
          ctx.textAlign = 'left'
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ═══════ window move/up ═══════ */
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (isPanRef.current) {
        panRef.current.x += e.clientX - lastPanRef.current.x
        panRef.current.y += e.clientY - lastPanRef.current.y
        lastPanRef.current = { x: e.clientX, y: e.clientY }; return
      }
      const sp = canvasPos(e.clientX, e.clientY); const p = screenToWorld(sp.x, sp.y)
      if (shapeDrawRef.current) { const sd = shapeDrawRef.current; sd.size = Math.max(10, Math.hypot(p.x - sd.x, p.y - sd.y) * 2); return }
      if (shapeDragRef.current) { const { idx, ox, oy } = shapeDragRef.current; const s = shapesRef.current[idx]; if (s) Body.setPosition(s.body, { x: p.x - ox, y: p.y - oy }); return }
      if (dragRef.current) { dragRef.current.pointA.x = p.x; dragRef.current.pointA.y = p.y }
    }
    const up = () => {
      isPanRef.current = false
      if (shapeDrawRef.current) {
        const sd = shapeDrawRef.current
        if (sd.size >= 20) {
          let body: Matter.Body
          switch (sd.kind) {
            case 'circle': body = Bodies.circle(sd.x, sd.y, sd.size / 2, { isStatic: true }); break
            case 'triangle':
              body = Bodies.polygon(sd.x, sd.y, 3, sd.size / 2, { isStatic: true })
              Body.setAngle(body, -Math.PI / 6)
              break
            case 'square': body = Bodies.rectangle(sd.x, sd.y, sd.size, sd.size, { isStatic: true }); break
          }
          Composite.add(getEngine().world, body)
          shapesRef.current.push({ body, kind: sd.kind, size: sd.size })
          shapeHpRef.current.set(body, 3)
          selectedRef.current = shapesRef.current.length - 1
          redoRef.current = []
        }
        shapeDrawRef.current = null; return
      }
      shapeDragRef.current = null
      if (dragRef.current && engineRef.current) { Composite.remove(engineRef.current.world, dragRef.current); dragRef.current = null }
    }
    const tmove = (e: TouchEvent) => {
      if (!e.touches[0]) return
      const sp = canvasPos(e.touches[0].clientX, e.touches[0].clientY); const p = screenToWorld(sp.x, sp.y)
      if (shapeDrawRef.current) { const sd = shapeDrawRef.current; sd.size = Math.max(10, Math.hypot(p.x - sd.x, p.y - sd.y) * 2); return }
      if (shapeDragRef.current) { const { idx, ox, oy } = shapeDragRef.current; const s = shapesRef.current[idx]; if (s) Body.setPosition(s.body, { x: p.x - ox, y: p.y - oy }); return }
      if (dragRef.current) { dragRef.current.pointA.x = p.x; dragRef.current.pointA.y = p.y }
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    window.addEventListener('touchmove', tmove, { passive: true }); window.addEventListener('touchend', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('touchmove', tmove); window.removeEventListener('touchend', up) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ═══════ keyboard ═══════ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!fullscreenRef.current) return
      const meta = e.metaKey || e.ctrlKey
      if (!meta && !e.shiftKey) {
        if (e.key === 'Escape') { setTool('drag'); e.preventDefault(); return }
        if (e.key === '1') { setTool('circle'); e.preventDefault(); return }
        if (e.key === '2') { setTool('triangle'); e.preventDefault(); return }
        if (e.key === '3') { setTool('square'); e.preventDefault(); return }
        if (e.key === '4') { setTool('laser'); e.preventDefault(); return }
        if (e.key === '5') { setTool('grenade'); e.preventDefault(); return }
        if (e.key === 'r' || e.key === 'R') { doLayoutRef.current(); e.preventDefault(); return }
        if (e.key === 's' || e.key === 'S') { shatterAll(); e.preventDefault(); return }
        if (e.key === '=' || e.key === '+') { applyZoom(1.15, window.innerWidth / 2, window.innerHeight / 2); e.preventDefault(); return }
        if (e.key === '-') { applyZoom(0.87, window.innerWidth / 2, window.innerHeight / 2); e.preventDefault(); return }
        if (e.key === '0') { zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; e.preventDefault(); return }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current >= 0) {
        const s = shapesRef.current[selectedRef.current]
        if (s) { Composite.remove(getEngine().world, s.body); shapeHpRef.current.delete(s.body); shapesRef.current.splice(selectedRef.current, 1) }
        selectedRef.current = -1; e.preventDefault(); return
      }
      if (meta && e.key === 'z' && !e.shiftKey) { undoShape(); e.preventDefault(); return }
      if ((meta && e.shiftKey && e.key === 'z') || (meta && e.key === 'y')) { redoShape(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ═══════ resize: update canvas + move walls to push text ═══════ */
  useEffect(() => {
    const onResize = () => {
      if (!fullscreenRef.current) return
      const canvas = canvasRef.current; if (!canvas) return
      const w = window.innerWidth, h = window.innerHeight
      canvas.width = w; canvas.height = h
      // reposition walls
      const walls = wallsRef.current
      if (walls.length >= 3) {
        const fh = floorHRef.current
        Body.setPosition(walls[0], { x: w / 2, y: h - fh + 25 })
        Body.setPosition(walls[1], { x: -25, y: h / 2 })
        Body.setPosition(walls[2], { x: w + 25, y: h / 2 })
      }
      if (fpsBodyRef.current) Body.setPosition(fpsBodyRef.current, { x: w - 60, y: 70 })
      // rescue out-of-bounds bodies → teleport to top and re-drop
      const margin = 80
      for (const line of linesRef.current) {
        for (const { body } of line.chars) {
          const bx = body.position.x, by = body.position.y
          if (bx < -margin || bx > w + margin || by < -margin || by > h + margin) {
            Body.setPosition(body, { x: w / 2 + (Math.random() - 0.5) * 200, y: 60 })
            Body.setVelocity(body, { x: 0, y: 0 })
          }
        }
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const applyZoom = (factor: number, cx: number, cy: number) => {
    const oldZ = zoomRef.current, newZ = Math.max(0.2, Math.min(5, oldZ * factor))
    panRef.current.x = cx - (cx - panRef.current.x) * (newZ / oldZ)
    panRef.current.y = cy - (cy - panRef.current.y) * (newZ / oldZ)
    zoomRef.current = newZ
  }
  // wheel zoom — must be non-passive native listener to allow preventDefault
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const sp = canvasPos(e.clientX, e.clientY)
      applyZoom(e.deltaY > 0 ? 0.93 : 1.08, sp.x, sp.y)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doLayoutRef = useRef(() => {})

  /* ═══════ layout ═══════ */
  const doLayout = useCallback(async () => {
    const canvas = canvasRef.current; if (!canvas) return
    try { await document.fonts.load(FONT) } catch { /* */ }
    const engine = getEngine()
    Composite.clear(engine.world, false)
    for (const s of shapesRef.current) Composite.add(engine.world, s.body)
    dragRef.current = null; physRef.current = false; selectedRef.current = -1
    glyphCache.current.clear()
    laserGunsRef.current = []; laserBulletsRef.current = []
    for (const g of grenBodiesRef.current) Composite.remove(getEngine().world, g.body)
    grenBodiesRef.current = []; explosionsRef.current = []; shapeHpRef.current.clear()

    const w = window.innerWidth, h = window.innerHeight
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')!; ctx.font = FONT
    const layoutW = Math.max(MIN_LAYOUT_W, w - PAD * 2)
    const allLines: RopeLine[] = []
    const layoutLeft = PAD // will be centered per row after placement
    let x = 0, y = 72 + FONT_SIZE

    for (let rawLine of text.split('\n')) {
      if (rawLine.trim() === '') { y += LINE_HEIGHT; continue }
      if (rawLine.length > MAX_CHARS_PER_LINE) rawLine = rawLine.slice(0, MAX_CHARS_PER_LINE) + '...'
      const group = Body.nextGroup(true)
      const visualRows: CB[][] = []
      let currentRow: CB[] = []
      x = 0 // x is now relative, will be centered later

      for (const seg of rawLine.split(/(\s+)/)) {
        if (seg.length === 0) continue
        const segW = ctx.measureText(seg).width
        if (seg.trim() && x + segW > layoutW && x > 0) {
          if (currentRow.length > 0) { visualRows.push(currentRow); currentRow = [] }
          x = 0; y += LINE_HEIGHT
        }
        for (const c of seg) {
          const cw = ctx.measureText(c).width
          if (x + cw > layoutW && x > 0) {
            if (currentRow.length > 0) { visualRows.push(currentRow); currentRow = [] }
            x = 0; y += LINE_HEIGHT
          }
          // place at temporary x, will be shifted to center
          const body = Bodies.rectangle(layoutLeft + x + cw / 2, y, Math.max(cw, 6), FONT_SIZE + 3, {
            restitution: 0.5, friction: 0.3, frictionAir: 0.02, density: 0.002,
            collisionFilter: { group },
          })
          Body.setStatic(body, true)
          currentRow.push({ ch: c, body, w: cw })
          Composite.add(engine.world, body); x += cw
        }
      }
      if (currentRow.length > 0) visualRows.push(currentRow)

      // center each visual row horizontally
      for (const row of visualRows) {
        if (row.length === 0) continue
        const first = row[0].body.position.x - row[0].w / 2
        const last = row[row.length - 1].body.position.x + row[row.length - 1].w / 2
        const rowW = last - first
        const shift = (w - rowW) / 2 - first
        for (const { body } of row) Body.setPosition(body, { x: body.position.x + shift, y: body.position.y })
      }

      // S-pattern chain
      const lineChars: CB[] = []
      for (let r = 0; r < visualRows.length; r++) {
        if (r % 2 === 0) lineChars.push(...visualRows[r])
        else lineChars.push(...[...visualRows[r]].reverse())
      }

      if (lineChars.length > 0) allLines.push({ chars: lineChars, released: false, pins: [] })
      x = 0; y += LINE_HEIGHT
    }

    const wt = 50
    const fh = floorHRef.current
    const walls = [
      Bodies.rectangle(w / 2, h - fh + wt / 2, w * 2, wt, { isStatic: true, restitution: bounceRef.current }),
      Bodies.rectangle(-wt / 2, h / 2, wt, h * 3, { isStatic: true }),
      Bodies.rectangle(w + wt / 2, h / 2, wt, h * 3, { isStatic: true }),
    ]
    Composite.add(engine.world, walls); wallsRef.current = walls
    linesRef.current = allLines; setFullscreen(true); fullscreenRef.current = true; setPhysOn(false)
    document.body.style.overflow = 'hidden'
    // spawn fps body if fps enabled
    fpsBodyRef.current = null
    if (showFpsRef.current) spawnFpsBody()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])
  doLayoutRef.current = doLayout

  // Activate physics for all lines: make dynamic, add rope constraints, and pin each line in place
  const goPhysics = () => {
    if (physRef.current || !linesRef.current.length) return
    physRef.current = true; setPhysOn(true)
    const engine = getEngine()
    for (const line of linesRef.current) {
      const { chars } = line
      // calc average char width for max constraint length
      const avgW = chars.length > 0 ? chars.reduce((s, c) => s + c.w, 0) / chars.length : 10
      const maxLen = avgW * 2 // cap: soft-wrap joints use short rope, not actual distance
      for (const { body } of chars) Body.setStatic(body, false)
      // rope constraints between adjacent chars
      for (let i = 0; i < chars.length - 1; i++) {
        const pA = chars[i].body.position, pB = chars[i + 1].body.position
        const dist = Math.sqrt((pB.x - pA.x) ** 2 + (pB.y - pA.y) ** 2)
        Composite.add(engine.world, Constraint.create({
          bodyA: chars[i].body, bodyB: chars[i + 1].body,
          length: Math.min(dist, maxLen), stiffness: 0.5, damping: 0.08,
        }))
      }
      // pin every char so text stays perfectly in place until dragged off
      const pins: Matter.Constraint[] = []
      for (let i = 0; i < chars.length; i++) {
        const b = chars[i].body
        const pin = Constraint.create({
          pointA: { x: b.position.x, y: b.position.y },
          bodyB: b, pointB: { x: 0, y: 0 }, length: 0, stiffness: 0.4, damping: 0.1,
        })
        Composite.add(engine.world, pin)
        pins.push(pin)
      }
      line.pins = pins; line.released = false
    }
  }

  const PIN_BREAK_DIST = 12 // px — pins break when body moves this far from anchor

  // Release only the pin attached to a specific body
  let lastPopT = 0 // throttle pop sounds
  const releasePinOnBody = (target: Matter.Body) => {
    const engine = getEngine()
    for (const line of linesRef.current) {
      for (let i = line.pins.length - 1; i >= 0; i--) {
        if (line.pins[i].bodyB === target) {
          Composite.remove(engine.world, line.pins[i])
          line.pins.splice(i, 1)
          if (line.pins.length === 0) line.released = true
          const now = performance.now()
          if (now - lastPopT > 60) { sfx.pop(); lastPopT = now } // throttled
          return
        }
      }
    }
  }

  // Called every frame: break pins that are under too much tension (peeling effect)
  const updatePins = () => {
    const engine = getEngine()
    for (const line of linesRef.current) {
      if (line.released) continue
      for (let i = line.pins.length - 1; i >= 0; i--) {
        const pin = line.pins[i]
        const b = pin.bodyB!
        const a = pin.pointA!
        const dist = Math.hypot(b.position.x - a.x, b.position.y - a.y)
        if (dist > PIN_BREAK_DIST) {
          Composite.remove(engine.world, pin)
          line.pins.splice(i, 1)
        }
      }
      if (line.pins.length === 0) line.released = true
    }
  }

  // release all pins + apply random explosion force
  const shatterAll = () => {
    sfx.shatter()
    if (!physRef.current) goPhysics()
    const engine = getEngine()
    for (const line of linesRef.current) {
      for (const pin of line.pins) Composite.remove(engine.world, pin)
      line.pins = []; line.released = true
      for (const { body } of line.chars) {
        Body.setVelocity(body, {
          x: (Math.random() - 0.5) * 12,
          y: -(Math.random() * 8 + 2),
        })
        Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.3)
      }
    }
  }

  const undoShape = () => {
    const last = shapesRef.current.pop()
    if (last) { Composite.remove(getEngine().world, last.body); shapeHpRef.current.delete(last.body); redoRef.current.push(last) }
    selectedRef.current = -1
  }
  const redoShape = () => {
    const shape = redoRef.current.pop()
    if (shape) { Composite.add(getEngine().world, shape.body); shapesRef.current.push(shape); shapeHpRef.current.set(shape.body, 3); selectedRef.current = shapesRef.current.length - 1 }
  }

  const onDown = (e: React.MouseEvent | React.TouchEvent) => {
    sfx.ensure() // keep AudioContext alive on every user gesture
    if ('button' in e && e.button === 2) { isPanRef.current = true; lastPanRef.current = { x: e.clientX, y: e.clientY }; e.preventDefault(); return }
    e.preventDefault()
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX
    const cy = 'touches' in e ? e.touches[0].clientY : e.clientY
    const sp = canvasPos(cx, cy); const { x: mx, y: my } = screenToWorld(sp.x, sp.y)

    // laser tool: place gun
    if (tool === 'laser') {
      const guns = laserGunsRef.current
      guns.push({ x: mx, y: my })
      if (guns.length > 5) guns.shift()
      return
    }

    // grenade tool: throw grenade
    if (tool === 'grenade') {
      if (!physRef.current && linesRef.current.length) goPhysics()
      throwGrenade(mx, my)
      return
    }

    if (tool !== 'drag') { shapeDrawRef.current = { kind: tool, x: mx, y: my, size: 0 }; return }
    const si = findShapeAt(mx, my)
    if (si >= 0) { selectedRef.current = si; const s = shapesRef.current[si]; shapeDragRef.current = { idx: si, ox: mx - s.body.position.x, oy: my - s.body.position.y }; return }
    selectedRef.current = -1
    if (!linesRef.current.length) return
    if (!physRef.current) goPhysics()
    let best: Matter.Body | null = null, bestD = 60
    for (const line of linesRef.current) { for (const { body } of line.chars) { const d = Math.hypot(body.position.x - mx, body.position.y - my); if (d < bestD) { bestD = d; best = body } } }
    if (best) {
      // release grabbed body's pin
      releasePinOnBody(best)
      // also release the nearest chain endpoint to create a free tail on the clicked side
      for (const line of linesRef.current) {
        const idx = line.chars.findIndex(c => c.body === best)
        if (idx >= 0 && !line.released) {
          if (idx < line.chars.length / 2) {
            // clicked near start → free the start end
            releasePinOnBody(line.chars[0].body)
          } else {
            // clicked near end → free the end
            releasePinOnBody(line.chars[line.chars.length - 1].body)
          }
          break
        }
      }
      const c = Constraint.create({ pointA: { x: mx, y: my }, bodyB: best, pointB: { x: 0, y: 0 }, length: 0.01, stiffness: 0.1, damping: 0.01 })
      Composite.add(getEngine().world, c); dragRef.current = c
    } else if (laserGunsRef.current.length > 0) {
      // clicked empty space in drag mode with guns placed → fire lasers
      fireLasers(mx, my)
    }
  }

  const exitFullscreen = () => {
    setFullscreen(false); fullscreenRef.current = false; setPhysOn(false); setTool('drag')
    physRef.current = false; selectedRef.current = -1
    linesRef.current = []; shapesRef.current = []; redoRef.current = []; wallsRef.current = []
    fpsBodyRef.current = null; ripplesRef.current = []
    laserGunsRef.current = []; laserBulletsRef.current = []
    for (const g of grenBodiesRef.current) Composite.remove(getEngine().world, g.body)
    grenBodiesRef.current = []; explosionsRef.current = []; shapeHpRef.current.clear()
    Composite.clear(getEngine().world, false); glyphCache.current.clear()
    dragRef.current = null; shapeDragRef.current = null; shapeDrawRef.current = null
    zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; document.body.style.overflow = ''
  }

  // FPS body: static collider at top-right, text bounces off it
  const spawnFpsBody = () => {
    if (fpsBodyRef.current) return
    const body = Bodies.rectangle(window.innerWidth - 60, 70, 68, 24, {
      isStatic: true, restitution: bounceRef.current, label: 'fps',
    })
    Composite.add(getEngine().world, body)
    fpsBodyRef.current = body
  }
  const removeFpsBody = () => {
    if (!fpsBodyRef.current) return
    Composite.remove(getEngine().world, fpsBodyRef.current)
    fpsBodyRef.current = null
  }
  const toggleFps = (on: boolean) => {
    setShowFps(on); showFpsRef.current = on; saveLS('showFps', on)
    if (on && fullscreenRef.current) spawnFpsBody(); else removeFpsBody()
  }

  const handleBounceChange = (val: number) => {
    setBounce(val); bounceRef.current = val; saveLS('bounce', val)
    const floor = wallsRef.current[0]
    if (floor) floor.restitution = val
  }

  const handleFloorHChange = (val: number) => {
    setFloorH(val); floorHRef.current = val; saveLS('floorH', val)
    // rebuild floor wall at new height
    const engine = getEngine()
    const oldFloor = wallsRef.current[0]
    if (oldFloor) {
      const w = window.innerWidth, h = window.innerHeight
      Composite.remove(engine.world, oldFloor)
      const newFloor = Bodies.rectangle(w / 2, h - val + 25, w * 2, 50, { isStatic: true, restitution: bounceRef.current })
      wallsRef.current[0] = newFloor
      Composite.add(engine.world, newFloor)
    }
  }

  /* ═══════ icons ═══════ */
  const I = {
    hand: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 0 1 2 2v7.4a2 2 0 0 1-.6 1.4L15 23l-4.35-4.35a2 2 0 0 1-.15-2.65L12 14.5"/></svg>,
    circle: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/></svg>,
    tri: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 3L2 21h20L12 3z"/></svg>,
    sq: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>,
    laser: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>,
    grenade: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="14" r="8"/><path d="M12 6V3"/><path d="M9 3h6"/><path d="M15 6c1-1 2-2 3-2"/></svg>,
    undo: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>,
    redo: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>,
    reset: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/><path d="M2 11.5a10 10 0 0 1 18.8-4.3L21.5 8"/><path d="M22 12.5a10 10 0 0 1-18.8 4.2L2.5 16"/></svg>,
    zoomReset: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6M11 8v6"/></svg>,
    settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
    shatter: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>,
    rec: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>,
    close: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>,
  }

  const toggleRec = () => {
    if (isRec) {
      recorderRef.current?.stop()
      setIsRec(false)
    } else {
      const canvas = canvasRef.current; if (!canvas) return
      sfx.ensure()
      const rec = new Recorder(canvas, soundOn)
      rec.onStop = (blob, mime) => setRecBlob({ blob, mime, url: URL.createObjectURL(blob) })
      rec.start()
      recorderRef.current = rec
      recStartRef.current = performance.now()
      setIsRec(true)
    }
  }

  const downloadWebm = () => {
    if (!recBlob) return
    const url = URL.createObjectURL(recBlob.blob)
    const a = document.createElement('a'); a.href = url
    a.download = `string-string-${Date.now()}.webm`; a.click()
    URL.revokeObjectURL(url)
  }

  const convertMp4 = async () => {
    if (!recBlob) return
    setMp4Progress('Loading FFmpeg...')
    try {
      const mp4 = await Recorder.convertToMp4(recBlob.blob, pct => setMp4Progress(`${pct}%`))
      const url = URL.createObjectURL(mp4)
      const a = document.createElement('a'); a.href = url
      a.download = `string-string-${Date.now()}.mp4`; a.click()
      URL.revokeObjectURL(url)
      setMp4Progress('Done!')
    } catch (err) {
      console.error(err)
      setMp4Progress('Failed')
    }
  }

  return (
    <div className="app">
      {!fullscreen && (
        <>
          <header className="header">
            <h1 className="title">String <em>String</em></h1>
            <p className="subtitle">Type words. Pull the thread.</p>
          </header>
          <section className="input-section">
            <textarea value={text} onChange={e => setText(e.target.value)} rows={6} spellCheck={false} placeholder="Each line becomes a separate string." />
            <div className="actions">
              <button className="btn primary" onClick={doLayout}>Render</button>
              <button className="btn ghost" onClick={() => fileRef.current?.click()}>Image → ASCII</button>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={async e => {
                const f = e.target.files?.[0]; if (!f) return
                const ascii = await imageToAscii(f)
                setText(ascii)
                e.target.value = '' // reset so same file can be re-selected
              }} />
            </div>
          </section>
        </>
      )}

      <section className={`canvas-section${fullscreen ? ' fullscreen' : ''}`}>
        <canvas ref={canvasRef} onMouseDown={onDown} onTouchStart={onDown} onContextMenu={e => e.preventDefault()} />
      </section>

      {fullscreen && (
        <>
          <div className="toolbar">
            <button className={`tool-btn${tool === 'drag' ? ' active' : ''}`} onClick={() => setTool('drag')} title="Drag (Esc)">{I.hand}<kbd>Esc</kbd></button>
            <div className="tool-sep" />
            <button className={`tool-btn${tool === 'circle' ? ' active' : ''}`} onClick={() => setTool('circle')} title="Circle (1)">{I.circle}<kbd>1</kbd></button>
            <button className={`tool-btn${tool === 'triangle' ? ' active' : ''}`} onClick={() => setTool('triangle')} title="Triangle (2)">{I.tri}<kbd>2</kbd></button>
            <button className={`tool-btn${tool === 'square' ? ' active' : ''}`} onClick={() => setTool('square')} title="Square (3)">{I.sq}<kbd>3</kbd></button>
            <button className={`tool-btn${tool === 'laser' ? ' active' : ''}`} onClick={() => setTool('laser')} title="Laser (4)">{I.laser}<kbd>4</kbd></button>
            <button className={`tool-btn${tool === 'grenade' ? ' active' : ''}`} onClick={() => setTool('grenade')} title="Grenade (5)">{I.grenade}<kbd>5</kbd></button>
            <div className="tool-sep" />
            <button className="tool-btn" onClick={undoShape} title="Undo (Ctrl+Z)">{I.undo}<kbd>Z</kbd></button>
            <button className="tool-btn" onClick={redoShape} title="Redo (Ctrl+Shift+Z)">{I.redo}<kbd>Y</kbd></button>
            <button className="tool-btn" onClick={shatterAll} title="Shatter all (S)">{I.shatter}<kbd>S</kbd></button>
            <div className="tool-sep" />
            <button className="tool-btn" onClick={() => { setPhysOn(false); doLayout() }} title="Reset (R)">{I.reset}<kbd>R</kbd></button>
            <button className="tool-btn" onClick={() => { zoomRef.current = 1; panRef.current = { x: 0, y: 0 } }} title="Fit (0)">{I.zoomReset}<kbd>0</kbd></button>
            <button className={`tool-btn${showPanel ? ' active' : ''}`} onClick={() => setShowPanel(v => !v)} title="Settings">{I.settings}</button>
            <button className={`tool-btn${isRec ? ' recording' : ''}`} onClick={toggleRec} title={isRec ? 'Stop recording' : 'Record'}>{I.rec}</button>
            <button className="tool-btn exit-btn" onClick={exitFullscreen} title="Back">{I.close}</button>
          </div>

          {showPanel && (
            <div className="settings-panel">
              <label>
                <span>Bounce</span>
                <input type="range" min="0" max="2" step="0.05" value={bounce} onChange={e => handleBounceChange(+e.target.value)} />
                <span className="val">{bounce.toFixed(2)}</span>
              </label>
              <label>
                <span>Floor</span>
                <input type="range" min="1" max="50" step="1" value={floorH} onChange={e => handleFloorHChange(+e.target.value)} />
                <span className="val">{floorH}px</span>
              </label>
              <label>
                <span>FPS</span>
                <input type="checkbox" checked={showFps} onChange={e => toggleFps(e.target.checked)} />
              </label>
              <div className="tool-sep" style={{height: 'auto', margin: '0 8px'}} />
              <label>
                <span>Sound</span>
                <input type="checkbox" checked={soundOn} onChange={e => {
                  const on = e.target.checked; setSoundOn(on); saveLS('soundOn', on)
                  if (on) sfx.click() // init AudioContext during user gesture
                }} />
              </label>
              {soundOn && (
                <label>
                  <span>Vol</span>
                  <input type="range" min="0" max="1" step="0.05" value={soundVol} onChange={e => { setSoundVol(+e.target.value); saveLS('soundVol', +e.target.value) }} />
                  <span className="val">{Math.round(soundVol * 100)}%</span>
                </label>
              )}
            </div>
          )}

          {recBlob && (
            <div className="rec-modal" onClick={e => {
              if (e.target === e.currentTarget) { URL.revokeObjectURL(recBlob.url); setRecBlob(null); setMp4Progress('') }
            }}>
              <div className="rec-modal-inner">
                <video src={recBlob.url} controls autoPlay style={{ width: '100%', borderRadius: 8 }} />
                <div className="rec-modal-actions">
                  <button className="btn primary" onClick={downloadWebm}>Download WebM</button>
                  <button className="btn ghost" onClick={convertMp4}>{mp4Progress || 'Convert to MP4'}</button>
                  <button className="btn ghost" onClick={() => { URL.revokeObjectURL(recBlob.url); setRecBlob(null); setMp4Progress('') }}>Close</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
