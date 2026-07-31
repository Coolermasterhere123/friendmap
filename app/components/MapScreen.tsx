'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'

type Props = {
  session: { name: string; room: string; color: string }
  onLeave: () => void
}



type PhotoPin = {
  id: string
  room: string
  lat: number
  lng: number
  member_id: string
  member_name: string
  member_color: string
  photo_url: string
  temperature: string | null
  city: string | null
  created_at: string
}


function getMyId(): string {
  if (typeof window === 'undefined') return 'ssr'
  let id = localStorage.getItem('friendmap_id')
  if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('friendmap_id', id) }
  return id
}

function isNativeApp(): boolean {
  return typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.()
}

// Load markercluster script once and cache the promise
let clusterScriptPromise: Promise<void> | null = null

function loadMarkerClusterScript(): Promise<void> {
  if (clusterScriptPromise) return clusterScriptPromise
  if (typeof window !== 'undefined' && (window as any).L?.MarkerClusterGroup) {
    clusterScriptPromise = Promise.resolve()
    return clusterScriptPromise
  }
  clusterScriptPromise = new Promise<void>((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js'
    script.onload = () => resolve()
    script.onerror = () => resolve() // resolve anyway so app doesn't hang
    document.head.appendChild(script)
  })
  return clusterScriptPromise
}

const ACTIVE_MINUTES = 720  // 12 hours
const TIMEOUT_HOURS = 12    // 12 hours
const EXPIRY_HOURS = 24     // 24 hours

function minutesAgo(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / 60000
}

function isActive(ts: string): boolean { return true } // Never grey out
function isTimedOut(ts: string): boolean { return false } // Never timeout
function isExpired(ts: string): boolean { return minutesAgo(ts) > EXPIRY_HOURS * 60 }

