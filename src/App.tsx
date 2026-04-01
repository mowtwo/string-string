import { useRef, useState, useEffect } from 'react'
import Matter from 'matter-js'
import './App.css'

const { Engine, Composite, Bodies, Body, Constraint } = Matter

const FONT_SIZE = 20
const LINE_HEIGHT = 32
const PAD = 40
const FONT = `${FONT_SIZE}px "DM Mono", monospace`

const DEFAULT_TEXT =
  'Every string has two meanings — the one you type, and the one that pulls. Click anywhere and drag to discover the second one.'

interface CB {
  ch: string
  body: Matter.Body
  w: number
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState(DEFAULT_TEXT)
  const [rendered, setRendered] = useState(false)
  const [physOn, setPhysOn] = useState(false)

  const engineRef = useRef<Matter.Engine | null>(null)
  const getEngine = () => {
    if (!engineRef.current) {
      engineRef.current = Engine.create({ gravity: { x: 0, y: 1.5, scale: 0.001 } })
    }
    return engineRef.current
  }
  const listRef = useRef<CB[]>([])
  const dragRef = useRef<Matter.Constraint | null>(null)
  const physRef = useRef(false)

  // ── Continuous render + physics loop ──
  useEffect(() => {
    const engine = getEngine()
    let raf = 0
    let last = 0

    const loop = (t: number) => {
      const dt = last ? Math.min(t - last, 33) : 16.67
      last = t
      Engine.update(engine, dt)

      const canvas = canvasRef.current
      if (canvas && canvas.width > 0) {
        const ctx = canvas.getContext('2d')!
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        const list = listRef.current
        if (list.length) {
          // draw rope line
          if (physRef.current && list.length > 1) {
            ctx.beginPath()
            ctx.strokeStyle = 'rgba(232,67,40,0.25)'
            ctx.lineWidth = 1.5
            for (let i = 0; i < list.length; i++) {
              const p = list[i].body.position
              i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
            }
            ctx.stroke()
          }
          // draw characters
          ctx.font = FONT
          ctx.fillStyle = '#f0e6d3'
          ctx.textBaseline = 'middle'
          for (const { ch, body, w } of list) {
            if (!ch.trim()) continue
            ctx.save()
            ctx.translate(body.position.x, body.position.y)
            ctx.rotate(body.angle)
            ctx.fillText(ch, -w / 2, 1)
            ctx.restore()
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Window drag events ──
  useEffect(() => {
    const pos = (cx: number, cy: number) => {
      const r = canvasRef.current?.getBoundingClientRect()
      return r ? { x: cx - r.left, y: cy - r.top } : { x: 0, y: 0 }
    }
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return
      const p = pos(e.clientX, e.clientY)
      dragRef.current.pointA.x = p.x
      dragRef.current.pointA.y = p.y
    }
    const up = () => {
      if (dragRef.current && engineRef.current) {
        Composite.remove(engineRef.current.world, dragRef.current)
        dragRef.current = null
      }
    }
    const tmove = (e: TouchEvent) => {
      if (!dragRef.current || !e.touches[0]) return
      const p = pos(e.touches[0].clientX, e.touches[0].clientY)
      dragRef.current.pointA.x = p.x
      dragRef.current.pointA.y = p.y
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('touchmove', tmove, { passive: true })
    window.addEventListener('touchend', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('touchmove', tmove)
      window.removeEventListener('touchend', up)
    }
  }, [])

  // ── Layout text as static bodies ──
  const doLayout = async () => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    try {
      await document.fonts.load(FONT)
    } catch {
      /* noop */
    }

    const engine = getEngine()

    Composite.clear(engine.world, false)
    dragRef.current = null
    physRef.current = false

    const w = wrap.clientWidth
    if (w === 0) return

    canvas.width = w
    canvas.height = 100
    const ctx = canvas.getContext('2d')!
    ctx.font = FONT

    const maxW = w - PAD * 2
    const words = text.split(' ')

    let lineCount = 1
    let tx = 0
    for (let i = 0; i < words.length; i++) {
      const ww = ctx.measureText(words[i]).width
      const sw = i < words.length - 1 ? ctx.measureText(' ').width : 0
      if (tx + ww > maxW && tx > 0) {
        lineCount++
        tx = 0
      }
      tx += ww + sw
    }

    const h = Math.max(500, PAD * 2 + lineCount * LINE_HEIGHT + 300)
    canvas.width = w
    canvas.height = h
    ctx.font = FONT

    // Collision group: chain links don't collide with each other
    const group = Body.nextGroup(true)
    const list: CB[] = []
    let x = PAD
    let y = PAD + FONT_SIZE

    // IMPORTANT: create as dynamic first, then setStatic(true).
    // Matter.js 0.20 bug: creating with isStatic:true in options
    // doesn't save _original mass, so setStatic(false) later fails.
    const bOpts: Matter.IChamferableBodyDefinition = {
      restitution: 0.05,
      friction: 0.3,
      frictionAir: 0.05,
      density: 0.002,
      collisionFilter: { group },
    }

    const makeBody = (bx: number, by: number, bw: number, bh: number) => {
      const body = Bodies.rectangle(bx, by, bw, bh, bOpts)
      Body.setStatic(body, true)
      return body
    }

    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi]
      const wordW = ctx.measureText(word).width

      if (x - PAD + wordW > maxW && x > PAD) {
        x = PAD
        y += LINE_HEIGHT
      }

      for (const c of word) {
        const cw = ctx.measureText(c).width
        const body = makeBody(x + cw / 2, y, Math.max(cw, 8), FONT_SIZE + 4)
        list.push({ ch: c, body, w: cw })
        Composite.add(engine.world, body)
        x += cw
      }

      if (wi < words.length - 1) {
        const sw = ctx.measureText(' ').width
        const body = makeBody(x + sw / 2, y, Math.max(sw, 8), FONT_SIZE + 4)
        list.push({ ch: ' ', body, w: sw })
        Composite.add(engine.world, body)
        x += sw
      }
    }

    // Walls
    const wt = 50
    Composite.add(engine.world, [
      Bodies.rectangle(w / 2, h + wt / 2, w * 2, wt, { isStatic: true }),
      Bodies.rectangle(-wt / 2, h / 2, wt, h * 3, { isStatic: true }),
      Bodies.rectangle(w + wt / 2, h / 2, wt, h * 3, { isStatic: true }),
    ])

    listRef.current = list
    setRendered(true)
    setPhysOn(false)
  }

  // ── Activate physics ──
  const goPhysics = () => {
    if (physRef.current || !listRef.current.length) return
    physRef.current = true
    setPhysOn(true)

    const engine = getEngine()
    const list = listRef.current

    for (const { body } of list) Body.setStatic(body, false)

    // Rope constraints: use actual distance for same-line,
    // shorter length for cross-line to create rope feel
    const avgW = list.reduce((s, c) => s + c.w, 0) / list.length
    for (let i = 0; i < list.length - 1; i++) {
      const posA = list[i].body.position
      const posB = list[i + 1].body.position
      const dist = Math.sqrt(
        (posB.x - posA.x) ** 2 + (posB.y - posA.y) ** 2,
      )
      // cross-line links get shorter constraint → pulls into rope
      const isCrossLine = dist > avgW * 3
      Composite.add(
        engine.world,
        Constraint.create({
          bodyA: list[i].body,
          bodyB: list[i + 1].body,
          length: isCrossLine ? avgW * 2 : dist,
          stiffness: isCrossLine ? 0.2 : 0.5,
          damping: 0.08,
        }),
      )
    }
  }

  // ── Canvas pointer down ──
  const onDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (!listRef.current.length) return
    e.preventDefault()

    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX
    const cy = 'touches' in e ? e.touches[0].clientY : e.clientY
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = cx - rect.left
    const my = cy - rect.top

    if (!physRef.current) goPhysics()

    // find nearest body within 60px
    let best: Matter.Body | null = null
    let bestD = 60
    for (const { body } of listRef.current) {
      const d = Math.hypot(body.position.x - mx, body.position.y - my)
      if (d < bestD) {
        bestD = d
        best = body
      }
    }

    if (best) {
      const c = Constraint.create({
        pointA: { x: mx, y: my },
        bodyB: best,
        pointB: { x: 0, y: 0 },
        length: 0.01,
        stiffness: 0.1,
        damping: 0.01,
      })
      Composite.add(getEngine().world, c)
      dragRef.current = c
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="title">
          String <em>String</em>
        </h1>
        <p className="subtitle">Type words. Pull the thread.</p>
      </header>

      <section className="input-section">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder="Enter text here..."
        />
        <div className="actions">
          <button className="btn primary" onClick={doLayout}>
            Render
          </button>
          {physOn && (
            <button className="btn ghost" onClick={doLayout}>
              Reset
            </button>
          )}
        </div>
      </section>

      <section className="canvas-section" ref={wrapRef}>
        <canvas ref={canvasRef} onMouseDown={onDown} onTouchStart={onDown} />
        {rendered && !physOn && <div className="canvas-hint">click &amp; drag to unleash</div>}
        {!rendered && <div className="canvas-placeholder">enter text above and click render</div>}
      </section>
    </div>
  )
}
