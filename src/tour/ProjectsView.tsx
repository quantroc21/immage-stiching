import { useEffect, useState } from 'react'
import { deleteProject, loadProjects, loadScenes, saveProject } from './storage'
import { newId, type Project } from './types'

/**
 * Màn hình đầu tiên: danh sách dự án.
 *
 * Trước đây app chỉ giữ được một tour, nên làm xong một căn là phải xoá sạch
 * mới làm được căn tiếp theo. Mỗi dự án giờ là một toà nhà, một căn hộ, một
 * quán, và các phòng nằm trong đó.
 */

interface Card extends Project {
  rooms: number
  cover: string | null
}

interface Props {
  onOpen: (id: string) => void
}

export default function ProjectsView({ onOpen }: Props) {
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [naming, setNaming] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Project | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Card | null>(null)

  const refresh = async () => {
    const projects = await loadProjects()
    const built: Card[] = []
    for (const p of projects) {
      const scenes = await loadScenes(p.id)
      built.push({
        ...p,
        rooms: scenes.length,
        cover: scenes.length ? URL.createObjectURL(scenes[0].image) : null,
      })
    }
    setCards((old) => {
      old.forEach((c) => c.cover && URL.revokeObjectURL(c.cover))
      return built
    })
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
    // Thu hồi URL ảnh bìa khi rời màn hình.
    return () => setCards((old) => {
      old.forEach((c) => c.cover && URL.revokeObjectURL(c.cover))
      return []
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async () => {
    const name = (naming ?? '').trim()
    if (!name) return
    const id = `p-${newId()}`
    await saveProject({ id, name, createdAt: Date.now() })
    setNaming(null)
    onOpen(id)
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-white">
      <header className="px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-xl font-semibold">Dự án</h1>
        <p className="text-xs text-neutral-500">
          {loading ? 'Đang mở…' : `${cards.length} dự án`}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {!loading && !cards.length && (
          <p className="mt-10 text-center text-sm text-neutral-500">
            Chưa có dự án nào. Tạo cái đầu tiên để bắt đầu.
          </p>
        )}

        <div className="space-y-3">
          {cards.map((c) => (
            <div key={c.id} className="lg flex items-center gap-3 overflow-hidden rounded-2xl p-2">
              <button onClick={() => onOpen(c.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <div className="h-16 w-24 shrink-0 overflow-hidden rounded-xl bg-neutral-900">
                  {c.cover && <img src={c.cover} alt="" className="h-full w-full object-cover" />}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium">{c.name}</p>
                  <p className="text-xs text-neutral-500">{c.rooms} phòng</p>
                </div>
              </button>
              <div className="flex shrink-0 gap-1 pr-1">
                <button
                  onClick={() => setRenaming(c)}
                  aria-label="Đổi tên"
                  className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-white"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
                  </svg>
                </button>
                <button
                  onClick={() => setConfirmDelete(c)}
                  aria-label="Xoá"
                  className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-red-400"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-neutral-800 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <button
          onClick={() => setNaming('')}
          className="w-full rounded-xl bg-white px-4 py-3 text-sm font-semibold text-neutral-900"
        >
          + Dự án mới
        </button>
      </div>

      {naming !== null && (
        <Prompt
          title="Dự án mới"
          value={naming}
          onChange={setNaming}
          onCancel={() => setNaming(null)}
          onDone={create}
          action="Tạo"
        />
      )}

      {renaming && (
        <Prompt
          title="Đổi tên"
          value={renaming.name}
          onChange={(v) => setRenaming({ ...renaming, name: v })}
          onCancel={() => setRenaming(null)}
          action="Lưu"
          onDone={async () => {
            const name = renaming.name.trim()
            if (name) await saveProject({ ...renaming, name })
            setRenaming(null)
            void refresh()
          }}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60 p-4">
          <div className="lg w-full rounded-2xl p-4">
            <p className="font-medium">Xoá &ldquo;{confirmDelete.name}&rdquo;?</p>
            <p className="mt-1 text-sm text-neutral-400">
              Mất toàn bộ {confirmDelete.rooms} phòng bên trong, không lấy lại được.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 rounded-xl bg-neutral-800 px-4 py-3 text-sm font-medium"
              >
                Thôi
              </button>
              <button
                onClick={async () => {
                  await deleteProject(confirmDelete.id)
                  setConfirmDelete(null)
                  void refresh()
                }}
                className="flex-1 rounded-xl bg-red-600 px-4 py-3 text-sm font-medium"
              >
                Xoá
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Prompt({
  title,
  value,
  action,
  onChange,
  onCancel,
  onDone,
}: {
  title: string
  value: string
  action: string
  onChange: (v: string) => void
  onCancel: () => void
  onDone: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 p-4">
      <div className="lg w-full rounded-2xl p-4">
        <p className="font-medium">{title}</p>
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onDone()}
          placeholder="Ví dụ: Căn hộ Quận 7"
          className="mt-3 w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm outline-none ring-1 ring-white/10 focus:ring-white/30"
        />
        <div className="mt-3 flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-xl bg-neutral-800 px-4 py-3 text-sm font-medium">
            Thôi
          </button>
          <button
            onClick={onDone}
            disabled={!value.trim()}
            className="flex-1 rounded-xl bg-white px-4 py-3 text-sm font-medium text-neutral-900 disabled:opacity-40"
          >
            {action}
          </button>
        </div>
      </div>
    </div>
  )
}
