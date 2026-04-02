import Matter from 'matter-js'
import { SoundFX } from './SoundFX'

const { Bodies, Body, Composite, Constraint } = Matter

const SHIP_SIZE = 16
const BULLET_SPEED = 12
const BULLET_TRAIL = 10
const SHIP_SPEED = 4
const INVINCIBLE_TIME = 5000 // ms
const MAX_SHAPES_PC = 5
const MAX_SHAPES_MOBILE = 3
const SHAPE_SPAWN_INTERVAL = 3000 // ms
const TEXT_DROP_INTERVAL = 4000 // ms
const DROP_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'

interface Bullet { x: number; y: number; dx: number; dy: number; trail: { x: number; y: number }[] }
interface FallingText { body: Matter.Body; ch: string; w: number; free: boolean }
interface FighterShape { body: Matter.Body; size: number; kind: string }
interface EnemyGrenade { body: Matter.Body; fuse: number }
// laser turret: stationary emitter, fires at ship, self-destructs after shotsLeft=0
interface LaserTurret { x: number; y: number; shotsLeft: number; stunned: boolean; lastFire: number }
interface EnemyBullet { x: number; y: number; dx: number; dy: number; trail: { x: number; y: number }[]; life: number }
interface Explosion { x: number; y: number; t: number; r: number }

const GRENADE_DROP_INTERVAL = 6000
const TURRET_SPAWN_INTERVAL = 5000
const TURRET_FIRE_INTERVAL = 2500
const TURRET_BULLET_SPEED = 6
const MAX_TURRETS_PC = 5
const MAX_TURRETS_MOBILE = 3
const EXPLOSION_RADIUS = 100
const MAX_LIVES = 5
const ENERGY_CHARGE_TIME = 60000 // 60s per bar
const MAX_ENERGY = 3
const ULTIMATE_RADIUS_RATIO = 0.33 // 1/3 of screen diagonal
const POWERUP_SPAWN_INTERVAL = 8000

interface Powerup { x: number; y: number; kind: 'heal' | 'shield'; spawnTime: number }

export interface FighterState {
  active: boolean
  x: number; y: number; angle: number
  vx: number; vy: number
  lives: number; score: number
  invincibleUntil: number
  shieldUntil: number // shield powerup active
  energy: number // 0 to MAX_ENERGY (fractional)
  bullets: Bullet[]
  shapes: FighterShape[]
  fallingTexts: FallingText[]
  enemyGrenades: EnemyGrenade[]
  turrets: LaserTurret[]
  enemyBullets: EnemyBullet[]
  explosions: Explosion[]
  powerups: Powerup[]
  lastShapeSpawn: number
  lastTextDrop: number
  lastGrenadeDrop: number
  lastTurretSpawn: number
  lastPowerupSpawn: number
  gameOver: boolean
  keys: { up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean; ultimate: boolean }
  lastFireTime: number
  joyAngle: number; joyMag: number
  startTime: number
}

export function createFighterState(): FighterState {
  return {
    active: false,
    x: 0, y: 0, angle: -Math.PI / 2,
    vx: 0, vy: 0,
    lives: 3, score: 0,
    invincibleUntil: 0,
    bullets: [],
    shapes: [],
    fallingTexts: [],
    enemyGrenades: [],
    turrets: [],
    enemyBullets: [],
    explosions: [],
    powerups: [],
    lastShapeSpawn: 0,
    lastTextDrop: 0,
    lastGrenadeDrop: 0,
    lastTurretSpawn: 0,
    lastPowerupSpawn: 0,
    gameOver: false,
    keys: { up: false, down: false, left: false, right: false, fire: false, ultimate: false },
    lastFireTime: 0,
    joyAngle: 0, joyMag: 0,
    startTime: 0,
    shieldUntil: 0, energy: 0.5,
  }
}

