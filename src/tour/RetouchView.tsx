import { useEffect, useRef, useState } from 'react'
import type { PannellumViewerInstance } from '../types/pannellum'
import { applyRetouch, type RetouchTool } from './retouch'

/**
 * Sửa tay trên tấm toàn cảnh đã ghép.
 *
 * Tô ngay trên khung nhìn 3D chứ không phải trên ảnh phẳng: ảnh equirect kéo
 * giãn dữ dội ở gần trần và sàn, nên chấm đúng chỗ trên đó là bất khả thi.
 * Pannellum cho biết mỗi điểm chạm ứng với góc nào, từ góc quy ra hàng/cột.
 *
 * Cỡ cọ cũng đổi theo cách ấy: lấy thêm một điểm cách con trỏ đúng bán kính
 * cọ tính bằng pixel màn hình, quy cả hai ra toạ độ ảnh rồi đo khoảng cách.
 * Nhờ vậy cọ luôn to bằng đúng chỗ nó phủ trên màn hình, dù đang phóng to hay
 * đang nhìn lên trần.
 */

const TOOLS: { id: RetouchTool; label: string }[] = [
  { id: 'erase', label: 'Xoá' },
  { id: 'smooth', label: 'Mịn' },
  { id: 'sharpen', label: 'Rõ' },
]

interface Props {
  name: string
  image: Blob
  onSave: (image: Blob) => void
  onCancel: () => void
}

/** Một bước hoàn tác: chỉ lưu vùng đã đổi, không lưu cả tấm 33MB. */
interface Undo {
  x: number
  y: number
  w: number
  h: number
  data: ImageData
}

