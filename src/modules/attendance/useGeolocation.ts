/**
 * Browser geolocation hook. Wraps navigator.geolocation with permission
 * handling, high-accuracy, and a strict readable state machine.
 *
 * States exposed:
 *   idle           - nothing tried yet
 *   requesting     - waiting on the browser prompt / GPS fix
 *   granted        - have coordinates
 *   denied         - permission blocked
 *   unavailable    - no geolocation API in this environment
 *   error          - non-permission failure (timeout, position unavailable)
 */
import { useCallback, useState } from 'react';

export type GeoState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'granted'; latitude: number; longitude: number; accuracy: number }
  | { status: 'denied' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

export function useGeolocation() {
  const [state, setState] = useState<GeoState>({ status: 'idle' });

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ status: 'unavailable' });
      return Promise.resolve<GeoState>({ status: 'unavailable' });
    }
    setState({ status: 'requesting' });
    return new Promise<GeoState>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const next: GeoState = {
            status: 'granted',
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          };
          setState(next);
          resolve(next);
        },
        (err) => {
          const next: GeoState =
            err.code === err.PERMISSION_DENIED
              ? { status: 'denied' }
              : { status: 'error', message: err.message || 'Could not get your location.' };
          setState(next);
          resolve(next);
        },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
      );
    });
  }, []);

  return { state, request };
}