export function initFighter(state: FighterState, cw: number, ch: number, engine: Matter.Engine, isMobile: boolean) {
  state.active = true
  state.x = cw / 2; state.y = ch / 2
  state.angle = -Math.PI / 2
  state.vx = 0; state.vy = 0
  state.lives = 3; state.score = 0
  state.invincibleUntil = performance.now() + 2000
  state.shieldUntil = 0; state.energy = 0.5
  state.bullets = []; state.enemyGrenades = []; state.turrets = []
  state.enemyBullets = []; state.explosions = []; state.powerups = []
  state.gameOver = false
  const now = performance.now()
  state.startTime = now
  state.lastShapeSpawn = now; state.lastTextDrop = now
  state.lastGrenadeDrop = now; state.lastTurretSpawn = now
  state.lastPowerupSpawn = now; state.lastFireTime = 0

  // create hint text as physics bodies pinned in center, drop after 1s
  const hintText = isMobile ? 'JOYSTICK MOVE  FIRE SHOOT  ULT ULTIMATE' : 'WASD MOVE  J SHOOT  SPACE ULTIMATE  ESC EXIT'
  const hintGroup = Body.nextGroup(true)
  const hintChars: FallingText[] = []
  const charW = 9
  const startX = cw / 2 - (hintText.length * charW) / 2
  const hintY = ch / 2 + 60
  for (let i = 0; i < hintText.length; i++) {
    const body = Bodies.rectangle(startX + i * charW + charW / 2, hintY, charW, 14, {
      restitution: 0.3, friction: 0.3, frictionAir: 0.02, density: 0.002,
      collisionFilter: { group: hintGroup },
    })
    Body.setStatic(body, true)
    Body.setStatic(body, false) // workaround for mass
    Composite.add(engine.world, body)
    // pin it
    const pin = Constraint.create({ pointA: { x: body.position.x, y: body.position.y }, bodyB: body, pointB: { x: 0, y: 0 }, length: 0, stiffness: 0.8, damping: 0.3 })
    Composite.add(engine.world, pin)
    hintChars.push({ body, ch: hintText[i], w: charW, free: false })
  }
  // rope connect hint chars
  for (let i = 0; i < hintChars.length - 1; i++) {
    Composite.add(engine.world, Constraint.create({
      bodyA: hintChars[i].body, bodyB: hintChars[i + 1].body, length: charW, stiffness: 0.5, damping: 0.08,
    }))
  }
  state.fallingTexts.push(...hintChars)
  // schedule pin release after 1s
  setTimeout(() => {
    const allC = Composite.allConstraints(engine.world)
    for (let ci = allC.length - 1; ci >= 0; ci--) {
      for (const hc of hintChars) {
        if (allC[ci].bodyA === hc.body || allC[ci].bodyB === hc.body) {
          // only remove pin constraints (length=0), keep rope constraints
          if (allC[ci].length === 0) Composite.remove(engine.world, allC[ci])
        }
      }
    }
    for (const hc of hintChars) hc.free = true
  }, 1000)
}

