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
    <div className="flex gap-2 overflow-x-auto border-t border-neutral-800 bg-neutral-950/95 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {scenes.map((scene, index) => {
        const active = scene.id === currentSceneId
        return (
          <button
            key={scene.id}
            onClick={() => onSelect(scene.id)}
            className={`relative shrink-0 overflow-hidden rounded-lg border-2 transition ${
              active ? 'border-white' : 'border-transparent opacity-70'
            }`}
            style={{ width: 104 }}
          >
            <img src={scene.url} alt="" className="h-16 w-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1.5 py-1 text-left text-[11px] font-medium text-white">
              {index + 1}. {scene.name}
            </span>
            {scene.hotspots.length > 0 && (
              <span className="absolute right-1 top-1 rounded bg-black/70 px-1 text-[10px] text-neutral-400">
                {scene.hotspots.length} ↗
              </span>
            )}
          </button>
        )
      })}

      {editable && (
        <button
          onClick={onAdd}
          className="flex h-16 w-[104px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border-2 border-dashed border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
        >
          <span className="text-xl leading-none">+</span>
          <span className="text-[11px]">Thêm phòng</span>
        </button>
      )}
    </div>
  )
}
