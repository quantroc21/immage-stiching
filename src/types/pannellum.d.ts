export interface PannellumHotSpot {
  id?: string
  pitch: number
  yaw: number
  type: 'scene' | 'info'
  text?: string
  sceneId?: string
  targetYaw?: number
  targetPitch?: number
  cssClass?: string
  clickHandlerFunc?: (event: MouseEvent, args: unknown) => void
  clickHandlerArgs?: unknown
}

export interface PannellumSceneConfig {
  type?: 'equirectangular'
  panorama: string
  autoLoad?: boolean
  hotSpots?: PannellumHotSpot[]
  pitch?: number
  yaw?: number
  hfov?: number
  minHfov?: number
  maxHfov?: number
  minPitch?: number
  maxPitch?: number
  friction?: number
  touchPanSpeedCoeffFactor?: number
  showControls?: boolean
  compass?: boolean
  haov?: number
  vaov?: number
  vOffset?: number
  backgroundColor?: [number, number, number]
}

export interface PannellumViewerConfig {
  default?: {
    firstScene?: string
    sceneFadeDuration?: number
    autoLoad?: boolean
  }
  scenes?: Record<string, PannellumSceneConfig>
}

export interface PannellumViewerInstance {
  destroy: () => void
  loadScene: (sceneId: string, pitch?: number, yaw?: number, hfov?: number) => void
  addHotSpot: (hotSpot: PannellumHotSpot, sceneId?: string) => void
  removeHotSpot: (id: string, sceneId?: string) => boolean
  getScene: () => string
  mouseEventToCoords: (event: MouseEvent) => [number, number]
  on: (event: string, handler: (...args: unknown[]) => void) => PannellumViewerInstance
  off: (event: string, handler?: (...args: unknown[]) => void) => PannellumViewerInstance
}

export interface PannellumStatic {
  viewer: (
    container: string | HTMLElement,
    config: PannellumSceneConfig & PannellumViewerConfig,
  ) => PannellumViewerInstance
}

declare global {
  interface Window {
    pannellum: PannellumStatic
  }
}