export function updateFighter(
  state: FighterState,
  _dt: number,
  cw: number, ch: number, floorH: number,
  isMobile: boolean,
  engine: Matter.Engine,
  sfx: SoundFX,
  // existing text lines for collision
  lines: { chars: { body: Matter.Body; ch: string; w: number }[]; released: boolean; pins: Matter.Constraint[] }[],
  releasePinOnBody: (body: Matter.Body) => void,
) {
  if (state.gameOver) return
  const now = performance.now()
  const floorY = ch - floorH

  // ── ship movement ──
  const { keys } = state
  let ax = 0, ay = 0
  if (isMobile && state.joyMag > 0.1) {
    ax = Math.cos(state.joyAngle) * state.joyMag * SHIP_SPEED * 0.15
    ay = Math.sin(state.joyAngle) * state.joyMag * SHIP_SPEED * 0.15
    state.angle = state.joyAngle
  } else {
    if (keys.up) ay -= SHIP_SPEED * 0.15
    if (keys.down) ay += SHIP_SPEED * 0.15
    if (keys.left) ax -= SHIP_SPEED * 0.15
    if (keys.right) ax += SHIP_SPEED * 0.15
    // smooth angle rotation instead of snapping to 90° increments
    if (ax !== 0 || ay !== 0) {
      const target = Math.atan2(ay, ax)
      let diff = target - state.angle
      // normalize to [-PI, PI]
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      state.angle += diff * 0.15 // lerp
    }
  }
  state.vx = state.vx * 0.92 + ax
  state.vy = state.vy * 0.92 + ay
  state.x += state.vx; state.y += state.vy
  // clamp to canvas
  state.x = Math.max(20, Math.min(cw - 20, state.x))
  state.y = Math.max(20, Math.min(floorY - 20, state.y))

  // ── energy charge: 1 bar per 60s ──
  state.energy = Math.min(MAX_ENERGY, 0.5 + (now - state.startTime) / ENERGY_CHARGE_TIME)

  // ── ultimate (space) ──
  if (keys.ultimate && state.energy >= 1) {
    state.energy = Math.floor(state.energy) - 1 + (state.energy % 1) // consume 1 bar
    const radius = Math.sqrt(cw * cw + ch * ch) * ULTIMATE_RADIUS_RATIO
    state.explosions.push({ x: state.x, y: state.y, t: 0, r: radius })
    sfx.shatter()
    // destroy everything in radius
    for (let si = state.shapes.length - 1; si >= 0; si--) {
      if (Math.hypot(state.shapes[si].body.position.x - state.x, state.shapes[si].body.position.y - state.y) < radius) {
        Composite.remove(engine.world, state.shapes[si].body); state.shapes.splice(si, 1); state.score += 10
      }
    }
    for (let ti = state.turrets.length - 1; ti >= 0; ti--) {
      if (Math.hypot(state.turrets[ti].x - state.x, state.turrets[ti].y - state.y) < radius) {
        state.turrets.splice(ti, 1); state.score += 10
      }
    }
    for (let gi = state.enemyGrenades.length - 1; gi >= 0; gi--) {
      if (Math.hypot(state.enemyGrenades[gi].body.position.x - state.x, state.enemyGrenades[gi].body.position.y - state.y) < radius) {
        Composite.remove(engine.world, state.enemyGrenades[gi].body); state.enemyGrenades.splice(gi, 1)
      }
    }
    state.enemyBullets = state.enemyBullets.filter(eb => Math.hypot(eb.x - state.x, eb.y - state.y) > radius)
    for (let fi = state.fallingTexts.length - 1; fi >= 0; fi--) {
      const ft = state.fallingTexts[fi]
      if (Math.hypot(ft.body.position.x - state.x, ft.body.position.y - state.y) < radius) {
        Composite.remove(engine.world, ft.body); state.fallingTexts.splice(fi, 1); state.score += 1
      }
    }
    // also blast existing text
    for (const line of lines) {
      for (const { body } of line.chars) {
        const d = Math.hypot(body.position.x - state.x, body.position.y - state.y)
        if (d < radius) {
          releasePinOnBody(body)
          const a = Math.atan2(body.position.y - state.y, body.position.x - state.x)
          Body.setVelocity(body, { x: Math.cos(a) * 10, y: Math.sin(a) * 10 })
        }
      }
    }
    keys.ultimate = false // consume input
  }

  // ── fire (j key / mobile fire btn) ──
  if (keys.fire && now - state.lastFireTime > 120) {
    state.lastFireTime = now
    const cos = Math.cos(state.angle), sin = Math.sin(state.angle)
    state.bullets.push({
      x: state.x + cos * SHIP_SIZE, y: state.y + sin * SHIP_SIZE,
      dx: cos * BULLET_SPEED, dy: sin * BULLET_SPEED,
      trail: [],
    })
    sfx.laser()
  }

  // ── update bullets ──
  for (let bi = state.bullets.length - 1; bi >= 0; bi--) {
    const b = state.bullets[bi]
    b.x += b.dx; b.y += b.dy
    b.trail.push({ x: b.x, y: b.y })
    if (b.trail.length > BULLET_TRAIL) b.trail.shift()
    // off screen
    if (b.x < -20 || b.x > cw + 20 || b.y < -20 || b.y > ch + 20) {
      state.bullets.splice(bi, 1); continue
    }
    // hit existing text
    let consumed = false
    for (const line of lines) {
      for (let ci = line.chars.length - 1; ci >= 0; ci--) {
        const { body } = line.chars[ci]
        if (Math.hypot(body.position.x - b.x, body.position.y - b.y) < 20) {
          // release pin on this char + neighbors so it can actually move
          // release pins on this char + 2 neighbors each side
          for (let n = Math.max(0, ci - 2); n <= Math.min(line.chars.length - 1, ci + 2); n++) {
            releasePinOnBody(line.chars[n].body)
          }
          // remove ALL constraints touching this body
          const allC = Composite.allConstraints(engine.world)
          for (let ci2 = allC.length - 1; ci2 >= 0; ci2--) {
            if (allC[ci2].bodyA === body || allC[ci2].bodyB === body) {
              Composite.remove(engine.world, allC[ci2])
            }
          }
          Body.setVelocity(body, { x: b.dx * 1.5, y: b.dy * 1.5 })
          sfx.laserHit()
          consumed = true; break
        }
      }
      if (consumed) break
    }
    // hit falling texts
    if (!consumed) {
      for (let fi = state.fallingTexts.length - 1; fi >= 0; fi--) {
        const ft = state.fallingTexts[fi]
        if (Math.hypot(ft.body.position.x - b.x, ft.body.position.y - b.y) < 20) {
          if (ft.free) {
            // destroy it
            Composite.remove(engine.world, ft.body)
            state.fallingTexts.splice(fi, 1)
            state.score += 1
            sfx.pop()
          } else {
            // detach it
            ft.free = true
            Body.setVelocity(ft.body, { x: b.dx * 0.5, y: b.dy * 0.5 })
            sfx.laserHit()
          }
          consumed = true; break
        }
      }
    }
    // hit shapes
    if (!consumed) {
      for (let si = state.shapes.length - 1; si >= 0; si--) {
        const s = state.shapes[si]
        if (Math.hypot(s.body.position.x - b.x, s.body.position.y - b.y) < s.size / 2 + 8) {
          Composite.remove(engine.world, s.body)
          state.shapes.splice(si, 1)
          state.score += 10
          sfx.explosion()
          consumed = true; break
        }
      }
    }
    if (consumed) state.bullets.splice(bi, 1)
  }

  // ── ship collision with shapes ──
  const invincible = now < state.invincibleUntil
  if (!invincible) {
    for (const s of state.shapes) {
      if (Math.hypot(s.body.position.x - state.x, s.body.position.y - state.y) < s.size / 2 + SHIP_SIZE) {
        state.lives--
        state.invincibleUntil = now + INVINCIBLE_TIME
        sfx.explosion()
        if (state.lives <= 0) { state.gameOver = true; return }
        break
      }
    }
    // collision with falling texts
    for (const ft of state.fallingTexts) {
      if (Math.hypot(ft.body.position.x - state.x, ft.body.position.y - state.y) < 18) {
        state.lives--
        state.invincibleUntil = now + INVINCIBLE_TIME
        sfx.explosion()
        if (state.lives <= 0) { state.gameOver = true; return }
        break
      }
    }
    // collision with existing text bodies
    for (const line of lines) {
      let hit = false
      for (const { body } of line.chars) {
        if (Math.hypot(body.position.x - state.x, body.position.y - state.y) < 16) {
          state.lives--; state.invincibleUntil = now + INVINCIBLE_TIME; sfx.explosion()
          if (state.lives <= 0) { state.gameOver = true; return }
          hit = true; break
        }
      }
      if (hit) break
    }
  }

  // ── spawn shapes ──
  const maxShapes = isMobile ? MAX_SHAPES_MOBILE : MAX_SHAPES_PC
  if (now - state.lastShapeSpawn > SHAPE_SPAWN_INTERVAL && state.shapes.length < maxShapes) {
    state.lastShapeSpawn = now
    const size = 30 + Math.random() * 40
    const sx = 40 + Math.random() * (cw - 80)
    const sy = 60 + Math.random() * (floorY - 120)
    // avoid spawning on top of ship
    if (Math.hypot(sx - state.x, sy - state.y) > 80) {
      const kinds = ['circle', 'triangle', 'square']
      const kind = kinds[Math.floor(Math.random() * 3)]
      let body: Matter.Body
      if (kind === 'circle') body = Bodies.circle(sx, sy, size / 2, { isStatic: true })
      else if (kind === 'triangle') { body = Bodies.polygon(sx, sy, 3, size / 2, { isStatic: true }); Body.setAngle(body, -Math.PI / 6) }
      else body = Bodies.rectangle(sx, sy, size, size, { isStatic: true })
      Composite.add(engine.world, body)
      state.shapes.push({ body, size, kind })
    }
  }

  // ── drop falling text ──
  if (now - state.lastTextDrop > TEXT_DROP_INTERVAL) {
    state.lastTextDrop = now
    const count = 1 + Math.floor(Math.random() * 4) // 1-4 chars
    const startX = 40 + Math.random() * (cw - 80)
    const group = Body.nextGroup(true)
    const chars: FallingText[] = []
    for (let i = 0; i < count; i++) {
      const ch = DROP_CHARS[Math.floor(Math.random() * DROP_CHARS.length)]
      const body = Bodies.rectangle(startX + i * 12, -20 - i * 5, 10, 14, {
        restitution: 0.3, friction: 0.3, frictionAir: 0.01, density: 0.002,
        collisionFilter: { group },
      })
      Body.setStatic(body, true)
      Body.setStatic(body, false) // workaround
      Composite.add(engine.world, body)
      chars.push({ body, ch, w: 10, free: count === 1 }) // single chars are free
    }
    // connect as rope if multiple
    if (count > 1) {
      for (let i = 0; i < chars.length - 1; i++) {
        Composite.add(engine.world, Constraint.create({
          bodyA: chars[i].body, bodyB: chars[i + 1].body,
          length: 12, stiffness: 0.5, damping: 0.08,
        }))
      }
    }
    state.fallingTexts.push(...chars)
  }

  // ── clean up fallen texts (below floor) ──
  for (let fi = state.fallingTexts.length - 1; fi >= 0; fi--) {
    if (state.fallingTexts[fi].body.position.y > ch + 50) {
      Composite.remove(engine.world, state.fallingTexts[fi].body)
      state.fallingTexts.splice(fi, 1)
    }
  }

  // ── helper: damage ship with knockback ──
  const damageShip = (fromX: number, fromY: number, force: number) => {
    if (now < state.invincibleUntil) return
    // shield absorbs one hit
    if (now < state.shieldUntil) {
      state.shieldUntil = 0 // shield consumed
      state.invincibleUntil = now + 1000 // brief invincibility
      sfx.pop()
      return
    }
    state.lives--
    state.invincibleUntil = now + INVINCIBLE_TIME
    const a = Math.atan2(state.y - fromY, state.x - fromX)
    state.vx += Math.cos(a) * force; state.vy += Math.sin(a) * force
    state.angle += (Math.random() - 0.5) * 2
    sfx.explosion()
    if (state.lives <= 0) state.gameOver = true
  }

  // ── drop enemy grenades ──
  if (now - state.lastGrenadeDrop > GRENADE_DROP_INTERVAL) {
    state.lastGrenadeDrop = now
    const gx = 60 + Math.random() * (cw - 120)
    const body = Bodies.circle(gx, -20, 8, {
      restitution: 0.2, friction: 0.5, frictionAir: 0.005, density: 0.004, label: 'egrenade',
    })
    // aim toward ship with arc
    const T = 45
    const gPerFrame = 1.5 * 0.001 * 16.67
    Body.setVelocity(body, { x: (state.x - gx) / T, y: (state.y + 20) / T - 0.5 * gPerFrame * T })
    Composite.add(engine.world, body)
    state.enemyGrenades.push({ body, fuse: 0 })
  }

  // ── update enemy grenades ──
  for (let gi = state.enemyGrenades.length - 1; gi >= 0; gi--) {
    const g = state.enemyGrenades[gi]
    g.fuse++
    const speed = Math.hypot(g.body.velocity.x, g.body.velocity.y)
    const hitSomething = g.fuse > 15 && speed < 1.5
    // also explode if near ship
    const nearShip = Math.hypot(g.body.position.x - state.x, g.body.position.y - state.y) < 30
    if (hitSomething || nearShip || g.fuse > 300) {
      const ex = g.body.position.x, ey = g.body.position.y
      state.explosions.push({ x: ex, y: ey, t: 0, r: EXPLOSION_RADIUS })
      sfx.explosion()
      // damage ship if in range
      if (Math.hypot(ex - state.x, ey - state.y) < EXPLOSION_RADIUS) {
        damageShip(ex, ey, 8)
      }
      // scatter nearby text
      for (const line of lines) {
        for (const { body } of line.chars) {
          const d = Math.hypot(body.position.x - ex, body.position.y - ey)
          if (d < EXPLOSION_RADIUS) {
            releasePinOnBody(body)
            const a = Math.atan2(body.position.y - ey, body.position.x - ex)
            Body.applyForce(body, body.position, { x: Math.cos(a) * 0.04, y: Math.sin(a) * 0.04 - 0.02 })
          }
        }
      }
      // destroy shapes in range
      for (let si = state.shapes.length - 1; si >= 0; si--) {
        if (Math.hypot(state.shapes[si].body.position.x - ex, state.shapes[si].body.position.y - ey) < EXPLOSION_RADIUS) {
          Composite.remove(engine.world, state.shapes[si].body)
          state.shapes.splice(si, 1)
        }
      }
      Composite.remove(engine.world, g.body)
      state.enemyGrenades.splice(gi, 1)
    }
  }

  // ── spawn laser turrets ──
  const maxTurrets = isMobile ? MAX_TURRETS_MOBILE : MAX_TURRETS_PC
  if (now - state.lastTurretSpawn > TURRET_SPAWN_INTERVAL && state.turrets.length < maxTurrets) {
    state.lastTurretSpawn = now
    const tx = 50 + Math.random() * (cw - 100)
    const ty = 60 + Math.random() * (floorY - 120)
    if (Math.hypot(tx - state.x, ty - state.y) > 100) {
      state.turrets.push({ x: tx, y: ty, shotsLeft: 3, stunned: false, lastFire: now })
    }
  }

  // ── turret firing ──
  for (let ti = state.turrets.length - 1; ti >= 0; ti--) {
    const t = state.turrets[ti]
    if (now - t.lastFire > TURRET_FIRE_INTERVAL) {
      t.lastFire = now
      if (t.stunned) {
        t.stunned = false // recover from stun, skip this volley
      } else {
        // fire at ship
        const dx = state.x - t.x, dy = state.y - t.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        state.enemyBullets.push({
          x: t.x, y: t.y,
          dx: (dx / d) * TURRET_BULLET_SPEED, dy: (dy / d) * TURRET_BULLET_SPEED,
          trail: [], life: 0,
        })
        sfx.laser()
        t.shotsLeft--
      }
      if (t.shotsLeft <= 0) state.turrets.splice(ti, 1)
    }
  }

  // ── update enemy bullets ──
  for (let bi = state.enemyBullets.length - 1; bi >= 0; bi--) {
    const eb = state.enemyBullets[bi]
    eb.x += eb.dx; eb.y += eb.dy; eb.life++
    eb.trail.push({ x: eb.x, y: eb.y })
    if (eb.trail.length > 12) eb.trail.shift()
    // off screen or too old
    if (eb.x < -30 || eb.x > cw + 30 || eb.y < -30 || eb.y > ch + 30 || eb.life > 300) {
      state.enemyBullets.splice(bi, 1); continue
    }
    // hit ship
    if (Math.hypot(eb.x - state.x, eb.y - state.y) < SHIP_SIZE + 6) {
      damageShip(eb.x, eb.y, 5)
      state.enemyBullets.splice(bi, 1); continue
    }
    // hit text (same as player bullets but no scoring)
    for (const line of lines) {
      for (const { body } of line.chars) {
        if (Math.hypot(body.position.x - eb.x, body.position.y - eb.y) < 16) {
          releasePinOnBody(body)
          Body.setVelocity(body, { x: eb.dx * 0.4, y: eb.dy * 0.4 })
        }
      }
    }
    // hit shapes
    for (let si = state.shapes.length - 1; si >= 0; si--) {
      const s = state.shapes[si]
      if (Math.hypot(s.body.position.x - eb.x, s.body.position.y - eb.y) < s.size / 2 + 6) {
        Composite.remove(engine.world, s.body); state.shapes.splice(si, 1)
        state.enemyBullets.splice(bi, 1); break
      }
    }
  }

  // ── player bullets vs turrets ──
  for (let bi = state.bullets.length - 1; bi >= 0; bi--) {
    const b = state.bullets[bi]
    for (let ti = state.turrets.length - 1; ti >= 0; ti--) {
      const t = state.turrets[ti]
      if (Math.hypot(t.x - b.x, t.y - b.y) < 18) {
        t.stunned = true
        t.shotsLeft--
        sfx.laserHit()
        state.bullets.splice(bi, 1)
        if (t.shotsLeft <= 0) { state.turrets.splice(ti, 1); state.score += 10 }
        break
      }
    }
  }

  // ── player bullets vs enemy grenades ──
  for (let bi = state.bullets.length - 1; bi >= 0; bi--) {
    const b = state.bullets[bi]
    for (let gi = state.enemyGrenades.length - 1; gi >= 0; gi--) {
      const g = state.enemyGrenades[gi]
      if (Math.hypot(g.body.position.x - b.x, g.body.position.y - b.y) < 14) {
        // detonate grenade early
        const ex = g.body.position.x, ey = g.body.position.y
        state.explosions.push({ x: ex, y: ey, t: 0, r: EXPLOSION_RADIUS })
        sfx.explosion()
        Composite.remove(engine.world, g.body)
        state.enemyGrenades.splice(gi, 1)
        state.bullets.splice(bi, 1)
        state.score += 5
        break
      }
    }
  }

  // ── ship collision with enemy grenades (direct contact) ──
  if (now >= state.invincibleUntil) {
    for (const g of state.enemyGrenades) {
      if (Math.hypot(g.body.position.x - state.x, g.body.position.y - state.y) < 20) {
        damageShip(g.body.position.x, g.body.position.y, 6)
        break
      }
    }
  }

  // ── update explosions ──
  for (let ei = state.explosions.length - 1; ei >= 0; ei--) {
    state.explosions[ei].t += 0.016
    if (state.explosions[ei].t > 0.6) state.explosions.splice(ei, 1)
  }

  // ── spawn powerups (only if needed, max 1 of each on field) ──
  const hasHealOnField = state.powerups.some(p => p.kind === 'heal')
  const hasShieldOnField = state.powerups.some(p => p.kind === 'shield')
  if (now - state.lastPowerupSpawn > POWERUP_SPAWN_INTERVAL) {
    state.lastPowerupSpawn = now
    if (state.lives < MAX_LIVES && !hasHealOnField) {
      state.powerups.push({ x: 50 + Math.random() * (cw - 100), y: 60 + Math.random() * (floorY - 120), kind: 'heal', spawnTime: now })
    } else if (now < state.shieldUntil ? false : !hasShieldOnField && state.lives < MAX_LIVES) {
      state.powerups.push({ x: 50 + Math.random() * (cw - 100), y: 60 + Math.random() * (floorY - 120), kind: 'shield', spawnTime: now })
    }
  }

  // ── pickup powerups ──
  for (let pi = state.powerups.length - 1; pi >= 0; pi--) {
    const p = state.powerups[pi]
    if (Math.hypot(p.x - state.x, p.y - state.y) < 24) {
      if (p.kind === 'heal' && state.lives < MAX_LIVES) {
        state.lives = Math.min(MAX_LIVES, state.lives + 1)
        sfx.pop()
      } else if (p.kind === 'shield') {
        state.shieldUntil = now + 15000 // 15s shield
        sfx.pop()
      }
      state.powerups.splice(pi, 1)
    }
    // despawn after 20s
    if (now - p.spawnTime > 20000) state.powerups.splice(pi, 1)
  }
}

