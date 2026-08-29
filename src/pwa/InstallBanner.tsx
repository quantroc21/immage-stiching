import { useState } from 'react'
import { useInstallPrompt } from './useInstallPrompt'

export default function InstallBanner() {
  const { installed, canPromptInstall, promptInstall, showIosInstructions } = useInstallPrompt()
  const [dismissed, setDismissed] = useState(false)

  if (installed || dismissed || (!canPromptInstall && !showIosInstructions)) return null

  return (
    <div className="flex items-center justify-between gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-2 text-xs text-neutral-200">
      {canPromptInstall ? (
        <>
          <span>Cài ứng dụng này vào máy để dùng như app thật — chạy toàn màn hình, mở nhanh hơn.</span>
          <button
            className="flex-shrink-0 rounded bg-white px-3 py-1 font-medium text-neutral-900 hover:bg-neutral-200"
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
        className="flex-shrink-0 text-neutral-500 hover:text-neutral-300"
        onClick={() => setDismissed(true)}
        aria-label="Đóng"
      >
        ×
      </button>
    </div>
  )
}