function timeAgo(ts: string): string {
  const m = Math.floor(minutesAgo(ts))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function formatDist(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} meters`
  return `${km.toFixed(1)} km`
}

function formatETA(km: number, speedMs: number | null): string {
  const walkingSpeed = speedMs && speedMs > 0.5 ? speedMs : 1.4
  const seconds = (km * 1000) / walkingSpeed
  const mins = Math.round(seconds / 60)
  if (mins < 1) return '< 1 min walk'
  if (mins === 1) return '~1 min walk'
  return `~${mins} min walk`
}

export default function MapScreen({ session, onLeave }: Props) {
  const MY_ID = useRef(getMyId())

  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const photoPinMarkersRef = useRef<Map<string, any>>(new Map())
  const photoClusterGroupRef = useRef<any>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const supabaseRef = useRef<any>(
    typeof window !== 'undefined'
      ? createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL || '',
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
        )
      : null
  )
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [copied, setCopied] = useState(false)
  const [gpsStatus, setGpsStatus] = useState<'waiting' | 'locked' | 'error'>('waiting')



  // Photo pins
  const [photoPins, setPhotoPins] = useState<PhotoPin[]>([])
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [viewingPhoto, setViewingPhoto] = useState<PhotoPin | null>(null)
  const [pendingUploads, setPendingUploads] = useState(0)
  const [isOnline, setIsOnline] = useState(true) // assume online, check in background

  // Gallery state
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [galleryIndex, setGalleryIndex] = useState(0)

  // Notifications
  const [notification, setNotification] = useState<string | null>(null)

  // Admin / Leave
  const [adminVisible, setAdminVisible] = useState(false)
  const [adminPassword, setAdminPassword] = useState('')
  const [adminUnlocked, setAdminUnlocked] = useState(false)
  const [adminMsg, setAdminMsg] = useState('')
  const [leaveVisible, setLeaveVisible] = useState(false)

  function showNotification(msg: string) {
    setNotification(msg)
    setTimeout(() => setNotification(null), 4000)
  }

  // Safe Supabase helper — returns null if not initialized
  // Note: we attempt reads even if navigator.onLine is uncertain
  function getSb() {
    return supabaseRef.current
  }


  // --- IndexedDB offline photo queue ---
  const DB_NAME = 'friendmap-offline'
  const DB_STORE = 'pending-photos'

  async function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function savePhotoOffline(blob: Blob, lat: number, lng: number) {
    const db = await openDB()
    return new Promise<void>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).add({
          dataUrl: reader.result,
          lat, lng,
          room: session.room,
          member_id: MY_ID.current,
          member_name: session.name,
          member_color: session.color,
          saved_at: new Date().toISOString(),
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
      reader.readAsDataURL(blob)
    })
  }

  async function getPendingPhotos(): Promise<any[]> {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly')
      const req = tx.objectStore(DB_STORE).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function deletePendingPhoto(id: number) {
    const db = await openDB()
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async function refreshPendingCount() {
    try {
      const pending = await getPendingPhotos()
      setPendingUploads(pending.length)
    } catch {}
  }

  async function uploadPendingPhotos() {
    const pending = await getPendingPhotos()
    if (pending.length === 0) return
    showNotification(`📤 Uploading ${pending.length} offline photo${pending.length > 1 ? 's' : ''}...`)

    let uploaded = 0
    for (const item of pending) {
      try {
        // Convert dataUrl back to blob
        const res = await fetch(item.dataUrl)
        const blob = await res.blob()
        const file = new File([blob], `offline-${item.id}-${Date.now()}.jpg`, { type: 'image/jpeg' })

        // Temporarily override myPosRef for the upload
        const savedPos = myPosRef.current
        myPosRef.current = { lat: item.lat, lng: item.lng }

        await uploadPhoto(file)

        myPosRef.current = savedPos
        await deletePendingPhoto(item.id)
        uploaded++
      } catch (err) {
        console.error('Failed to upload pending photo:', err)
      }
    }

    await refreshPendingCount()
    if (uploaded > 0) {
      showNotification(`✅ ${uploaded} offline photo${uploaded > 1 ? 's' : ''} uploaded!`)
    }
  }

  // --- Network monitoring ---
  useEffect(() => {
    refreshPendingCount()

    // Actively test connection - navigator.onLine unreliable on Android WebView
    async function checkConnection(): Promise<boolean> {
      // Use navigator.onLine as primary — only do real fetch if it says online
      if (!navigator.onLine) return false
      try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
        if (!url) return navigator.onLine
        const res = await fetch(url + '/health', {
          method: 'HEAD',
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        })
        return res.status < 500
      } catch {
        return navigator.onLine // fall back to navigator if fetch fails
      }
    }

    // Load data immediately if navigator.onLine says we're connected
    // Then verify with actual request in background
    if (navigator.onLine) {
        loadPhotoPins()
    }

    // Verify real connection in background (don't block map render)
    checkConnection().then(online => {
      setIsOnline(online)
      if (!online && navigator.onLine) {
        // navigator.onLine lied - we're actually offline
        showNotification('📵 No internet connection')
      }
    })

    const handleOnline = async () => {
      const online = await checkConnection()
      if (!online) return
      setIsOnline(true)
      showNotification('📶 Back online — syncing...')
      setTimeout(async () => {
                loadPhotoPins()
        uploadPendingPhotos()
      }, 500)
    }

    const handleOffline = () => {
      setIsOnline(false)
      showNotification('📵 Offline — photos will upload when connected')
    }

    // Poll every 60s as fallback - keep it infrequent to avoid map slowness
    const pollInterval = setInterval(async () => {
      const online = await checkConnection()
      setIsOnline(prev => {
        if (!prev && online) {
          setTimeout(async () => {
                            loadPhotoPins()
            uploadPendingPhotos()
          }, 500)
          showNotification('📶 Back online — syncing...')
        } else if (prev && !online) {
          showNotification('📵 Offline — photos will upload when connected')
        }
        return online
      })
    }, 60_000)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      clearInterval(pollInterval)
    }
  }, [session])

  // Supabase initialized in ref above
  // --- Init Leaflet ---
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return
    import('leaflet').then(L => {
      const map = L.map(mapRef.current!, {
        center: [20, 0],
        zoom: 2,
        zoomControl: true,
        zoomAnimation: false,      // disable zoom animation for better performance
        preferCanvas: true,        // use canvas renderer - much faster than SVG
      })
      // Load tiles - offline overlay will cover map if no connection
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors', maxZoom: 19,
      }).addTo(map)
      mapInstanceRef.current = map
      map.on('dragstart zoomstart', () => { userHasPannedRef.current = true })

      // Load markercluster then set up cluster group
      loadMarkerClusterScript().then(() => {
        const LMC = (window as any).L
        if (!LMC?.MarkerClusterGroup) {
          console.warn('MarkerClusterGroup not available after script load')
          return
        }
        const cg = LMC.markerClusterGroup({
          maxClusterRadius: 80,
          showCoverageOnHover: false,
          zoomToBoundsOnClick: true,
          disableClusteringAtZoom: 13,
          chunkedLoading: true,
          iconCreateFunction: (cluster: any) => {
            const count = cluster.getChildCount()
            const children = cluster.getAllChildMarkers()
            const hasPhotos = children.some((m: any) => m.options.isPhotoPin)
            const hasMembers = children.some((m: any) => !m.options.isPhotoPin)
            const icon = hasPhotos && hasMembers ? '📍' : hasPhotos ? '📸' : '👤'
            return LMC.divIcon({
              className: '',
              html: `<div style="
                width:52px;height:52px;border-radius:50%;
                background:#1e293b;border:3px solid #38bdf8;
                display:flex;flex-direction:column;align-items:center;justify-content:center;
                font-family:system-ui;box-shadow:0 2px 12px rgba(0,0,0,0.6);cursor:pointer;
              ">
                <span style="font-size:18px;font-weight:800;color:#38bdf8;line-height:1;">${count}</span>
                <span style="font-size:11px;margin-top:2px;">${icon}</span>
              </div>`,
              iconSize: [52, 52],
              iconAnchor: [26, 26],
            })
          },
        })
        cg.addTo(map)
        memberClusterGroupRef.current = cg
        photoClusterGroupRef.current = cg
        // Add all markers that were added before cluster was ready
        markersRef.current.forEach(marker => {
          try { cg.addLayer(marker); marker.remove() } catch {}
        })
        photoPinMarkersRef.current.forEach(marker => {
          try { cg.addLayer(marker); marker.remove() } catch {}
        })
      })


    })
    return () => { mapInstanceRef.current?.remove(); mapInstanceRef.current = null }
  }, [])

  // --- Marker HTML ---

  // --- Accuracy circle ---
  // --- Fit all pins ---
  // --- Load members ---
  // --- Load photo pins ---
  const loadPhotoPins = useCallback(async () => {
    // Wait for supabase to init if needed
    let sb = getSb()
    if (!sb) {
      await new Promise(r => setTimeout(r, 500))
      sb = getSb()
    }
    if (!sb) return
    const { data, error } = await sb.from('photo_pins').select('*').eq('room', session.room).order('created_at', { ascending: false })
    if (error) { console.error('loadPhotoPins error:', error); return }
    if (!data) return

    // Update state immediately so gallery works
    setPhotoPins(data)

    // Add to map after both map and cluster are ready
    import('leaflet').then(async L => {
      // Wait for map
      let attempts = 0
      while (!mapInstanceRef.current && attempts < 30) {
        await new Promise(r => setTimeout(r, 200))
        attempts++
      }
      if (!mapInstanceRef.current) return

      // Ensure cluster script loaded
      await loadMarkerClusterScript()

      // Clear existing photo markers
      if (photoClusterGroupRef.current) {
        photoPinMarkersRef.current.forEach(m => {
          try { photoClusterGroupRef.current.removeLayer(m) } catch {}
        })
      } else {
        photoPinMarkersRef.current.forEach(m => m.remove())
      }
      photoPinMarkersRef.current.clear()

      data.forEach((pin: PhotoPin) => renderPhotoPin(pin, L))
    })
  }, [session.room])

, [session.room])

  // --- Upsert self ---
  // Join on mount — just set member ID, network monitoring handles data loading
  useEffect(() => {
    prevMemberIdsRef.current = new Set([MY_ID.current])
  }, [])

  // --- Realtime ---
  useEffect(() => {
    const sb = supabaseRef.current
    if (!sb) return
    // Skip realtime if offline — will reconnect automatically when online
    if (!navigator.onLine) return
    // NOTE: photo_pins needs REPLICA IDENTITY FULL in Supabase for DELETE events to include payload.old
    // Run: ALTER TABLE photo_pins REPLICA IDENTITY FULL;
    const channel = sb.channel(`room-all-${session.room}-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: `room=eq.${session.room}` },
        (payload: any) => {
          const row = (payload.new || payload.old) as any
          if (!row) return
          if (payload.eventType === 'INSERT' && row.id !== MY_ID.current) showNotification(`${row.name} joined the room 👋`)
          setMembers(prev => {
            const next = new Map(prev)
            if (payload.eventType === 'DELETE') {
              next.delete(row.id)
              const m = markersRef.current.get(row.id)
              if (m) {
                if (memberClusterGroupRef.current) memberClusterGroupRef.current.removeLayer(m)
                else m.remove()
                markersRef.current.delete(row.id)
              }
              const c = accuracyCirclesRef.current.get(row.id); if (c) { c.remove(); accuracyCirclesRef.current.delete(row.id) }
            } else { next.set(row.id, row) }
            return next
          })
        })
})
})
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'photo_pins',
        filter: `room=eq.${session.room}`
      },
      (payload: any) => {
        if (payload.eventType === 'INSERT') {
          const pin = payload.new as PhotoPin
          if (!pin) return
          setPhotoPins(prev => [pin, ...prev])
          import('leaflet').then(L => {
            renderPhotoPin(pin, L)
          })
          if (pin.member_id !== MY_ID.current) {
            showNotification(`${pin.member_name} dropped a photo pin 📸`)
          }
        } else if (payload.eventType === 'DELETE') {
          // payload.old may be empty without REPLICA IDENTITY FULL
          // Always reload all photo pins from DB to ensure sync
          const sb = supabaseRef.current
          if (sb) {
            sb.from('photo_pins').select('*').eq('room', session.room).order('created_at', { ascending: false })
              .then(({ data }: any) => {
                if (photoClusterGroupRef.current) {
                  photoPinMarkersRef.current.forEach(m => {
                    try { photoClusterGroupRef.current.removeLayer(m) } catch {}
                  })
                } else {
                  photoPinMarkersRef.current.forEach(m => m.remove())
                }
                photoPinMarkersRef.current.clear()
                if (data) {
                  setPhotoPins(data)
                  import('leaflet').then(L => data.forEach((pin: PhotoPin) => renderPhotoPin(pin, L)))
                } else {
                  setPhotoPins([])
                }
                setViewingPhoto(null)
                setGalleryOpen(false)
              })
          }
          showNotification('Photo removed 🗑️')
        }
      })
      .subscribe()

    channelRef.current = channel

    return () => {
      if (channelRef.current) {
        sb.removeChannel(channelRef.current)
      }
    }
  }, [session.room])

  // ============================================================
  // 🖼️ Stamp image with date, time, temperature, and city
  // ============================================================
  async function stampImage(
    imageFile: File,
    lat: number,
    lng: number
  ): Promise<{ blob: Blob; temperature: string; city: string }> {
    try {
      // 1. Get weather data
      const weatherApiKey = "90ceeb410577bc246e8159e571b5ebff";
      let cityName = 'Unknown';
      let temperature = '--';

      console.log('🌤️ Weather API Key exists:', !!weatherApiKey);
      console.log('📍 Location for weather stamp:', lat, lng);

      // Check if we have valid coordinates (not default 0,0 or London)
      const isDefaultLocation = 
        Math.abs(lat - 51.5) < 0.01 && 
        Math.abs(lng + 0.09) < 0.01;

      if (isDefaultLocation) {
        console.warn('⚠️ Using default London location - GPS not locked!');
        cityName = 'Waiting for GPS...';
        temperature = '--';
      } else if (weatherApiKey && lat && lng) {
        try {
          const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${weatherApiKey}`;
          console.log('🌤️ Fetching weather...');
          
          const weatherResponse = await fetch(weatherUrl);
          console.log('🌤️ Weather response status:', weatherResponse.status);
          
          if (weatherResponse.ok) {
            const weatherData = await weatherResponse.json();
            console.log('🌤️ Weather data received:', weatherData.name, weatherData.main?.temp);
            cityName = weatherData.name || 'Unknown';
            temperature = Math.round(weatherData.main?.temp || 0).toString();
            console.log(`🌤️ City: ${cityName}, Temp: ${temperature}°C`);
          } else {
            const errorText = await weatherResponse.text();
            console.warn('⚠️ Weather API error:', weatherResponse.status, errorText);
          }
        } catch (weatherError) {
          console.warn('⚠️ Weather fetch error:', weatherError);
        }
      } else {
        console.warn('⚠️ Missing weather API key or location');
      }

      // 2. Load image
      const img = await createImageBitmap(imageFile);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');

      // 3. Draw image
      ctx.drawImage(img, 0, 0);

      // 4. Prepare text
      const now = new Date();
      const dateStr = now.toLocaleDateString();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      // Use the actual weather data if available
      const displayTemp = temperature !== '--' ? `${temperature}°C` : '--°C';
      const displayCity = cityName !== 'Unknown' && cityName !== 'Waiting for GPS...' ? cityName : '';
      
      // Build the text with proper spacing
      let text = `📸 ${dateStr} ${timeStr}`;
      if (displayTemp !== '--°C') {
        text += `  🌡️ ${displayTemp}`;
      }
      if (displayCity) {
        text += `  📍 ${displayCity}`;
      }
      
      console.log('📝 Stamp text:', text);

      // 5. Draw text overlay on image
      const fontSize = Math.max(16, Math.min(28, canvas.width / 35));
      ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
      
      const metrics = ctx.measureText(text);
      const padding = fontSize * 0.8;
      const rectWidth = metrics.width + padding * 2;
      const rectHeight = fontSize * 1.8 + padding * 1.5;
      const x = canvas.width - rectWidth - padding;
      const y = canvas.height - rectHeight - padding;

      // Background rectangle (semi-transparent black)
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.beginPath();
      const radius = 10;
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + rectWidth - radius, y);
      ctx.quadraticCurveTo(x + rectWidth, y, x + rectWidth, y + radius);
      ctx.lineTo(x + rectWidth, y + rectHeight - radius);
      ctx.quadraticCurveTo(x + rectWidth, y + rectHeight, x + rectWidth - radius, y + rectHeight);
      ctx.lineTo(x + radius, y + rectHeight);
      ctx.quadraticCurveTo(x, y + rectHeight, x, y + rectHeight - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;

      // Text (white)
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const textX = x + padding;
      const textY = y + rectHeight / 2;
      ctx.fillText(text, textX, textY);

      // 6. Convert to blob and return with metadata
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => {
            if (b) resolve(b);
            else reject(new Error('Failed to create blob'));
          },
          'image/jpeg',
          0.92
        );
      });
      return { blob, temperature, city: cityName };
    } catch (error) {
      console.error('🔥 Error stamping image:', error);
      // Fallback - return original file as blob with no metadata
      const blob = await new Promise<Blob>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(new Blob([reader.result as ArrayBuffer], { type: 'image/jpeg' }))
        reader.readAsArrayBuffer(imageFile)
      })
      return { blob, temperature: '--', city: 'Unknown' };
    }
  }

  // ============================================================
  // 📸 Updated: Photo upload with stamping and GPS check
  // ============================================================
  // Native camera - no confirmation dialog on Android
  async function takeNativePhoto() {
    if (!myPosRef.current) {
      showNotification('📍 Waiting for GPS...')
      return
    }
    setUploadingPhoto(true)
    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
      const photo = await Camera.getPhoto({
        quality: 90,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
        saveToGallery: false,
      })

      if (!photo.dataUrl) return

      // Convert dataUrl to blob
      const res = await fetch(photo.dataUrl)
      const blob = await res.blob()
      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })

      await uploadPhoto(file)
    } catch (err: any) {
      // User cancelled - no error shown
      if (err?.message?.includes('cancelled') || err?.message?.includes('canceled')) return
      showNotification('Camera error: ' + err.message)
    } finally {
      setUploadingPhoto(false)
    }
  }

  // Shared upload function used by both web file picker and native camera
  async function uploadPhoto(file: File) {
    if (!myPosRef.current) {
      showNotification('📍 Location not ready yet — try again in a moment')
      return
    }

    // If offline, save to IndexedDB queue
    if (!navigator.onLine) {
      try {
        const resized = await resizeImage(file, 800)
        await savePhotoOffline(resized, myPosRef.current.lat, myPosRef.current.lng)
        await refreshPendingCount()
        showNotification('📵 Saved offline — will upload when connected')
      } catch (err) {
        showNotification('Failed to save offline: ' + (err as Error).message)
      }
      return
    }

    try {
      const sb = supabaseRef.current
      if (!sb) {
        showNotification('Supabase not initialized')
        return
      }

      // Step 1: Quick resize only — no stamping yet so camera closes fast
      const resizedFile = await resizeImage(file, 1200)
      const fileName = `${MY_ID.current}-${Date.now()}.jpg`
      const lat = myPosRef.current.lat
      const lng = myPosRef.current.lng

      // Step 2: Upload unstamped photo immediately
      const { error: uploadError } = await sb.storage
        .from('photo-pins')
        .upload(fileName, resizedFile, {
          contentType: 'image/jpeg',
          upsert: false,
          cacheControl: '3600',
        })

      if (uploadError) {
        showNotification('Upload failed: ' + uploadError.message)
        return
      }

      const { data: urlData } = sb.storage.from('photo-pins').getPublicUrl(fileName)
      const photo_url = urlData.publicUrl

      // Step 3: Save to DB immediately with no stamp data yet
      const { error: dbError } = await sb.from('photo_pins').insert({
        room: session.room,
        lat, lng,
        member_id: MY_ID.current,
        member_name: session.name,
        member_color: session.color,
        photo_url,
        temperature: null,
        city: null,
      })

      if (dbError) {
        showNotification('Database error: ' + dbError.message)
        return
      }

      // Step 4: Stamp in background — upload stamped version and update DB
      stampImage(resizedFile, lat, lng).then(async (stampResult) => {
        try {
          const stampedFile = new File([stampResult.blob], fileName, { type: 'image/jpeg' })
          await sb.storage.from('photo-pins').upload(fileName, stampedFile, {
            contentType: 'image/jpeg', upsert: true, cacheControl: '3600',
          })
          await sb.from('photo_pins')
            .update({ temperature: stampResult.temperature, city: stampResult.city })
            .eq('member_id', MY_ID.current)
            .eq('photo_url', photo_url)
        } catch {}
      })

      // Try to save to archive, but don't show errors to user
      try {
        const { error: archiveError } = await sb.from('photo_archive').insert({
          room: session.room,
          member_name: session.name,
          member_color: session.color,
          photo_url,
        })
        if (archiveError) {
          console.warn('⚠️ Archive error (non-critical):', archiveError)
        }
      } catch (archiveError) {
        console.warn('⚠️ Archive save failed (non-critical):', archiveError)
      }

      showNotification('📸 Photo pin dropped with stamp!')
    } catch (error) {
      console.error('🔥 Error:', error)
      showNotification('Error: ' + (error as Error).message)
    } finally {
      // uploading state managed by caller
    }
  }

  // Web file picker handler - wraps uploadPhoto
  async function handlePhotoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !myPosRef.current) {
      showNotification('No file selected or location not ready')
      return
    }
    setUploadingPhoto(true)
    try {
      await uploadPhoto(file)
    } finally {
      setUploadingPhoto(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function resizeImage(file: File, maxSize: number): Promise<File> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      
      img.onload = () => {
        URL.revokeObjectURL(url)
        
        let { width, height } = img
        if (width > height) {
          if (width > maxSize) {
            height = Math.round(height * maxSize / width)
            width = maxSize
          }
        } else {
          if (height > maxSize) {
            width = Math.round(width * maxSize / height)
            height = maxSize
          }
        }
        
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Could not get canvas context'))
          return
        }
        
        ctx.drawImage(img, 0, 0, width, height)
        
        const originalFileName = file.name
        
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Failed to create blob'))
            return
          }
          const resizedFile = new File([blob], originalFileName, { type: 'image/jpeg' })
          resolve(resizedFile)
        }, 'image/jpeg', 0.85)
      }
      
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Failed to load image'))
      }
      
      img.src = url
    })
  }

  // Download a photo with stamp burned in
  async function downloadStampedPhoto(pin: PhotoPin) {
    showNotification('⏳ Preparing download...')
    try {
      // Fetch the image
      const res = await fetch(pin.photo_url)
      const blob = await res.blob()
      const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' })

      // Stamp it with known data
      const stampResult = await stampImage(file, pin.lat, pin.lng)

      // Trigger download
      const url = URL.createObjectURL(stampResult.blob)
      const a = document.createElement('a')
      a.href = url
      const date = new Date(pin.created_at).toISOString().slice(0, 10)
      a.download = `friendmap-${pin.member_name}-${date}.jpg`
      a.click()
      URL.revokeObjectURL(url)
      showNotification('✅ Photo downloaded with stamp!')
    } catch (err) {
      showNotification('Download failed: ' + (err as Error).message)
    }
  }

  // ✅ FIXED: Delete function with proper deletion
  async function deletePhotoPin(pin: PhotoPin) {
    const sb = getSb()
    if (!sb) {
      showNotification('Cannot delete — no network connection')
      return
    }

    setUploadingPhoto(true)

    try {
      console.log('🗑️ Deleting photo pin:', pin.id)
      console.log('📸 Photo URL:', pin.photo_url)
      console.log('👤 Current user ID:', MY_ID.current)
      console.log('👤 Pin member ID:', pin.member_id)

      const fileName = pin.photo_url.split('/').pop()?.split('?')[0] || ''
      
      if (!fileName) {
        throw new Error('Could not extract filename from URL')
      }

      console.log('📄 Extracted filename:', fileName)

      // Step 1: Delete from storage
      console.log('🗑️ Attempting to delete from storage:', fileName)
      const { error: storageError } = await sb.storage
        .from('photo-pins')
        .remove([fileName])

      if (storageError) {
        console.error('❌ Storage deletion error:', storageError)
        showNotification('⚠️ Could not delete image file from storage')
      } else {
        console.log('✅ File deleted from storage')
      }

      // Step 2: Delete from photo_pins database - try both methods
      console.log('🗑️ Deleting from photo_pins...')
      
      // First try: delete by ID only (most reliable)
      const { data: deleteResult, error: dbError } = await sb
        .from('photo_pins')
        .delete()
        .eq('id', pin.id)
        .select()

      if (dbError) {
        console.error('❌ DB delete error (by ID):', dbError)
        
        // Second try: delete by ID and member_id
        console.log('🔄 Trying delete by ID + member_id...')
        const { data: deleteResult2, error: dbError2 } = await sb
          .from('photo_pins')
          .delete()
          .match({ id: pin.id, member_id: MY_ID.current })
          .select()
        
        if (dbError2) {
          console.error('❌ DB delete error (by ID + member_id):', dbError2)
          showNotification('Failed to delete pin: ' + dbError2.message)
          return
        }
        console.log('✅ Database record deleted (by ID + member_id):', deleteResult2)
      } else {
        console.log('✅ Database record deleted (by ID only):', deleteResult)
      }

      // Step 3: Also delete from archive if it exists
      try {
        console.log('🗑️ Also deleting from archive...')
        const { data: archiveData, error: archiveError } = await sb
          .from('photo_archive')
          .delete()
          .match({ photo_url: pin.photo_url })
          .select()
        
        if (archiveError) {
          console.warn('⚠️ Archive delete error:', archiveError)
        } else {
          console.log('✅ Archive delete result:', archiveData)
        }
      } catch (archiveError) {
        console.warn('⚠️ Archive delete failed (non-critical):', archiveError)
      }

      // Step 4: Remove from UI - handle cluster group
      const marker = photoPinMarkersRef.current.get(pin.id)
      if (marker) {
        if (photoClusterGroupRef.current) {
          photoClusterGroupRef.current.removeLayer(marker)
        } else {
          marker.remove()
        }
        photoPinMarkersRef.current.delete(pin.id)
      }

      // Step 5: Update state
      setPhotoPins(prev => prev.filter(p => p.id !== pin.id))
      setViewingPhoto(null)
      setGalleryOpen(false)
      
      showNotification('🗑️ Photo pin deleted!')

    } catch (error) {
      console.error('🔥 Error deleting photo pin:', error)
      showNotification('Error: ' + (error as Error).message)
    } finally {
      setUploadingPhoto(false)
    }
  }

  // --- Admin ---
  function handleRoomPressStart() {
    longPressTimer.current = setTimeout(() => { setAdminVisible(true); setAdminPassword(''); setAdminMsg('') }, 3000)
  }
  function handleRoomPressEnd() { if (longPressTimer.current) clearTimeout(longPressTimer.current) }
  function handleAdminPassword() {
    if (adminPassword === 'webra2026') { setAdminUnlocked(true); setAdminMsg('') }
    else setAdminMsg('Wrong password')
  }
  async function deleteAllMembers() {
    const sb = getSb(); if (!sb) return
    await sb.from('photo_pins').delete().neq('id', '__none__')
    setAdminMsg('All data deleted!')
    setMembers(new Map()); markersRef.current.forEach(m => m.remove()); markersRef.current.clear()
    accuracyCirclesRef.current.forEach(c => c.remove()); accuracyCirclesRef.current.clear()
    setTimeout(() => { setAdminVisible(false); setAdminUnlocked(false) }, 1500)
  }
  async function deleteThisRoom() {
    const sb = getSb(); if (!sb) return
    await sb.from('photo_pins').delete().eq('room', session.room)
    setAdminMsg(`Room "${session.room}" cleared!`)
    setMembers(new Map()); markersRef.current.forEach(m => m.remove()); markersRef.current.clear()
    accuracyCirclesRef.current.forEach(c => c.remove()); accuracyCirclesRef.current.clear()
    setTimeout(() => { setAdminVisible(false); setAdminUnlocked(false) }, 1500)
  }
  async function leaveAndRemove() {
    const sb = getSb()
    onLeave()
  }
  function copyRoom() {
    navigator.clipboard.writeText(session.room).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }


  return (
    <div style={{ position: 'relative', width: '100vw', height: '100dvh', background: '#0f172a' }}>
      <style>{`
        @keyframes pulse { 0%,100% { transform:scale(1); opacity:0.18; } 50% { transform:scale(1.9); opacity:0.07; } }
        @keyframes slideDown { from { transform:translateX(-50%) translateY(-20px); opacity:0; } to { transform:translateX(-50%) translateY(0); opacity:1; } }

      `}</style>

      {/* GPS Status Indicator */}
      <div style={{ position: 'absolute', top: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, marginTop: 50 }}>
        <span style={{ 
          background: gpsStatus === 'locked' ? '#34d399' : gpsStatus === 'waiting' ? '#f59e0b' : '#ef4444',
          color: '#0f172a',
          padding: '4px 12px',
          borderRadius: 12,
          fontSize: 12,
          fontWeight: 600
        }}>
          {gpsStatus === 'locked' ? '📍 GPS Locked' : gpsStatus === 'waiting' ? '⏳ Waiting for GPS...' : '❌ GPS Error'}
        </span>
      </div>

      {/* Hidden file input for photo capture */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handlePhotoSelected}
      />

      {/* Show map only when online, offline screen when not */}
      {isOnline ? (
        <div ref={mapRef} style={{ width: '100%', height: '100%', cursor: 'grab' }} />
      ) : (
        <div style={{
          width: '100%', height: '100%',
          background: '#0f172a',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 16,
        }}>
          <div style={{ fontSize: 64 }}>📵</div>
          <div style={{ color: '#f1f5f9', fontSize: 22, fontWeight: 700 }}>You're offline</div>
          <div style={{ color: '#94a3b8', fontSize: 15, textAlign: 'center', maxWidth: 280, lineHeight: 1.7 }}>
            Map needs internet to load.<br/>
            Photos taken now will upload automatically when you reconnect.
          </div>
          <div style={{ color: '#64748b', fontSize: 13 }}>
            Room: <span style={{ color: '#38bdf8', fontWeight: 600 }}>{session.room}</span>
          </div>
          {pendingUploads > 0 && (
            <div style={{
              background: '#1e293b', border: '1px solid #f97316',
              borderRadius: 12, padding: '12px 24px',
              color: '#f97316', fontSize: 15, fontWeight: 600,
            }}>
              📤 {pendingUploads} photo{pendingUploads > 1 ? 's' : ''} queued
            </div>
          )}
          <button
            style={{
              background: '#38bdf8', color: '#0f172a', border: 'none',
              borderRadius: 10, padding: '12px 28px', fontSize: 15,
              fontWeight: 700, cursor: 'pointer', marginTop: 8,
            }}
            onClick={() => window.location.reload()}
          >
            🔄 Try reconnecting
          </button>
        </div>
      )}

      {/* Notification */}
      {notification && (
        <div style={styles.notificationBanner}>
          <span>{notification}</span>
          <button onClick={() => setNotification(null)} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 16, cursor: 'pointer', marginLeft: 10, padding: 0, lineHeight: 1 }}>✕</button>
        </div>
      )}

      {/* Top bar */}
      <div style={styles.topBar}>
        <div style={styles.roomPill}
          onClick={copyRoom}
          onMouseDown={handleRoomPressStart} onMouseUp={handleRoomPressEnd} onMouseLeave={handleRoomPressEnd}
          onTouchStart={handleRoomPressStart} onTouchEnd={handleRoomPressEnd}
          title="Tap to copy · Hold 3s for admin"
        >
          <span style={styles.roomLabel}>Room</span>
          <span style={styles.roomCode}>{session.room}</span>
          <span style={styles.copyIcon}>{copied ? '✓' : '⎘'}</span>
        </div>
        <button style={styles.leaveBtn} onClick={() => setLeaveVisible(true)}>✕</button>
      </div>

      {/* Action buttons */}
      <div style={styles.actionRow}>
        <button 
          style={styles.actionBtn} 
          onClick={() => {
            setGalleryIndex(0)
            setGalleryOpen(true)
          }} 
          title="View all photos"
        >
          🖼️
        </button>
      </div>

      {/* Fit all FAB */}
      <button style={styles.fitBtn} onClick={fitAll} title="Zoom to fit your group">
        <span style={{ fontSize: 22, lineHeight: 1 }}>⊙</span>
        <span style={{ fontSize: 11, marginTop: 2 }}>Group</span>
      </button>

      <div style={styles.refreshBadge}>↻ {timeAgo(lastRefresh.toISOString())}</div>



      {/* Photo viewer modal */}
      {viewingPhoto && (
        <div style={styles.adminOverlay} onClick={() => setViewingPhoto(null)}>
          <div style={{ 
            ...styles.adminCard, 
            maxWidth: '90%', 
            maxHeight: '90vh',
            padding: '1rem',
            background: '#0f172a',
            border: '1px solid #334155',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ 
              width: '100%', 
              height: '75vh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <img 
                src={viewingPhoto.photo_url} 
                style={{ 
                  width: '100%', 
                  height: '100%',
                  objectFit: 'contain',
                  borderRadius: 12
                }} 
              />
            </div>
            <div style={{ color: '#f1f5f9', fontSize: 14, fontWeight: 600, marginTop: 10, textAlign: 'center' }}>
              📸 {viewingPhoto.member_name}
            </div>
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{timeAgo(viewingPhoto.created_at)}</div>
            <div style={{ color: '#475569', fontSize: 11, marginTop: 8, textAlign: 'center' }}>
              {new Date(viewingPhoto.created_at).toLocaleString()}
              {viewingPhoto.temperature ? ` · ${viewingPhoto.temperature}°C` : ''}
              {viewingPhoto.city ? ` · ${viewingPhoto.city}` : ''}
            </div>
            <div style={{ color: '#475569', fontSize: 11, textAlign: 'center' }}>
              📍 {viewingPhoto.lat.toFixed(5)}, {viewingPhoto.lng.toFixed(5)}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, width: '100%', flexWrap: 'wrap' }}>
              <button
                style={{ ...styles.adminBtn, background: '#0ea5e9', flex: 1 }}
                onClick={() => downloadStampedPhoto(viewingPhoto)}
              >
                ⬇ Download
              </button>
              {viewingPhoto.member_id === MY_ID.current && (
                <button 
                  style={{ ...styles.adminBtn, background: '#ef4444', flex: 1 }} 
                  onClick={() => deletePhotoPin(viewingPhoto)}
                >
                  🗑 Delete
                </button>
              )}
              <button 
                style={{ ...styles.adminBtn, background: '#475569', flex: 1 }} 
                onClick={() => setViewingPhoto(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Photo Gallery Modal */}
      {galleryOpen && photoPins.length > 0 && (
        <div style={styles.adminOverlay} onClick={() => setGalleryOpen(false)}>
          <div style={{ 
            ...styles.adminCard, 
            maxWidth: '95%', 
            maxHeight: '95vh',
            padding: '0.5rem',
            background: '#0f172a',
            border: '1px solid #334155',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: '95%'
          }} onClick={e => e.stopPropagation()}>
            
            <div style={{ 
              width: '100%', 
              height: '75vh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative'
            }}>
              <img 
                src={photoPins[galleryIndex].photo_url} 
                className="gallery-image"
                style={{ 
                  maxWidth: '100%',
                  maxHeight: '75vh',
                  objectFit: 'contain',
                  borderRadius: 8
                }} 
                alt={`Photo by ${photoPins[galleryIndex].member_name}`}
              />
            </div>
            
            <div style={{ 
              color: '#f1f5f9', 
              fontSize: 14, 
              fontWeight: 600, 
              marginTop: 10,
              textAlign: 'center'
            }}>
              📸 {photoPins[galleryIndex].member_name} · {timeAgo(photoPins[galleryIndex].created_at)}
            </div>
            
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'center', alignItems: 'center', width: '100%' }}>
              <button 
                style={{ ...styles.adminBtn, background: '#475569', flex: 1, maxWidth: 120 }}
                onClick={() => setGalleryIndex(prev => prev > 0 ? prev - 1 : photoPins.length - 1)}
              >
                ◀ Prev
              </button>
              <span style={{ color: '#94a3b8', fontSize: 13 }}>
                {galleryIndex + 1} / {photoPins.length}
              </span>
              <button 
                style={{ ...styles.adminBtn, background: '#475569', flex: 1, maxWidth: 120 }}
                onClick={() => setGalleryIndex(prev => prev < photoPins.length - 1 ? prev + 1 : 0)}
              >
                Next ▶
              </button>
            </div>
            
            <button 
              style={styles.adminCancel} 
              onClick={() => setGalleryOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Leave modal */}
      {leaveVisible && (
        <div style={styles.adminOverlay} onClick={() => setLeaveVisible(false)}>
          <div style={styles.adminCard} onClick={e => e.stopPropagation()}>
            <div style={styles.adminTitle}>Leave Room?</div>
            <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
              Do you want to remove your pin from the map, or just exit?
            </div>
            <button style={{ ...styles.adminBtn, background: '#ef4444' }} onClick={leaveAndRemove}>
              🗑 Leave & remove my pin<br /><span style={{ fontSize: 11, opacity: 0.8 }}>Others won't see you anymore</span>
            </button>
            <div style={{ height: 8 }} />
            <button style={{ ...styles.adminBtn, background: '#475569' }} onClick={onLeave}>
              👋 Just exit<br /><span style={{ fontSize: 11, opacity: 0.8 }}>Your last location stays visible</span>
            </button>
            <button style={styles.adminCancel} onClick={() => setLeaveVisible(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Admin panel */}
      {adminVisible && (
        <div style={styles.adminOverlay} onClick={() => { setAdminVisible(false); setAdminUnlocked(false) }}>
          <div style={styles.adminCard} onClick={e => e.stopPropagation()}>
            <div style={styles.adminTitle}>⚙ Admin</div>
            {!adminUnlocked ? (
              <>
                <input style={styles.adminInput} type="password" placeholder="Password"
                  value={adminPassword} onChange={e => setAdminPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAdminPassword()} autoFocus />
                <button style={styles.adminBtn} onClick={handleAdminPassword}>Unlock</button>
                {adminMsg && <div style={styles.adminMsg}>{adminMsg}</div>}
                <button style={styles.adminCancel} onClick={() => setAdminVisible(false)}>Cancel</button>
              </>
            ) : (
              <>
                <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 12 }}>What do you want to delete?</div>
                <button style={{ ...styles.adminBtn, background: '#f97316' }} onClick={deleteThisRoom}>
                  🗑 Clear this room only<br /><span style={{ fontSize: 11, opacity: 0.8 }}>("{session.room}")</span>
                </button>
                <div style={{ height: 8 }} />
                <button style={{ ...styles.adminBtn, background: '#ef4444' }} onClick={deleteAllMembers}>
                  🗑 Delete ALL rooms & members
                </button>
                {adminMsg && <div style={styles.adminMsg}>{adminMsg}</div>}
                <button style={styles.adminCancel} onClick={() => { setAdminVisible(false); setAdminUnlocked(false) }}>Cancel</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  topBar: {
    position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
    display: 'flex', alignItems: 'center', gap: 8, zIndex: 1000, whiteSpace: 'nowrap',
  },
  roomPill: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: '#1e293bee', border: '1px solid #334155', borderRadius: 20,
    padding: '6px 12px', cursor: 'pointer', backdropFilter: 'blur(4px)',
  },
  roomLabel: { color: '#64748b', fontSize: 12 },
  roomCode: { color: '#f1f5f9', fontSize: 13, fontWeight: 600, letterSpacing: '0.02em' },
  copyIcon: { color: '#38bdf8', fontSize: 14 },

  dot: { width: 10, height: 10, borderRadius: '50%' },
  leaveBtn: {
    background: '#1e293bee', border: '1px solid #334155', borderRadius: 20,
    color: '#94a3b8', fontSize: 14, padding: '6px 12px', cursor: 'pointer', backdropFilter: 'blur(4px)',
  },
  actionRow: {
    position: 'absolute', top: 70, right: 12, zIndex: 1000,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  actionBtn: {
    width: 44, height: 44, borderRadius: '50%',
    background: '#1e293bee', border: '1px solid #334155',
    color: '#94a3b8', fontSize: 20, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backdropFilter: 'blur(4px)',
  },








  notificationBanner: {
    position: 'absolute', top: 70, left: '50%', transform: 'translateX(-50%)',
    background: '#1e293b', border: '1px solid #334155', borderRadius: 20,
    padding: '8px 16px', color: '#f1f5f9', fontSize: 13,
    zIndex: 1002, whiteSpace: 'nowrap', animation: 'slideDown 0.3s ease',
    boxShadow: '0 4px 16px #0008', display: 'flex', alignItems: 'center', gap: 4,
  },


  adminOverlay: {
    position: 'absolute', inset: 0, background: '#000000aa',
    zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  adminCard: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 16,
    padding: '1.5rem', width: 300, display: 'flex', flexDirection: 'column', gap: 8,
    maxHeight: '80dvh', overflowY: 'auto',
  },
  adminTitle: { color: '#f1f5f9', fontSize: 16, fontWeight: 600, marginBottom: 8, textAlign: 'center' },
  adminInput: {
    width: '100%', boxSizing: 'border-box' as const,
    background: '#0f172a', border: '1px solid #334155', borderRadius: 8,
    padding: '10px 12px', color: '#f1f5f9', fontSize: 15, outline: 'none',
  },
  adminBtn: {
    width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none',
    borderRadius: 8, padding: '10px 0', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'system-ui,sans-serif', textAlign: 'center' as const,
  },
  adminCancel: {
    width: '100%', background: 'transparent', color: '#64748b', border: 'none',
    borderRadius: 8, padding: '8px 0', fontSize: 13, cursor: 'pointer',
    fontFamily: 'system-ui,sans-serif', marginTop: 4,
  },
  adminMsg: { color: '#34d399', fontSize: 13, textAlign: 'center' as const },
}