export function drawFighter(
  ctx: CanvasRenderingContext2D,
  state: FighterState,
  z: number,
) {
  if (!state.active) return
  const now = performance.now()
  const invincible = now < state.invincibleUntil
  const blink = invincible && Math.floor(now / 100) % 2 === 0

  // ── draw falling texts ──
  ctx.font = '12px "DM Mono", monospace'
  ctx.textBaseline = 'middle'
  for (const ft of state.fallingTexts) {
    ctx.fillStyle = ft.free ? 'rgba(255,200,100,0.8)' : '#f0e6d3'
    ctx.save()
    ctx.translate(ft.body.position.x, ft.body.position.y)
    ctx.rotate(ft.body.angle)
    ctx.fillText(ft.ch, -ft.w / 2, 0)
    ctx.restore()
  }

  // ── draw shapes ──
  for (const s of state.shapes) {
    ctx.fillStyle = 'rgba(232,67,40,0.15)'
    ctx.strokeStyle = 'rgba(232,67,40,0.5)'
    ctx.lineWidth = 2 / z
    if (s.kind === 'circle') {
      ctx.beginPath(); ctx.arc(s.body.position.x, s.body.position.y, s.size / 2, 0, Math.PI * 2)
      ctx.fill(); ctx.stroke()
    } else {
      const v = s.body.vertices; ctx.beginPath(); ctx.moveTo(v[0].x, v[0].y)
      for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x, v[i].y)
      ctx.closePath(); ctx.fill(); ctx.stroke()
    }
  }

  // ── draw powerups ──
  for (const p of state.powerups) {
    const pulse = 0.7 + Math.sin(now * 0.005) * 0.3
    if (p.kind === 'heal') {
      ctx.fillStyle = `rgba(100,255,100,${pulse * 0.4})`; ctx.strokeStyle = `rgba(100,255,100,${pulse * 0.7})`
      ctx.lineWidth = 2 / z; ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.fillStyle = `rgba(100,255,100,${pulse})`; ctx.font = '14px "DM Mono",monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('+', p.x, p.y); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    } else {
      ctx.fillStyle = `rgba(100,200,255,${pulse * 0.3})`; ctx.strokeStyle = `rgba(100,200,255,${pulse * 0.7})`
      ctx.lineWidth = 2 / z; ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.fillStyle = `rgba(100,200,255,${pulse})`; ctx.font = '12px "DM Mono",monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('S', p.x, p.y); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    }
  }

  // ── draw turrets ──
  for (const t of state.turrets) {
    ctx.save(); ctx.translate(t.x, t.y)
    ctx.fillStyle = t.stunned ? 'rgba(255,100,100,0.15)' : 'rgba(255,50,50,0.25)'
    ctx.strokeStyle = t.stunned ? 'rgba(255,100,100,0.3)' : 'rgba(255,50,50,0.6)'
    ctx.lineWidth = 2 / z
    // diamond shape
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(10, 0); ctx.lineTo(0, 12); ctx.lineTo(-10, 0); ctx.closePath()
    ctx.fill(); ctx.stroke()
    // shots indicator
    ctx.fillStyle = 'rgba(255,50,50,0.6)'; ctx.font = `${8}px "DM Mono",monospace`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`${t.shotsLeft}`, 0, 0)
    ctx.restore()
  }

  // ── draw enemy grenades ──
  for (const g of state.enemyGrenades) {
    const p = g.body.position
    ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(80,80,80,0.9)'; ctx.fill()
    ctx.strokeStyle = 'rgba(255,180,50,0.7)'; ctx.lineWidth = 2 / z; ctx.stroke()
    if (g.fuse % 20 > 10) { ctx.fillStyle = 'rgba(255,200,50,0.7)'; ctx.beginPath(); ctx.arc(p.x, p.y - 10, 3, 0, Math.PI * 2); ctx.fill() }
  }

  // ── draw enemy bullets ──
  for (const eb of state.enemyBullets) {
    const tr = eb.trail
    for (let i = 1; i < tr.length; i++) {
      const alpha = i / tr.length
      ctx.strokeStyle = `rgba(255,50,50,${alpha * 0.8})`; ctx.lineWidth = (1 + alpha * 2) / z
      ctx.beginPath(); ctx.moveTo(tr[i - 1].x, tr[i - 1].y); ctx.lineTo(tr[i].x, tr[i].y); ctx.stroke()
    }
    if (tr.length > 0) { const h = tr[tr.length-1]; ctx.fillStyle = 'rgba(255,80,60,0.6)'; ctx.beginPath(); ctx.arc(h.x, h.y, 3 / z, 0, Math.PI * 2); ctx.fill() }
  }

  // ── draw explosions ──
  for (const ex of state.explosions) {
    const p = ex.t / 0.6, alpha = Math.max(0, 1 - p), r = ex.r * p
    if (r > 1) {
      const grad = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r)
      grad.addColorStop(0, `rgba(255,200,50,${alpha * 0.5})`); grad.addColorStop(0.5, `rgba(255,80,20,${alpha * 0.3})`); grad.addColorStop(1, 'rgba(255,30,10,0)')
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = `rgba(255,180,50,${alpha * 0.6})`; ctx.lineWidth = 2 / z; ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.stroke()
    }
  }

  // ── draw player bullets ──
  for (const b of state.bullets) {
    const tr = b.trail
    for (let i = 1; i < tr.length; i++) {
      const alpha = i / tr.length
      ctx.strokeStyle = `rgba(100,255,100,${alpha * 0.8})`
      ctx.lineWidth = (1 + alpha * 2) / z
      ctx.beginPath(); ctx.moveTo(tr[i - 1].x, tr[i - 1].y); ctx.lineTo(tr[i].x, tr[i].y); ctx.stroke()
    }
    if (tr.length > 0) {
      const head = tr[tr.length - 1]
      ctx.fillStyle = 'rgba(100,255,100,0.6)'
      ctx.beginPath(); ctx.arc(head.x, head.y, 3 / z, 0, Math.PI * 2); ctx.fill()
    }
  }

  // ── draw ship ──
  if (!blink) {
    ctx.save()
    ctx.translate(state.x, state.y)
    ctx.rotate(state.angle)
    ctx.fillStyle = invincible ? 'rgba(100,200,255,0.6)' : 'rgba(200,220,255,0.9)'
    ctx.strokeStyle = invincible ? 'rgba(100,200,255,0.4)' : 'rgba(150,180,255,0.7)'
    ctx.lineWidth = 1.5 / z
    // triangle ship shape
    ctx.beginPath()
    ctx.moveTo(SHIP_SIZE, 0)
    ctx.lineTo(-SHIP_SIZE * 0.7, -SHIP_SIZE * 0.6)
    ctx.lineTo(-SHIP_SIZE * 0.4, 0)
    ctx.lineTo(-SHIP_SIZE * 0.7, SHIP_SIZE * 0.6)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
    // engine glow
    if (Math.abs(state.vx) + Math.abs(state.vy) > 0.5) {
      ctx.fillStyle = `rgba(255,150,50,${0.3 + Math.random() * 0.3})`
      ctx.beginPath()
      ctx.moveTo(-SHIP_SIZE * 0.5, -SHIP_SIZE * 0.25)
      ctx.lineTo(-SHIP_SIZE * (0.8 + Math.random() * 0.4), 0)
      ctx.lineTo(-SHIP_SIZE * 0.5, SHIP_SIZE * 0.25)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  // ── shield bubble ──
  if (now < state.shieldUntil) {
    const remaining = (state.shieldUntil - now) / 15000
    ctx.strokeStyle = `rgba(100,200,255,${0.2 + remaining * 0.3})`; ctx.lineWidth = 2 / z
    ctx.setLineDash([4 / z, 3 / z])
    ctx.beginPath(); ctx.arc(state.x, state.y, SHIP_SIZE + 8, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
  }

  // ── HUD: lives + score ──
  // (drawn in world space but we want it fixed — caller should draw in screen space)
}

export function drawFighterHUD(
  ctx: CanvasRenderingContext2D,
  state: FighterState,
  cw: number, ch: number,
  isMobile: boolean,
) {
  if (!state.active) return

  const now = performance.now()
  const topY = isMobile ? 36 : 24

  // Score
  ctx.fillStyle = 'rgba(100,255,100,0.8)'; ctx.font = '16px "DM Mono", monospace'
  ctx.textAlign = 'center'
  ctx.fillText(`SCORE: ${state.score}`, cw / 2, topY)

  // Lives
  ctx.fillStyle = 'rgba(255,100,100,0.8)'; ctx.font = '14px "DM Mono", monospace'
  ctx.textAlign = 'left'
  ctx.fillText('♥'.repeat(state.lives) + '♡'.repeat(MAX_LIVES - state.lives), 12, topY)

  // Shield indicator
  if (now < state.shieldUntil) {
    ctx.fillStyle = 'rgba(100,200,255,0.7)'; ctx.font = '12px "DM Mono", monospace'
    ctx.fillText(`🛡${Math.ceil((state.shieldUntil - now) / 1000)}s`, 12, topY + 18)
  }

  // Energy bars (bottom-left, avoid top-right buttons)
  const barW = 80, barH = 8, barX = 12, barY = topY + 22
  ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(barX, barY, barW, barH)
  const filled = state.energy / MAX_ENERGY
  const barColor = state.energy >= 1 ? 'rgba(100,200,255,0.7)' : 'rgba(100,200,255,0.3)'
  ctx.fillStyle = barColor; ctx.fillRect(barX, barY, barW * filled, barH)
  ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1
  ctx.strokeRect(barX, barY, barW, barH)
  for (let i = 1; i < MAX_ENERGY; i++) {
    const dx = barX + (barW * i / MAX_ENERGY)
    ctx.beginPath(); ctx.moveTo(dx, barY); ctx.lineTo(dx, barY + barH); ctx.stroke()
  }
  ctx.fillStyle = 'rgba(100,200,255,0.5)'; ctx.font = '9px "DM Mono",monospace'
  ctx.textAlign = 'left'
  ctx.fillText(`ULT ${Math.floor(state.energy)}/${MAX_ENERGY}`, barX, barY + barH + 12)

  // Game over
  if (state.gameOver) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, cw, ch)
    ctx.fillStyle = '#f0e6d3'; ctx.font = 'bold 32px "Outfit", sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('GAME OVER', cw / 2, ch / 2 - 30)
    ctx.font = '20px "DM Mono", monospace'; ctx.fillStyle = 'rgba(100,255,100,0.8)'
    ctx.fillText(`Score: ${state.score}`, cw / 2, ch / 2 + 10)
    ctx.font = '14px "Outfit", sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText('Tap to restart · ESC to exit', cw / 2, ch / 2 + 50)
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  }

  if (false) { // hint text is now physics bodies, not HUD text
  }
}

export function cleanupFighter(state: FighterState, engine: Matter.Engine) {
  for (const s of state.shapes) Composite.remove(engine.world, s.body)
  for (const ft of state.fallingTexts) Composite.remove(engine.world, ft.body)
  for (const g of state.enemyGrenades) Composite.remove(engine.world, g.body)
  state.shapes = []; state.fallingTexts = []; state.bullets = []
  state.enemyGrenades = []; state.turrets = []; state.enemyBullets = []; state.explosions = []
  state.active = false
}
