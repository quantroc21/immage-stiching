import { useState } from 'react'
import { useInstallPrompt } from './useInstallPrompt'

export default function InstallBanner() {
  const { installed, canPromptInstall, promptInstall, showIosInstructions } = useInstallPrompt()
  const [dismissed, setDismissed] = useState(false)

  if (installed || dismissed || (!canPromptInstall && !showIosInstructions)) return null

  return (
    <div className="flex items-center justify-between gap-3 border-b border-emerald-900 bg-emerald-950/60 px-4 py-2 text-xs text-emerald-200">
      {canPromptInstall ? (
        <>
          <span>Cài ứng dụng này vào máy để dùng như app thật — chạy toàn màn hình, mở nhanh hơn.</span>
          <button
            className="flex-shrink-0 rounded bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-500"
            onClick={promptInstall}
          >
            Cài đặt
          </button>
        </>
      ) : (
        <span>
          Thêm vào Màn hình chính để dùng như app thật: bấm nút Chia sẻ ⬆️ ở Safari, rồi chọn "Thêm vào MH chính".
        </span>
      )}
      <button
        className="flex-shrink-0 text-emerald-400/70 hover:text-emerald-200"
        onClick={() => setDismissed(true)}
        aria-label="Đóng"
      >
        ×
      </button>
    </div>
  )
}
