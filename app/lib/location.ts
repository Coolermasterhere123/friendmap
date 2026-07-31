/**
 * Location bridge — uses native Capacitor background GPS when running
 * as an Android/iOS app, falls back to browser geolocation on web.
 */

export type LocationUpdate = {
  lat: number
  lng: number
  accuracy: number
  heading: number | null
  speed: number | null
}

type LocationCallback = (update: LocationUpdate) => void

let browserWatchId: number | null = null
let forceInterval: ReturnType<typeof setInterval> | null = null

function isCapacitor(): boolean {
  return typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.()
}

export async function startLocationWatch(
  onUpdate: LocationCallback,
  onError: (msg: string) => void
): Promise<() => void> {
  if (isCapacitor()) {
    return startNativeWatch(onUpdate, onError)
  } else {
    return startBrowserWatch(onUpdate, onError)
  }
}

async function startNativeWatch(
  onUpdate: LocationCallback,
  onError: (msg: string) => void
): Promise<() => void> {
  try {
    // Use default import then access the plugin — avoids named export type issue
    const BgGeo = await import('@capacitor-community/background-geolocation')
    const plugin = (BgGeo.default ?? BgGeo) as any

    let watcherId: string | null = null

    await plugin.addWatcher(
      {
        backgroundMessage: 'FriendMap is sharing your location with your group.',
        backgroundTitle: 'FriendMap',
        requestPermissions: true,
        stale: false,
        distanceFilter: 10,
      },
      (location: any, error: any) => {
        if (error) {
          if (error.code === 'NOT_AUTHORIZED') {
            onError('Location permission denied. Please enable in Settings.')
          } else {
            onError(`Location error: ${error.message}`)
          }
          return
        }
        if (location) {
          onUpdate({
            lat: location.latitude,
            lng: location.longitude,
            accuracy: location.accuracy ?? 0,
            heading: location.bearing ?? null,
            speed: location.speed ?? null,
          })
        }
      }
    ).then((id: string) => { watcherId = id })

    return async () => {
      if (watcherId) {
        await plugin.removeWatcher({ id: watcherId })
      }
    }
  } catch (e) {
    console.warn('BackgroundGeolocation not available, falling back to browser GPS', e)
    return startBrowserWatch(onUpdate, onError)
  }
}

function startBrowserWatch(
  onUpdate: LocationCallback,
  onError: (msg: string) => void
): Promise<() => void> {
  return new Promise(resolve => {
    if (!navigator.geolocation) {
      onError('Geolocation not supported by your browser.')
      resolve(() => {})
      return
    }

    function startWatch() {
      browserWatchId = navigator.geolocation.watchPosition(
        pos => {
          onUpdate({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            heading: pos.coords.heading,
            speed: pos.coords.speed,
          })
        },
        err => onError(`Location error: ${err.message}`),
        { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 }
      )
    }

    startWatch()

    // Force re-poll every 60s — fixes iOS Safari killing watchPosition silently
    forceInterval = setInterval(() => {
      if (browserWatchId !== null) navigator.geolocation.clearWatch(browserWatchId)
      startWatch()
    }, 60_000)

    resolve(() => {
      if (browserWatchId !== null) navigator.geolocation.clearWatch(browserWatchId)
      if (forceInterval) clearInterval(forceInterval)
    })
  })
}