export default function RetouchView({ name, image, onSave, onCancel }: Props) {
  const holder = useRef<HTMLDivElement>(null)
  const viewer = useRef<PannellumViewerInstance | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const mask = useRef<Uint8Array | null>(null)
  const painting = useRef(false)
  /** Vết cọ đã tô, lưu theo toạ độ MÀN HÌNH để vẽ lại cho người dùng thấy.
   *  Chỉ đúng khi ảnh đứng yên, mà lúc tô thì ảnh không xoay được, nên đủ. */
  const trail = useRef<{ x: number; y: number; r: number }[]>([])
  const touched = useRef(false)
  const overlay = useRef<HTMLCanvasElement>(null)

  const [url, setUrl] = useState<string | null>(null)
  const [tool, setTool] = useState<RetouchTool>('erase')
  const [brush, setBrush] = useState(46)
  const [busy, setBusy] = useState(false)
  /**
   * Xoay và tô là hai chế độ tách hẳn nhau.
   *
   * Bản đầu để lớp phủ bắt mọi thao tác, nên Pannellum không nhận được gì và
   * ảnh không xoay được -- muốn sửa chỗ nào ngoài tầm nhìn ban đầu là chịu.
   * Mặc định là xoay, nhìn cho đúng chỗ đã, rồi bấm nút mới sang tô.
   */
  const [mode, setMode] = useState<'rotate' | 'paint'>('rotate')
  const [undos, setUndos] = useState<Undo[]>([])
  // Hoàn tác hết thì ảnh trở lại như cũ, nên không còn gì để lưu.
  const dirty = undos.length > 0

  // Ảnh gốc vào canvas một lần; mọi nét vẽ sửa thẳng trên canvas này.
  useEffect(() => {
    let dead = false
    let made: string | null = null
    ;(async () => {
      const bmp = await createImageBitmap(image)
      if (dead) return
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      canvas.current = c
      mask.current = new Uint8Array(bmp.width * bmp.height)
      c.toBlob((b) => {
        if (dead || !b) return
        made = URL.createObjectURL(b)
        setUrl(made)
      }, 'image/jpeg', 0.95)
    })()
    return () => {
      dead = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [image])

  useEffect(() => {
    if (!url || !holder.current) return
    viewer.current = window.pannellum.viewer(holder.current, {
      type: 'equirectangular',
      panorama: url,
      autoLoad: true,
      showControls: false,
      compass: false,
      hfov: 70,
      minHfov: 30,
      maxHfov: 100,
      minPitch: -85,
      maxPitch: 85,
      friction: 0.12,
    })
    return () => {
      viewer.current?.destroy()
      viewer.current = null
    }
  }, [url])

  /** Điểm trên màn hình -> cột/hàng trên ảnh equirect. */
  const toImage = (clientX: number, clientY: number) => {
    const v = viewer.current
    const c = canvas.current
    if (!v || !c) return null
    const fake = { clientX, clientY } as MouseEvent
    const coords = v.mouseEventToCoords(fake)
    if (!coords) return null
    const [pitch, yaw] = coords
    return {
      col: ((yaw / 360 + 0.5) * c.width + c.width) % c.width,
      row: Math.max(0, Math.min(c.height - 1, (0.5 - pitch / 180) * c.height)),
    }
  }

  /** Bán kính cọ quy ra pixel ảnh, đo bằng chính phép chiếu của viewer. */
  const brushRadius = (clientX: number, clientY: number) => {
    const a = toImage(clientX, clientY)
    const b = toImage(clientX + brush, clientY)
    const c = canvas.current
    if (!a || !b || !c) return brush
    let dx = Math.abs(a.col - b.col)
    if (dx > c.width / 2) dx = c.width - dx
    const dy = a.row - b.row
    return Math.max(4, Math.min(c.width / 6, Math.hypot(dx, dy)))
  }

  const stamp = (clientX: number, clientY: number) => {
    const c = canvas.current
    const m = mask.current
    const p = toImage(clientX, clientY)
    if (!c || !m || !p) return
    const r = brushRadius(clientX, clientY)
    const cx = Math.round(p.col)
    const cy = Math.round(p.row)
    const ri = Math.ceil(r)
    for (let y = Math.max(0, cy - ri); y <= Math.min(c.height - 1, cy + ri); y++) {
      for (let x = cx - ri; x <= cx + ri; x++) {
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy > r * r) continue
        m[y * c.width + (((x % c.width) + c.width) % c.width)] = 255
      }
    }
    touched.current = true
    trail.current.push({ x: clientX, y: clientY, r: brush })
    drawOverlay(clientX, clientY)
  }

  /** Vòng tròn theo ngón tay, để biết cọ đang phủ tới đâu. */
  const drawOverlay = (clientX?: number, clientY?: number) => {
    const o = overlay.current
    if (!o) return
    const rect = o.getBoundingClientRect()
    if (o.width !== rect.width) o.width = rect.width
    if (o.height !== rect.height) o.height = rect.height
    const g = o.getContext('2d')!
    g.clearRect(0, 0, o.width, o.height)

    // Vết đã tô, để biết mình đã phủ tới đâu.
    if (trail.current.length) {
      g.fillStyle = 'rgba(255,64,64,0.42)'
      for (const t of trail.current) {
        g.beginPath()
        g.arc(t.x - rect.left, t.y - rect.top, t.r, 0, Math.PI * 2)
        g.fill()
      }
    }

    if (clientX === undefined || clientY === undefined) return
    g.strokeStyle = 'rgba(255,255,255,0.95)'
    g.lineWidth = 2
    g.beginPath()
    g.arc(clientX - rect.left, clientY - rect.top, brush, 0, Math.PI * 2)
    g.stroke()
    g.strokeStyle = 'rgba(0,0,0,0.5)'
    g.lineWidth = 1
    g.beginPath()
    g.arc(clientX - rect.left, clientY - rect.top, brush + 1.5, 0, Math.PI * 2)
    g.stroke()
  }

  const finishStroke = async () => {
    const c = canvas.current
    const m = mask.current
    if (!c || !m || !touched.current) return
    touched.current = false
    setBusy(true)
    // Nhường một khung hình để nút hiện trạng thái kịp vẽ trước khi máy bận.
    await new Promise((r) => setTimeout(r, 30))
    try {
      const g = c.getContext('2d')!
      // Hộp bao vùng tô, nới ra để chứa cả phần thuật toán với tới.
      let x0 = c.width
      let y0 = c.height
      let x1 = -1
      let y1 = -1
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (!m[y * c.width + x]) continue
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
      if (x1 >= 0) {
        const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 1.2) + 60
        const bx = Math.max(0, x0 - pad)
        const by = Math.max(0, y0 - pad)
        const bw = Math.min(c.width - bx, x1 - x0 + pad * 2)
        const bh = Math.min(c.height - by, y1 - y0 + pad * 2)
        const before = g.getImageData(bx, by, bw, bh)
        const full = g.getImageData(0, 0, c.width, c.height)
        if (applyRetouch(full, m, tool, 10)) {
          g.putImageData(full, 0, 0)
          setUndos((u) => [...u.slice(-4), { x: bx, y: by, w: bw, h: bh, data: before }])
          await new Promise<void>((res) =>
            c.toBlob(
              (b) => {
                if (b) setUrl((old) => {
                  if (old) URL.revokeObjectURL(old)
                  return URL.createObjectURL(b)
                })
                res()
              },
              'image/jpeg',
              0.95,
            ),
          )
        }
      }
    } finally {
      m.fill(0)
      trail.current = []
      setBusy(false)
      drawOverlay()
    }
  }

  const undo = () => {
    const c = canvas.current
    const last = undos[undos.length - 1]
    if (!c || !last) return
    c.getContext('2d')!.putImageData(last.data, last.x, last.y)
    setUndos((u) => u.slice(0, -1))
    c.toBlob(
      (b) => {
        if (b) setUrl((old) => {
          if (old) URL.revokeObjectURL(old)
          return URL.createObjectURL(b)
        })
      },
      'image/jpeg',
      0.95,
    )
  }

  const save = () => {
    const c = canvas.current
    if (!c) return
    c.toBlob((b) => b && onSave(b), 'image/jpeg', 0.95)
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="relative flex-1">
        <div ref={holder} className="absolute inset-0" />
        <canvas
          ref={overlay}
          className="absolute inset-0 h-full w-full touch-none"
          style={{
            cursor: 'crosshair',
            pointerEvents: mode === 'paint' && !busy ? 'auto' : 'none',
          }}
          onPointerDown={(e) => {
            if (busy) return
            ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
            painting.current = true
            stamp(e.clientX, e.clientY)
          }}
          onPointerMove={(e) => {
            if (busy) return
            if (painting.current) stamp(e.clientX, e.clientY)
            else drawOverlay(e.clientX, e.clientY)
          }}
          onPointerUp={() => {
            painting.current = false
            void finishStroke()
          }}
          onPointerLeave={() => drawOverlay()}
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 px-3 pt-[max(0.6rem,env(safe-area-inset-top))]">
          <div className="lg lg-sheen pointer-events-auto min-w-0 rounded-full px-4 py-2.5">
            <p className="truncate text-sm font-semibold leading-none">{name}</p>
          </div>
          <button
            onClick={onCancel}
            className="lg lg-sheen pointer-events-auto shrink-0 rounded-full px-4 py-2.5 text-sm font-medium"
          >
            Thoát
          </button>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
          <div className="lg pointer-events-auto flex rounded-full p-1 text-sm">
            {(['rotate', 'paint'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setMode(v)}
                className={`rounded-full px-5 py-2 font-medium transition ${
                  mode === v ? 'bg-white text-neutral-900' : 'text-neutral-300'
                }`}
              >
                {v === 'rotate' ? 'Xoay' : 'Tô'}
              </button>
            ))}
          </div>
        </div>

        {busy && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="lg rounded-full px-5 py-3 text-sm font-medium">Đang sửa…</span>
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 bg-neutral-950/95 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
        <div className="flex gap-2">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              className={`flex-1 rounded-xl px-2 py-2.5 text-center text-sm font-medium transition ${
                tool === t.id ? 'bg-white text-neutral-900' : 'bg-neutral-900 text-neutral-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-2 flex items-center gap-3">
          <input
            type="range"
            min={12}
            max={110}
            value={brush}
            onChange={(e) => setBrush(Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <button
            onClick={undo}
            disabled={!undos.length || busy}
            aria-label="Hoàn tác"
            className="shrink-0 rounded-lg bg-neutral-800 p-2.5 disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9h11a5 5 0 0 1 0 10h-6" />
              <path d="M4 9l4-4M4 9l4 4" />
            </svg>
          </button>
          <button
            onClick={save}
            disabled={!dirty || busy}
            className="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
          >
            Lưu
          </button>
        </div>
      </div>
    </div>
  )
}
