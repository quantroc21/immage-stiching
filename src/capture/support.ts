export interface CaptureSupport {
  supported: boolean
  reason?: string
}

export function checkCaptureSupport(): CaptureSupport {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { supported: false, reason: 'Trình duyệt này không hỗ trợ truy cập camera (Camera API).' }
  }
  if (typeof WebAssembly === 'undefined') {
    return { supported: false, reason: 'Trình duyệt này không hỗ trợ WebAssembly, cần thiết để ghép ảnh.' }
  }
  if (typeof Worker === 'undefined') {
    return { supported: false, reason: 'Trình duyệt này không hỗ trợ Web Worker, cần thiết để xử lý ảnh không đứng máy.' }
  }
  if (typeof OffscreenCanvas === 'undefined') {
    return { supported: false, reason: 'Trình duyệt này không hỗ trợ OffscreenCanvas, cần thiết để xử lý ảnh trong worker.' }
  }
  return { supported: true }
}
