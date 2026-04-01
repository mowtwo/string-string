import { useRef, useState, useEffect, useCallback } from 'react'
import Matter from 'matter-js'
import './App.css'

const { Engine, Composite, Bodies, Body, Constraint, Events } = Matter

const FONT_SIZE = 20
const LINE_HEIGHT = 32
const PAD = 40
const FONT = `${FONT_SIZE}px "DM Mono", monospace`
const DEFAULT_TEXT =
  'Every string has two meanings\n\nThe one you type\nand the one that pulls'

type ShapeKind = 'circle' | 'triangle' | 'square'
type ToolMode = 'drag' | ShapeKind

interface CB { ch: string; body: Matter.Body; w: number }
interface PlacedShape { body: Matter.Body; kind: ShapeKind; size: number }

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

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [text, setText] = useState(DEFAULT_TEXT)
  const [fullscreen, setFullscreen] = useState(false)
  const [, setPhysOn] = useState(false)
  const [tool, setTool] = useState<ToolMode>('drag')
  const [showPanel, setShowPanel] = useState(false)
  const [showFps, setShowFps] = useState(() => loadLS('showFps', true))
  const [bounce, setBounce] = useState(() => loadLS('bounce', 0.9))
  const [floorH, setFloorH] = useState(() => loadLS('floorH', 10))

  interface Ripple { x: number; amp: number; t: number }

  const engineRef = useRef<Matter.Engine | null>(null)
  const ripplesRef = useRef<Ripple[]>([])
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
            if (ripples.length > 20) ripples.splice(0, ripples.length - 20) // cap
          }
        }
      })
      engineRef.current = eng
    }
    return engineRef.current
  }
  const linesRef = useRef<CB[][]>([])
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

  /* ═══════ render loop ═══════ */
  useEffect(() => {
    const engine = getEngine()
    let raf = 0, last = 0
    const loop = (t: number) => {
      const dt = last ? Math.min(t - last, 33) : 16.67; last = t
      Engine.update(engine, dt)

      // fps
      const fps = fpsRef.current
      fps.frames++
      if (t - fps.last >= 1000) { fps.value = fps.frames; fps.frames = 0; fps.last = t }

      const canvas = canvasRef.current
      if (canvas && canvas.width > 0) {
        const ctx = canvas.getContext('2d')!
        const z = zoomRef.current, px = panRef.current.x, py = panRef.current.y
        const cw = canvas.width, ch = canvas.height
        ctx.clearRect(0, 0, cw, ch)

        ctx.save(); ctx.translate(px, py); ctx.scale(z, z)
        const sel = selectedRef.current

        // ── trampoline floor ──
        const ripples = ripplesRef.current
        const dtSec = dt / 1000
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

        // shapes
        for (let si = 0; si < shapesRef.current.length; si++) {
          const { body, kind, size } = shapesRef.current[si]
          const isSel = si === sel
          ctx.fillStyle = isSel ? 'rgba(232,67,40,0.22)' : 'rgba(232,67,40,0.12)'
          ctx.strokeStyle = isSel ? '#f04d32' : 'rgba(232,67,40,0.45)'
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
            if (line.length < 2) continue
            ctx.beginPath()
            for (let i = 0; i < line.length; i++) {
              const p = line[i].body.position
              i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
            }
            ctx.stroke()
          }
        }

        // characters — use cached glyph bitmaps for speed
        const cache = glyphCache.current
        for (const line of lines) {
          for (const { ch, body, w } of line) {
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
            case 'triangle': body = Bodies.polygon(sd.x, sd.y, 3, sd.size / 2, { isStatic: true }); break
            case 'square': body = Bodies.rectangle(sd.x, sd.y, sd.size, sd.size, { isStatic: true }); break
          }
          Composite.add(getEngine().world, body)
          shapesRef.current.push({ body, kind: sd.kind, size: sd.size })
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
        if (e.key === 'r' || e.key === 'R') { doLayoutRef.current(); e.preventDefault(); return }
        if (e.key === '=' || e.key === '+') { applyZoom(1.15, window.innerWidth / 2, window.innerHeight / 2); e.preventDefault(); return }
        if (e.key === '-') { applyZoom(0.87, window.innerWidth / 2, window.innerHeight / 2); e.preventDefault(); return }
        if (e.key === '0') { zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; e.preventDefault(); return }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current >= 0) {
        const s = shapesRef.current[selectedRef.current]
        if (s) { Composite.remove(getEngine().world, s.body); shapesRef.current.splice(selectedRef.current, 1) }
        selectedRef.current = -1; e.preventDefault(); return
      }
      if (meta && e.key === 'z' && !e.shiftKey) { undoShape(); e.preventDefault(); return }
      if ((meta && e.shiftKey && e.key === 'z') || (meta && e.key === 'y')) { redoShape(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyZoom = (factor: number, cx: number, cy: number) => {
    const oldZ = zoomRef.current, newZ = Math.max(0.2, Math.min(5, oldZ * factor))
    panRef.current.x = cx - (cx - panRef.current.x) * (newZ / oldZ)
    panRef.current.y = cy - (cy - panRef.current.y) * (newZ / oldZ)
    zoomRef.current = newZ
  }
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const sp = canvasPos(e.clientX, e.clientY)
    applyZoom(e.deltaY > 0 ? 0.93 : 1.08, sp.x, sp.y)
  }

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

    const w = window.innerWidth, h = window.innerHeight
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')!; ctx.font = FONT
    const maxW = w - PAD * 2; const allLines: CB[][] = []
    let x = PAD, y = PAD + FONT_SIZE

    for (const rawLine of text.split('\n')) {
      if (rawLine.trim() === '') { y += LINE_HEIGHT; continue }
      const group = Body.nextGroup(true); const lineChars: CB[] = []
      for (const seg of rawLine.split(/(\s+)/)) {
        if (seg.length === 0) continue
        const segW = ctx.measureText(seg).width
        if (seg.trim() && x - PAD + segW > maxW && x > PAD) { x = PAD; y += LINE_HEIGHT }
        for (const c of seg) {
          const cw = ctx.measureText(c).width
          const body = Bodies.rectangle(x + cw / 2, y, Math.max(cw, 8), FONT_SIZE + 4, {
            restitution: 0.5, friction: 0.3, frictionAir: 0.02, density: 0.002,
            collisionFilter: { group },
          })
          Body.setStatic(body, true)
          lineChars.push({ ch: c, body, w: cw })
          Composite.add(engine.world, body); x += cw
        }
      }
      if (lineChars.length > 0) allLines.push(lineChars)
      x = PAD; y += LINE_HEIGHT
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

  const goPhysics = () => {
    if (physRef.current || !linesRef.current.length) return
    physRef.current = true; setPhysOn(true)
    const engine = getEngine()
    for (const line of linesRef.current) {
      for (const { body } of line) Body.setStatic(body, false)
      for (let i = 0; i < line.length - 1; i++) {
        const pA = line[i].body.position, pB = line[i + 1].body.position
        const dist = Math.sqrt((pB.x - pA.x) ** 2 + (pB.y - pA.y) ** 2)
        Composite.add(engine.world, Constraint.create({
          bodyA: line[i].body, bodyB: line[i + 1].body, length: dist, stiffness: 0.5, damping: 0.08,
        }))
      }
    }
  }

  const undoShape = () => {
    const last = shapesRef.current.pop()
    if (last) { Composite.remove(getEngine().world, last.body); redoRef.current.push(last) }
    selectedRef.current = -1
  }
  const redoShape = () => {
    const shape = redoRef.current.pop()
    if (shape) { Composite.add(getEngine().world, shape.body); shapesRef.current.push(shape); selectedRef.current = shapesRef.current.length - 1 }
  }

  const onDown = (e: React.MouseEvent | React.TouchEvent) => {
    if ('button' in e && e.button === 2) { isPanRef.current = true; lastPanRef.current = { x: e.clientX, y: e.clientY }; e.preventDefault(); return }
    e.preventDefault()
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX
    const cy = 'touches' in e ? e.touches[0].clientY : e.clientY
    const sp = canvasPos(cx, cy); const { x: mx, y: my } = screenToWorld(sp.x, sp.y)
    if (tool !== 'drag') { shapeDrawRef.current = { kind: tool, x: mx, y: my, size: 0 }; return }
    const si = findShapeAt(mx, my)
    if (si >= 0) { selectedRef.current = si; const s = shapesRef.current[si]; shapeDragRef.current = { idx: si, ox: mx - s.body.position.x, oy: my - s.body.position.y }; return }
    selectedRef.current = -1
    if (!linesRef.current.length) return
    if (!physRef.current) goPhysics()
    let best: Matter.Body | null = null, bestD = 60
    for (const line of linesRef.current) { for (const { body } of line) { const d = Math.hypot(body.position.x - mx, body.position.y - my); if (d < bestD) { bestD = d; best = body } } }
    if (best) { const c = Constraint.create({ pointA: { x: mx, y: my }, bodyB: best, pointB: { x: 0, y: 0 }, length: 0.01, stiffness: 0.1, damping: 0.01 }); Composite.add(getEngine().world, c); dragRef.current = c }
  }

  const exitFullscreen = () => {
    setFullscreen(false); fullscreenRef.current = false; setPhysOn(false); setTool('drag')
    physRef.current = false; selectedRef.current = -1
    linesRef.current = []; shapesRef.current = []; redoRef.current = []; wallsRef.current = []
    fpsBodyRef.current = null; ripplesRef.current = []
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
    undo: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>,
    redo: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>,
    reset: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/><path d="M2 11.5a10 10 0 0 1 18.8-4.3L21.5 8"/><path d="M22 12.5a10 10 0 0 1-18.8 4.2L2.5 16"/></svg>,
    zoomReset: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6M11 8v6"/></svg>,
    settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
    close: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>,
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
            </div>
          </section>
        </>
      )}

      <section className={`canvas-section${fullscreen ? ' fullscreen' : ''}`}>
        <canvas ref={canvasRef} onMouseDown={onDown} onTouchStart={onDown} onWheel={onWheel} onContextMenu={e => e.preventDefault()} />
      </section>

      {fullscreen && (
        <>
          <div className="toolbar">
            <button className={`tool-btn${tool === 'drag' ? ' active' : ''}`} onClick={() => setTool('drag')} title="Drag (Esc)">{I.hand}<kbd>Esc</kbd></button>
            <div className="tool-sep" />
            <button className={`tool-btn${tool === 'circle' ? ' active' : ''}`} onClick={() => setTool('circle')} title="Circle (1)">{I.circle}<kbd>1</kbd></button>
            <button className={`tool-btn${tool === 'triangle' ? ' active' : ''}`} onClick={() => setTool('triangle')} title="Triangle (2)">{I.tri}<kbd>2</kbd></button>
            <button className={`tool-btn${tool === 'square' ? ' active' : ''}`} onClick={() => setTool('square')} title="Square (3)">{I.sq}<kbd>3</kbd></button>
            <div className="tool-sep" />
            <button className="tool-btn" onClick={undoShape} title="Undo (Ctrl+Z)">{I.undo}<kbd>Z</kbd></button>
            <button className="tool-btn" onClick={redoShape} title="Redo (Ctrl+Shift+Z)">{I.redo}<kbd>Y</kbd></button>
            <div className="tool-sep" />
            <button className="tool-btn" onClick={() => { setPhysOn(false); doLayout() }} title="Reset (R)">{I.reset}<kbd>R</kbd></button>
            <button className="tool-btn" onClick={() => { zoomRef.current = 1; panRef.current = { x: 0, y: 0 } }} title="Fit (0)">{I.zoomReset}<kbd>0</kbd></button>
            <button className={`tool-btn${showPanel ? ' active' : ''}`} onClick={() => setShowPanel(v => !v)} title="Settings">{I.settings}</button>
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
            </div>
          )}
        </>
      )}
    </div>
  )
}
