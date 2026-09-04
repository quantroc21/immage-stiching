import type { SceneWithUrl } from './types'

interface SceneStripProps {
  scenes: SceneWithUrl[]
  currentSceneId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  editable: boolean
}

export default function SceneStrip({
  scenes,
  currentSceneId,
  onSelect,
  onAdd,
  editable,
}: SceneStripProps) {
  return (
    /* Không nền: các thẻ phòng nổi thẳng trên ảnh 360. Đổi lại chúng phải tự
       tách khỏi nền, nên mỗi thẻ có bóng đổ riêng và viền tóc sáng. */
    <div className="pointer-events-auto flex gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {scenes.map((scene, index) => {
        const active = scene.id === currentSceneId
        return (
          <button
            key={scene.id}
            onClick={() => onSelect(scene.id)}
            className={`relative shrink-0 overflow-hidden rounded-xl shadow-[0_4px_14px_rgba(0,0,0,0.45)] transition ${
              active
                ? 'ring-2 ring-white'
                : 'opacity-80 ring-1 ring-white/25 hover:opacity-100'
            }`}
            style={{ width: 104 }}
          >
            <img src={scene.url} alt="" className="h-16 w-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-3 text-left text-[11px] font-medium text-white">
              {index + 1}. {scene.name}
            </span>
            {scene.hotspots.length > 0 && (
              <span className="lg absolute right-1 top-1 rounded px-1 text-[10px] text-neutral-200">
                {scene.hotspots.length} ↗
              </span>
            )}
          </button>
        )
      })}

      {editable && (
        <button
          onClick={onAdd}
          className="lg flex h-16 w-[104px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border-dashed text-neutral-300 hover:text-white"
        >
          <span className="text-xl leading-none">+</span>
          <span className="text-[11px]">Thêm phòng</span>
        </button>
      )}
    </div>
  )
}
