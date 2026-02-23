import { create } from 'zustand';

export interface CameraTarget {
  position: [number, number, number];
  lookAt: [number, number, number];
  requestId: number;
}

interface CameraState {
  pendingTarget: CameraTarget | null;
  isAnimating: boolean;

  flyTo: (position: [number, number, number], lookAt: [number, number, number]) => void;
  completeAnimation: () => void;
}

export const DEFAULT_CAMERA_POSITION: [number, number, number] = [18, 16, 18];
export const DEFAULT_CAMERA_TARGET: [number, number, number] = [0, 1, 0];

// #52: Incrementing counter prevents collision on sub-ms flyTo() calls
let nextRequestId = 1;

export const useCameraStore = create<CameraState>((set) => ({
  pendingTarget: null,
  isAnimating: false,

  flyTo: (position, lookAt) =>
    set({
      pendingTarget: { position, lookAt, requestId: nextRequestId++ },
      isAnimating: true,
    }),

  completeAnimation: () =>
    set({ pendingTarget: null, isAnimating: false }),
}));
