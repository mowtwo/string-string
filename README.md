# String String

A text physics rope toy — type words, pull the thread.

Each line of text becomes a physical rope chain. Click and drag to unleash gravity, place collision shapes, and watch characters bounce on a trampoline floor.

**[Live Demo](https://mowtwo.github.io/string-string/)**

## Features

- **Text as Rope** — Each line becomes a connected chain of character bodies. Click & drag to activate physics.
- **Collision Shapes** — Draw circles, triangles, and squares on the canvas. Text ropes bounce off them.
- **Trampoline Floor** — Bouncy floor with ripple wave animation on impact. Adjustable restitution (0–2x).
- **FPS Collider** — The FPS counter is a physical object that text collides with.
- **Canvas Zoom & Pan** — Scroll to zoom, right-click drag to pan.
- **Undo/Redo** — Full undo/redo stack for shape operations.
- **Settings Panel** — Bounce strength, floor height, FPS toggle. All saved to localStorage.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Esc` | Drag mode |
| `1` / `2` / `3` | Circle / Triangle / Square tool |
| `Ctrl+Z` | Undo shape |
| `Ctrl+Shift+Z` | Redo shape |
| `Delete` | Remove selected shape |
| `R` | Reset text |
| `+` / `-` | Zoom in / out |
| `0` | Reset zoom |

## Tech Stack

- React 19 + TypeScript
- Vite 8
- Matter.js 0.20 (physics engine)
- Canvas 2D with OffscreenCanvas glyph caching

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
pnpm preview
```

## Notes

This project includes a workaround for a Matter.js 0.20 bug: bodies must be created in dynamic mode first, then set to static via `Body.setStatic(body, true)`. Creating with `isStatic: true` in options causes mass restoration to fail (NaN physics).
