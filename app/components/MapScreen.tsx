'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient, RealtimeChannel } from '@supabase/supabase-js'
import { startLocationWatch } from '../lib/location'

type Props = {
  session: { name: string; room: string; color: string }
  onLeave: () => void
}

type MemberRow = {
  id: string
  room: string
  name: string
  color: string
  lat: number | null
  lng: number | null
  accuracy: number | null
  heading: number | null
  speed: number | null
  updated_at: string
}

type ChatMsg = {
  id: string
  room: string
  member_id: string
  member_name: string
  member_color: string
  message: string
  created_at: string
}

type MeetupPin = {
  id: string
  room: string
  lat: number
  lng: number
  set_by: string
  set_by_name: string
  created_at: string
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
  created_at: string
}

const CHAT_PRESETS = [
  '📍 On my way!',
  '⏳ Running late, sorry!',
  '✅ I\'m here!',
  '🅿️ I found parking',
  '🍺 I\'m at the bar',
  '📞 Call me',
  '👀 I can see you!',
  '🚗 Just arrived',
  '⚠️ Got lost, need help',
  '🎉 Having a great time!',
]

function getMyId(): string {
  if (typeof window === 'undefined') return 'ssr'
  let id = localStorage.getItem('friendmap_id')
  if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('friendmap_id', id) }
  return id
}

function isNativeApp(): boolean {
  return typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.()
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
  const markersRef = useRef<Map<string, any>>(new Map())
  const chatBubbleMarkersRef = useRef<Map<string, any>>(new Map())
  const accuracyCirclesRef = useRef<Map<string, any>>(new Map())
  const meetupMarkerRef = useRef<any>(null)
  const photoPinMarkersRef = useRef<Map<string, any>>(new Map())
  const photoClusterGroupRef = useRef<any>(null)
  const memberClusterGroupRef = useRef<any>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const supabaseRef = useRef<any>(null)
  const myPosRef = useRef<{ lat: number; lng: number } | null>(null)
  const hasInitialFitRef = useRef(false)
  const membersRef = useRef<Map<string, MemberRow>>(new Map())
  const userHasPannedRef = useRef(false)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevMemberIdsRef = useRef<Set<string>>(new Set())
  const meetupModeRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chatBubbleTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const [members, setMembers] = useState<Map<string, MemberRow>>(new Map())
  const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null)
  const [myAccuracy, setMyAccuracy] = useState<number | null>(null)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [gpsStatus, setGpsStatus] = useState<'waiting' | 'locked' | 'error'>('waiting')

  // Chat
  const [chatOpen, setChatOpen] = useState(false)
  const [customChatMsg, setCustomChatMsg] = useState('')
  const [recentChats, setRecentChats] = useState<ChatMsg[]>([])

  // Meetup
  const [meetupMode, setMeetupMode] = useState(false)
  const [meetupPin, setMeetupPin] = useState<MeetupPin | null>(null)

  // Photo pins
  const [photoPins, setPhotoPins] = useState<PhotoPin[]>([])
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [viewingPhoto, setViewingPhoto] = useState<PhotoPin | null>(null)
  const [pendingUploads, setPendingUploads] = useState(0)
  const [isOnline, setIsOnline] = useState(false) // start as false, test on mount

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

  useEffect(() => { membersRef.current = members }, [members])
  useEffect(() => { meetupModeRef.current = meetupMode }, [meetupMode])

  function showNotification(msg: string) {
    setNotification(msg)
    setTimeout(() => setNotification(null), 4000)
  }

  // Safe Supabase helper — returns null silently if offline
  function getSb() {
    if (!navigator.onLine) return null
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
      try {
        // Try to fetch a tiny resource from Supabase to confirm real connectivity
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
        if (!url) return navigator.onLine
        const res = await fetch(url + '/rest/v1/', {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000),
        })
        return res.ok || res.status < 500
      } catch {
        return false
      }
    }

    // Check on mount
    checkConnection().then(online => {
      setIsOnline(online)
      if (online) {
        upsertSelf()
        loadMembers().then(() => loadRecentChats())
        loadMeetupPin()
        loadPhotoPins()
      }
    })

    const handleOnline = async () => {
      const online = await checkConnection()
      if (!online) return
      setIsOnline(true)
      showNotification('📶 Back online — syncing...')
      setTimeout(async () => {
        upsertSelf()
        await loadMembers()
        loadRecentChats()
        loadMeetupPin()
        loadPhotoPins()
        uploadPendingPhotos()
      }, 500)
    }

    const handleOffline = () => {
      setIsOnline(false)
      showNotification('📵 Offline — photos will upload when connected')
    }

    // Poll every 10s as fallback for Android WebView
    const pollInterval = setInterval(async () => {
      const online = await checkConnection()
      setIsOnline(prev => {
        if (!prev && online) {
          // Just came back online
          setTimeout(async () => {
            upsertSelf()
            await loadMembers()
            loadRecentChats()
            loadMeetupPin()
            loadPhotoPins()
            uploadPendingPhotos()
          }, 500)
          showNotification('📶 Back online — syncing...')
        } else if (prev && !online) {
          showNotification('📵 Offline — photos will upload when connected')
        }
        return online
      })
    }, 10_000)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      clearInterval(pollInterval)
    }
  }, [session])

  // --- Init Supabase ---
  useEffect(() => {
    supabaseRef.current = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
    )
  }, [])

  // --- Init Leaflet ---
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return
    import('leaflet').then(L => {
      const map = L.map(mapRef.current!, { center: [20, 0], zoom: 2, zoomControl: true })
      // Load tiles - offline overlay will cover map if no connection
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors', maxZoom: 19,
      }).addTo(map)
      mapInstanceRef.current = map
      map.on('dragstart zoomstart', () => { userHasPannedRef.current = true })

      // Init member cluster group - script pre-loaded in layout.tsx so always ready
      const setupMemberCluster = () => {
        const LMC = (window as any).L
        if (!LMC?.MarkerClusterGroup) {
          // Fallback: retry after short delay if script not ready yet
          setTimeout(setupMemberCluster, 300)
          return
        }
        const cg = LMC.markerClusterGroup({
          maxClusterRadius: 60,
          showCoverageOnHover: false,
          zoomToBoundsOnClick: true,
          disableClusteringAtZoom: 12,
          iconCreateFunction: (cluster: any) => {
            const count = cluster.getChildCount()
            return LMC.divIcon({
              className: '',
              html: `<div style="
                width:48px;height:48px;border-radius:50%;
                background:#1e293b;border:3px solid #38bdf8;
                display:flex;flex-direction:column;
                align-items:center;justify-content:center;
                font-family:system-ui;box-shadow:0 2px 12px rgba(0,0,0,0.5);
                cursor:pointer;
              ">
                <span style="font-size:17px;font-weight:800;color:#38bdf8;line-height:1;">${count}</span>
                <span style="font-size:9px;color:#94a3b8;font-weight:600;">people</span>
              </div>`,
              iconSize: [48, 48], iconAnchor: [24, 24],
            })
          },
        })
        cg.addTo(map)
        memberClusterGroupRef.current = cg
        // Add any markers already created before cluster was ready
        markersRef.current.forEach(marker => cg.addLayer(marker))
      }
      setupMemberCluster()

      // Init photo cluster group
      initPhotoCluster(L)

      // Tap to set meetup pin
      map.on('click', async (e: any) => {
        if (!meetupModeRef.current) return
        const latlng = e.latlng
        if (!latlng) return
        const sb = supabaseRef.current
        if (!sb) return
        await sb.from('meetup_pins').delete().eq('room', session.room)
        const { data } = await sb.from('meetup_pins').insert({
          room: session.room, lat: latlng.lat, lng: latlng.lng,
          set_by: getMyId(), set_by_name: session.name,
        }).select().single()
        if (data) { setMeetupPin(data); renderMeetupPin(data, L) }
        setMeetupMode(false)
      })
    })
    return () => { mapInstanceRef.current?.remove(); mapInstanceRef.current = null }
  }, [])

  // --- Marker HTML ---
  function markerHtml(member: MemberRow, isMe = false): string {
    const active = isMe ? true : isActive(member.updated_at)
    const timedOut = isMe ? false : isTimedOut(member.updated_at)
    const color = (active && !timedOut) ? member.color : '#64748b'
    const opacity = timedOut ? 0.4 : (active ? 1 : 0.65)
    const pulse = (active && !timedOut)
      ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.18;animation:pulse 2s infinite;"></div>`
      : ''
    const label = isMe ? '★' : member.name.slice(0, 2).toUpperCase()
    const isMoving = (member.speed ?? 0) > 0.5 && member.heading !== null && !isNaN(member.heading ?? NaN)
    const arrow = isMoving
      ? `<div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%) rotate(${member.heading}deg);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:10px solid ${color};opacity:${opacity};"></div>`
      : ''
    const nameLabel = `<div style="position:absolute;top:44px;left:50%;transform:translateX(-50%);background:#0f172add;border:1px solid ${color}66;border-radius:6px;padding:2px 6px;font-size:11px;font-weight:600;color:${color};font-family:system-ui,sans-serif;white-space:nowrap;pointer-events:none;">${isMe ? session.name + ' ★' : member.name}</div>`
    return `<div style="position:relative;width:40px;height:40px;">${arrow}${pulse}<div style="position:absolute;top:7px;left:7px;width:26px;height:26px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:${isMe ? 13 : 11}px;font-weight:700;color:#0f172a;font-family:system-ui,sans-serif;box-shadow:0 0 0 2px #0f172a,0 0 0 ${isMe ? 4 : 3}px ${color};opacity:${opacity};">${label}</div>${nameLabel}</div>`
  }

  // --- Accuracy circle ---
  const upsertAccuracyCircle = useCallback((member: MemberRow, L: any) => {
    const map = mapInstanceRef.current
    if (!map || !member.lat || !member.lng || !member.accuracy) return
    const color = isActive(member.updated_at) ? member.color : '#64748b'
    const existing = accuracyCirclesRef.current.get(member.id)
    if (existing) { existing.setLatLng([member.lat, member.lng]); existing.setRadius(member.accuracy) }
    else {
      const circle = L.circle([member.lat, member.lng], {
        radius: member.accuracy, color, fillColor: color, fillOpacity: 0.06, weight: 1, opacity: 0.3,
      }).addTo(map)
      accuracyCirclesRef.current.set(member.id, circle)
    }
  }, [])

  // --- Chat bubble ---
  function showChatBubble(memberId: string, lat: number, lng: number, message: string, color: string, L: any) {
    const map = mapInstanceRef.current
    if (!map) return
    
    const existingTimeout = chatBubbleTimeoutsRef.current.get(memberId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
      chatBubbleTimeoutsRef.current.delete(memberId)
    }
    
    const existing = chatBubbleMarkersRef.current.get(memberId)
    if (existing) { existing.remove(); chatBubbleMarkersRef.current.delete(memberId) }
    
    const icon = L.divIcon({
      className: 'friendmap-chat-bubble',
      html: `<div class="friendmap-bubble-inner" style="border-color:${color}">${message}<span style="margin-left:8px;opacity:0.5;font-size:12px;">tap to dismiss</span></div>`,
      iconSize: [200, 50], iconAnchor: [0, 60],
    })
    const marker = L.marker([lat, lng], { icon, zIndexOffset: 500 }).addTo(map)
    marker.on('click', () => { 
      marker.remove(); 
      chatBubbleMarkersRef.current.delete(memberId)
      const timeout = chatBubbleTimeoutsRef.current.get(memberId)
      if (timeout) {
        clearTimeout(timeout)
        chatBubbleTimeoutsRef.current.delete(memberId)
      }
    })
    chatBubbleMarkersRef.current.set(memberId, marker)
    
    const timeout = setTimeout(() => { 
      if (marker && chatBubbleMarkersRef.current.get(memberId)) {
        marker.remove(); 
        chatBubbleMarkersRef.current.delete(memberId)
      }
      chatBubbleTimeoutsRef.current.delete(memberId)
    }, 86400000) // 24 hours
    chatBubbleTimeoutsRef.current.set(memberId, timeout)
  }

  // --- Init photo cluster group ---
  // Returns a promise that resolves when cluster is ready
  const clusterReadyRef = useRef<Promise<void> | null>(null)

  function initPhotoCluster(L: any): Promise<void> {
    const map = mapInstanceRef.current
    if (!map) return Promise.resolve()
    if (photoClusterGroupRef.current) return Promise.resolve()
    if (clusterReadyRef.current) return clusterReadyRef.current

    clusterReadyRef.current = new Promise<void>((resolve) => {
      // Check if already loaded
      if ((window as any).L?.MarkerClusterGroup) {
        setupCluster((window as any).L, map, resolve)
        return
      }
      const script = document.createElement('script')
      script.src = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js'
      script.onload = () => {
        const LMC = (window as any).L
        if (!LMC?.MarkerClusterGroup) { resolve(); return }
        setupCluster(LMC, map, resolve)
      }
      script.onerror = () => resolve() // fail gracefully
      document.head.appendChild(script)
    })
    return clusterReadyRef.current
  }

  function setupCluster(LMC: any, map: any, resolve: () => void) {
    const clusterGroup = LMC.markerClusterGroup({
      maxClusterRadius: 60,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      iconCreateFunction: (cluster: any) => {
        const count = cluster.getChildCount()
        return LMC.divIcon({
          className: 'photo-cluster',
          html: `<div class="photo-cluster-inner">
            <span class="photo-cluster-count">${count}</span>
            <span class="photo-cluster-label">📸 pics</span>
          </div>`,
          iconSize: [52, 52],
          iconAnchor: [26, 26],
        })
      },
    })
    clusterGroup.addTo(map)
    photoClusterGroupRef.current = clusterGroup
    // Add any markers that were added before cluster was ready
    photoPinMarkersRef.current.forEach(marker => clusterGroup.addLayer(marker))
    resolve()
  }

  // --- Photo pin on map ---
  function renderPhotoPin(pin: PhotoPin, L: any) {
    const map = mapInstanceRef.current
    if (!map) return

    const existing = photoPinMarkersRef.current.get(pin.id)
    if (existing) {
      if (photoClusterGroupRef.current) photoClusterGroupRef.current.removeLayer(existing)
      else existing.remove()
      photoPinMarkersRef.current.delete(pin.id)
    }

    const icon = L.divIcon({
      className: '',
      html: `<div style="position:relative;width:56px;height:56px;cursor:pointer;">
        <img src="${pin.photo_url}" style="width:52px;height:52px;border-radius:50%;border:3px solid ${pin.member_color};object-fit:cover;box-shadow:0 2px 8px #0008;" />
        <div style="position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);background:#0f172a;border:1px solid ${pin.member_color};border-radius:6px;padding:1px 5px;font-size:10px;font-weight:700;color:${pin.member_color};font-family:system-ui,sans-serif;white-space:nowrap;">${pin.member_name}</div>
      </div>`,
      iconSize: [56, 62],
      iconAnchor: [28, 56],
    })

    const marker = L.marker([pin.lat, pin.lng], { icon, zIndexOffset: 600 })
    marker.bindTooltip(`${pin.member_name} · ${timeAgo(pin.created_at)}`, { permanent: false, direction: 'top' })
    marker.on('click', () => setViewingPhoto(pin))

    photoPinMarkersRef.current.set(pin.id, marker)

    // Add to cluster group if ready, otherwise add directly to map
    if (photoClusterGroupRef.current) {
      photoClusterGroupRef.current.addLayer(marker)
    } else {
      marker.addTo(map)
    }
  }

  // --- Upsert marker ---
  const upsertMarker = useCallback((member: MemberRow, L: any, isMe = false) => {
    if (!member.lat || !member.lng) return
    const map = mapInstanceRef.current
    if (!map) return
    const tooltipText = isMe ? `${member.name} (you)`
      : isTimedOut(member.updated_at) ? `${member.name} · last seen ${timeAgo(member.updated_at)}`
      : isActive(member.updated_at) ? member.name
      : `${member.name} · ${timeAgo(member.updated_at)}`
    const icon = L.divIcon({ className: '', html: markerHtml(member, isMe), iconSize: [40, 60], iconAnchor: [20, 20] })
    const existing = markersRef.current.get(member.id)
    if (existing) {
      existing.setLatLng([member.lat, member.lng])
      existing.setIcon(icon)
      existing.setTooltipContent(tooltipText)
      // Refresh cluster position
      if (memberClusterGroupRef.current) {
        memberClusterGroupRef.current.refreshClusters(existing)
      }
    } else {
      const marker = L.marker([member.lat, member.lng], { icon })
      marker.bindTooltip(tooltipText, { permanent: false, direction: 'top', offset: [0, -20] })
      markersRef.current.set(member.id, marker)
      // Add to cluster if ready, else direct to map
      if (memberClusterGroupRef.current) {
        memberClusterGroupRef.current.addLayer(marker)
      } else {
        marker.addTo(map)
      }
    }
    upsertAccuracyCircle(member, L)
  }, [upsertAccuracyCircle])

  // --- Meetup pin ---
  function renderMeetupPin(pin: MeetupPin, L: any) {
    const map = mapInstanceRef.current
    if (!map) return
    if (meetupMarkerRef.current) meetupMarkerRef.current.remove()
    const icon = L.divIcon({
      className: '',
      html: `<div style="text-align:center;"><div style="font-size:28px;filter:drop-shadow(0 2px 4px #000a);">📍</div><div style="background:#38bdf8;color:#0f172a;border-radius:8px;padding:2px 6px;font-size:10px;font-weight:700;font-family:system-ui,sans-serif;white-space:nowrap;margin-top:-4px;">Meet here</div></div>`,
      iconSize: [60, 50], iconAnchor: [30, 45],
    })
    meetupMarkerRef.current = L.marker([pin.lat, pin.lng], { icon, zIndexOffset: 1000 })
      .addTo(map).bindTooltip(`Meet here · set by ${pin.set_by_name}`, { permanent: false, direction: 'top' })
  }

  async function clearMeetupPin() {
    const sb = getSb()
    if (!sb) return
    await sb.from('meetup_pins').delete().eq('room', session.room)
    setMeetupPin(null)
    if (meetupMarkerRef.current) { meetupMarkerRef.current.remove(); meetupMarkerRef.current = null }
  }

  // --- Fit all pins ---
  const fitAllPins = useCallback((L: any, force = false) => {
    const map = mapInstanceRef.current
    if (!map) return
    const points: [number, number][] = []
    membersRef.current.forEach(m => { if (m.lat && m.lng) points.push([m.lat, m.lng]) })
    if (myPosRef.current) points.push([myPosRef.current.lat, myPosRef.current.lng])
    if (points.length === 0) return
    if (points.length === 1) { map.setView(points[0], 13); return }
    map.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 13 })
  }, [])

  function zoomToWorld() {
    const map = mapInstanceRef.current
    if (!map) return
    userHasPannedRef.current = false
    map.setView([20, 0], 2, { animate: true })
  }

  useEffect(() => {
    import('leaflet').then(L => {
      members.forEach(m => upsertMarker(m, L, m.id === MY_ID.current))
      // No auto-fit — map stays at world zoom until user chooses to zoom in
    })
  }, [members, upsertMarker, fitAllPins])

  // --- Load members ---
  const loadMembers = useCallback(async () => {
    const sb = getSb()
    if (!sb) return
    const { data } = await sb.from('room_members').select('*').eq('room', session.room)
    if (data) {
      const fresh = data.filter((r: MemberRow) => !isExpired(r.updated_at))
      const expired = data.filter((r: MemberRow) => isExpired(r.updated_at))
      if (expired.length > 0) await sb.from('room_members').delete().in('id', expired.map((r: MemberRow) => r.id))
      const map = new Map<string, MemberRow>()
      fresh.forEach((row: MemberRow) => map.set(row.id, row))
      const newIds = new Set<string>(fresh.map((r: MemberRow) => r.id))
      fresh.forEach((r: MemberRow) => {
        if (!prevMemberIdsRef.current.has(r.id) && r.id !== MY_ID.current && prevMemberIdsRef.current.size > 0) {
          showNotification(`${r.name} joined the room 👋`)
        }
      })
      prevMemberIdsRef.current = newIds
      setMembers(map)
      setLastRefresh(new Date())
    }
  }, [session.room])

  // --- Load meetup pin ---
  const loadMeetupPin = useCallback(async () => {
    const sb = getSb()
    if (!sb) return
    const { data } = await sb.from('meetup_pins').select('*').eq('room', session.room).maybeSingle()
    if (data) { setMeetupPin(data); import('leaflet').then(L => renderMeetupPin(data, L)) }
  }, [session.room])

  // --- Load photo pins ---
  const loadPhotoPins = useCallback(async () => {
    const sb = getSb()
    if (!sb) return
    const { data } = await sb.from('photo_pins').select('*').eq('room', session.room).order('created_at', { ascending: false })
    if (data) {
      import('leaflet').then(async L => {
        // Wait for cluster to be ready before adding pins
        await initPhotoCluster(L)
        // Clear existing
        if (photoClusterGroupRef.current) {
          photoClusterGroupRef.current.clearLayers()
        } else {
          photoPinMarkersRef.current.forEach(m => m.remove())
        }
        photoPinMarkersRef.current.clear()
        setPhotoPins(data)
        data.forEach((pin: PhotoPin) => renderPhotoPin(pin, L))
      })
    }
  }, [session.room])

  // --- Load recent chats and re-render bubbles ---
  const loadRecentChats = useCallback(async () => {
    const sb = getSb()
    if (!sb) return
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data } = await sb.from('chat_messages').select('*').eq('room', session.room)
      .gte('created_at', cutoff).order('created_at', { ascending: false }).limit(100)
    if (data) {
      setRecentChats(data)
      // Re-render most recent bubble per member on app open
      const latestPerMember = new Map<string, ChatMsg>()
      ;[...data].reverse().forEach((msg: ChatMsg) => { latestPerMember.set(msg.member_id, msg) })
      latestPerMember.forEach((msg) => {
        const member = membersRef.current.get(msg.member_id)
        if (member?.lat && member?.lng) {
          import('leaflet').then(L => showChatBubble(msg.member_id, member.lat!, member.lng!, msg.message, msg.member_color, L))
        }
      })
    }
  }, [session.room])

  // --- Upsert self ---
  const upsertSelf = useCallback(async (lat?: number, lng?: number, accuracy?: number, heading?: number, speed?: number) => {
    const sb = getSb()
    if (!sb) return
    const payload: any = {
      id: MY_ID.current, room: session.room,
      name: session.name, color: session.color,
      updated_at: new Date().toISOString(),
    }
    if (lat !== undefined) { payload.lat = lat; payload.lng = lng }
    if (accuracy !== undefined) payload.accuracy = Math.round(accuracy)
    if (heading !== null && heading !== undefined && !isNaN(heading)) payload.heading = Math.round(heading)
    if (speed !== undefined && speed !== null) payload.speed = speed
    await sb.from('room_members').upsert(payload, { onConflict: 'id' })
  }, [session])

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
          const row = (payload.new || payload.old) as MemberRow
          if (!row) return
          if (payload.eventType === 'INSERT' && row.id !== MY_ID.current) showNotification(`${row.name} joined the room 👋`)
          setMembers(prev => {
            const next = new Map(prev)
            if (payload.eventType === 'DELETE') {
              next.delete(row.id)
              const m = markersRef.current.get(row.id); if (m) { 
                if (memberClusterGroupRef.current) memberClusterGroupRef.current.removeLayer(m)
                else m.remove()
                markersRef.current.delete(row.id)
              }
              const c = accuracyCirclesRef.current.get(row.id); if (c) { c.remove(); accuracyCirclesRef.current.delete(row.id) }
            } else { next.set(row.id, row) }
            return next
          })
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meetup_pins', filter: `room=eq.${session.room}` },
        (payload: any) => {
          if (payload.eventType === 'DELETE') {
            setMeetupPin(null)
            if (meetupMarkerRef.current) { meetupMarkerRef.current.remove(); meetupMarkerRef.current = null }
          } else if (payload.new) {
            setMeetupPin(payload.new)
            import('leaflet').then(L => renderMeetupPin(payload.new, L))
            if (payload.new.set_by !== MY_ID.current) showNotification(`${payload.new.set_by_name} set a meetup point 📍`)
          }
        })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room=eq.${session.room}` },
        (payload: any) => {
          const msg = payload.new as ChatMsg
          if (!msg) return
          setRecentChats(prev => [msg, ...prev].slice(0, 100))
          const member = membersRef.current.get(msg.member_id)
          if (member?.lat && member?.lng) {
            import('leaflet').then(L => showChatBubble(msg.member_id, member.lat!, member.lng!, msg.message, msg.member_color, L))
          } else {
            const sb = supabaseRef.current
            if (sb) {
              sb.from('room_members').select('lat,lng').eq('id', msg.member_id).single().then(({ data }: any) => {
                if (data?.lat && data?.lng) import('leaflet').then(L => showChatBubble(msg.member_id, data.lat, data.lng, msg.message, msg.member_color, L))
              })
            }
          }
          if (msg.member_id !== MY_ID.current) showNotification(`${msg.member_name}: ${msg.message}`)
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
          import('leaflet').then(async L => {
            await initPhotoCluster(L)
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
                  photoClusterGroupRef.current.clearLayers()
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

  // --- GPS ---
  useEffect(() => {
    let stopWatch: (() => void) | null = null
    startLocationWatch(
      async ({ lat, lng, accuracy, heading, speed }) => {
        setMyPos({ lat, lng })
        setMyAccuracy(accuracy)
        myPosRef.current = { lat, lng }
        setGeoError(null)
        setGpsStatus('locked')
        import('leaflet').then(L => {
          const selfRow: MemberRow = {
            id: MY_ID.current, room: session.room, name: session.name, color: session.color,
            lat, lng, accuracy, heading, speed, updated_at: new Date().toISOString(),
          }
          upsertMarker(selfRow, L, true)
          // No auto-fit on GPS — user controls zoom
        })
        await upsertSelf(lat, lng, accuracy, heading ?? undefined, speed ?? undefined)
      },
      (msg) => {
        setGeoError(msg)
        setGpsStatus('error')
      }
    ).then(stop => { stopWatch = stop })
    return () => { stopWatch?.() }
  }, [session, upsertSelf, upsertMarker, fitAllPins])

  // Refresh every 30s — load fresh data AND re-render all markers (fixes lock screen movement)
  useEffect(() => {
    const i = setInterval(async () => {
      if (!navigator.onLine) return // skip when offline
      await loadMembers()
      import('leaflet').then(L => {
        membersRef.current.forEach(m => upsertMarker(m, L, m.id === MY_ID.current))
      })
    }, 30_000)
    return () => clearInterval(i)
  }, [loadMembers, upsertMarker])

  // ============================================================
  // 🖼️ Stamp image with date, time, temperature, and city
  // ============================================================
  async function stampImage(
    imageFile: File, 
    lat: number, 
    lng: number
  ): Promise<Blob> {
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

      // 6. Convert to blob
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Failed to create blob'));
          },
          'image/jpeg',
          0.92
        );
      });
    } catch (error) {
      console.error('🔥 Error stamping image:', error);
      return imageFile;
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

      // Step 1: Resize image
      const resizedFile = await resizeImage(file, 1200)
      
      // Step 2: Stamp image with date/time/temperature/city
      const stampedBlob = await stampImage(
        resizedFile,
        myPosRef.current.lat,
        myPosRef.current.lng
      )
      
      // Convert Blob to File for upload
      const stampedFile = new File([stampedBlob], file.name, { type: 'image/jpeg' })

      const fileName = `${MY_ID.current}-${Date.now()}.jpg`

      console.log('📤 Uploading stamped image:', {
        fileName,
        originalSize: file.size,
        stampedSize: stampedFile.size,
        type: stampedFile.type,
        location: myPosRef.current
      })

      const { data: uploadData, error: uploadError } = await sb.storage
        .from('photo-pins')
        .upload(fileName, stampedFile, {
          contentType: 'image/jpeg',
          upsert: false,
          cacheControl: '3600',
        })

      if (uploadError) {
        console.error('❌ Upload error:', uploadError)
        showNotification('Upload failed: ' + uploadError.message)
        return
      }

      console.log('✅ Upload success:', uploadData)

      const { data: urlData } = sb.storage
        .from('photo-pins')
        .getPublicUrl(fileName)

      const photo_url = urlData.publicUrl

      const { error: dbError } = await sb.from('photo_pins').insert({
        room: session.room,
        lat: myPosRef.current.lat,
        lng: myPosRef.current.lng,
        member_id: MY_ID.current,
        member_name: session.name,
        member_color: session.color,
        photo_url,
      })

      if (dbError) {
        console.error('❌ DB Error:', dbError)
        showNotification('Database error: ' + dbError.message)
        return
      }

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

  // --- Send chat ---
  async function sendChat(message: string) {
    const sb = getSb()
    const msg = message.trim()
    if (!sb || !msg) return
    await sb.from('chat_messages').insert({
      room: session.room, member_id: MY_ID.current,
      member_name: session.name, member_color: session.color, message: msg,
    })
    if (myPosRef.current) {
      import('leaflet').then(L => showChatBubble(MY_ID.current, myPosRef.current!.lat, myPosRef.current!.lng, msg, session.color, L))
    }
    setCustomChatMsg('')
    setChatOpen(false)
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
    await sb.from('room_members').delete().neq('id', '__none__')
    await sb.from('meetup_pins').delete().neq('id', '__none__')
    await sb.from('chat_messages').delete().neq('id', '__none__')
    await sb.from('photo_pins').delete().neq('id', '__none__')
    setAdminMsg('All data deleted!')
    setMembers(new Map()); markersRef.current.forEach(m => m.remove()); markersRef.current.clear()
    accuracyCirclesRef.current.forEach(c => c.remove()); accuracyCirclesRef.current.clear()
    setTimeout(() => { setAdminVisible(false); setAdminUnlocked(false) }, 1500)
  }
  async function deleteThisRoom() {
    const sb = getSb(); if (!sb) return
    await sb.from('room_members').delete().eq('room', session.room)
    await sb.from('meetup_pins').delete().eq('room', session.room)
    await sb.from('chat_messages').delete().eq('room', session.room)
    await sb.from('photo_pins').delete().eq('room', session.room)
    setAdminMsg(`Room "${session.room}" cleared!`)
    setMembers(new Map()); markersRef.current.forEach(m => m.remove()); markersRef.current.clear()
    accuracyCirclesRef.current.forEach(c => c.remove()); accuracyCirclesRef.current.clear()
    setTimeout(() => { setAdminVisible(false); setAdminUnlocked(false) }, 1500)
  }
  async function leaveAndRemove() {
    const sb = getSb()
    if (sb) await sb.from('room_members').delete().eq('id', MY_ID.current)
    onLeave()
  }
  function copyRoom() {
    navigator.clipboard.writeText(session.room).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }
  function fitAll() {
    userHasPannedRef.current = false
    import('leaflet').then(L => fitAllPins(L, true))
  }

  const allWithPos = Array.from(members.values()).filter(m => m.lat && m.lng)
  const selfRow = allWithPos.find(m => m.id === MY_ID.current)
  const others = allWithPos
    .filter(m => m.id !== MY_ID.current && !isTimedOut(m.updated_at))
    .sort((a, b) => (isActive(b.updated_at) ? 1 : 0) - (isActive(a.updated_at) ? 1 : 0))
  const onlineCount = allWithPos.filter(m => isActive(m.updated_at)).length + (myPos && !selfRow ? 1 : 0)
  const meetupETA = meetupPin && myPos
    ? formatETA(distanceKm(myPos.lat, myPos.lng, meetupPin.lat, meetupPin.lng), null)
    : null

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100dvh', background: '#0f172a' }}>
      <style>{`
        @keyframes pulse { 0%,100% { transform:scale(1); opacity:0.18; } 50% { transform:scale(1.9); opacity:0.07; } }
        @keyframes slideDown { from { transform:translateX(-50%) translateY(-20px); opacity:0; } to { transform:translateX(-50%) translateY(0); opacity:1; } }
        .friendmap-chat-bubble { overflow: visible !important; }
        .friendmap-bubble-inner {
          position: absolute; top: 0; left: 0;
          background: #ffffff; border: 3px solid #38bdf8; border-radius: 14px;
          padding: 8px 12px; font-size: 15px !important; font-weight: 700 !important;
          color: #111827 !important; font-family: system-ui, sans-serif !important;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5); white-space: nowrap;
          writing-mode: horizontal-tb !important; text-orientation: mixed !important;
          transform: none !important; pointer-events: auto; cursor: pointer; z-index: 9999;
        }
        /* Photo cluster styling */
        .photo-cluster {
          background: transparent !important;
          border: none !important;
        }
        .photo-cluster-inner {
          width: 52px;
          height: 52px;
          border-radius: 50%;
          background: #1e293b;
          border: 3px solid #38bdf8;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          box-shadow: 0 2px 12px rgba(0,0,0,0.5);
          cursor: pointer;
          font-family: system-ui, sans-serif;
        }
        .photo-cluster-count {
          font-size: 18px;
          font-weight: 800;
          color: #38bdf8;
          line-height: 1;
        }
        .photo-cluster-label {
          font-size: 9px;
          color: #64748b;
          font-weight: 600;
          margin-top: 1px;
        }
        .friendmap-preset-btn {
          width: 100%; display: block; writing-mode: horizontal-tb !important;
          text-orientation: mixed !important; background: #1e3a5f; border: 2px solid #38bdf8;
          border-radius: 12px; padding: 14px 16px; color: #ffffff; font-size: 17px;
          font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif;
          text-align: left; line-height: 1.4; margin-bottom: 8px;
        }
        .gallery-image {
          width: 100%;
          height: auto;
          max-height: 75vh;
          object-fit: contain;
          border-radius: 8px;
        }
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

      <div ref={mapRef} style={{ width: '100%', height: '100%', cursor: meetupMode ? 'crosshair' : 'grab' }} />

      {/* Offline map overlay - shown when no network */}
      {!isOnline && (
        <div style={{
          position: 'absolute', inset: 0,
          background: '#0f172a',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 16, zIndex: 500,
        }}>
          <div style={{ fontSize: 64 }}>📵</div>
          <div style={{ color: '#f1f5f9', fontSize: 20, fontWeight: 700 }}>You're offline</div>
          <div style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', maxWidth: 260, lineHeight: 1.6 }}>
            Map tiles need internet to load.<br/>
            Your location and photos are being saved locally.
          </div>
          <div style={{ color: '#475569', fontSize: 13 }}>
            Room: <span style={{ color: '#38bdf8' }}>{session.room}</span>
          </div>
          {pendingUploads > 0 && (
            <div style={{
              background: '#1e293b', border: '1px solid #f97316',
              borderRadius: 12, padding: '10px 20px',
              color: '#f97316', fontSize: 14, fontWeight: 600,
            }}>
              📤 {pendingUploads} photo{pendingUploads > 1 ? 's' : ''} waiting to upload
            </div>
          )}
          <button
            style={{
              background: '#38bdf8', color: '#0f172a', border: 'none',
              borderRadius: 10, padding: '10px 24px', fontSize: 15,
              fontWeight: 700, cursor: 'pointer', marginTop: 8,
            }}
            onClick={() => window.location.reload()}
          >
            🔄 Try reconnecting
          </button>
        </div>
      )}

      {/* Meetup mode banner */}
      {meetupMode && (
        <div style={styles.meetupBanner}>
          📍 Tap anywhere on the map to set meetup point
          <button style={styles.meetupCancel} onClick={() => setMeetupMode(false)}>Cancel</button>
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
        <div style={styles.countPill}>
          <div style={{ ...styles.dot, background: '#34d399' }} />
          <span>{onlineCount} online</span>
        </div>
        <button style={styles.leaveBtn} onClick={() => setLeaveVisible(true)}>✕</button>
      </div>

      {/* Action buttons */}
      <div style={styles.actionRow}>
        <button style={styles.actionBtn} onClick={() => setChatOpen(true)} title="Send message">💬</button>
        <button
          style={{ ...styles.actionBtn, background: meetupMode ? '#38bdf8' : '#1e293bee', color: meetupMode ? '#0f172a' : '#94a3b8' }}
          onClick={() => setMeetupMode(!meetupMode)} title="Set meetup point"
        >📍</button>
        {meetupPin && (
          <button style={{ ...styles.actionBtn, fontSize: 11 }} onClick={clearMeetupPin} title="Clear meetup pin">✕📍</button>
        )}
        <button
          style={{ 
            ...styles.actionBtn, 
            background: uploadingPhoto ? '#1e293b55' : !isOnline ? '#7f1d1d99' : '#1e293bee', 
            position: 'relative',
            border: !isOnline ? '1px solid #ef444466' : '1px solid #334155',
          }}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingPhoto}
          title={!isOnline ? 'Offline — photo will be saved and uploaded when connected' : 'Drop a photo pin at my location'}
        >
          {uploadingPhoto ? '⏳' : '📸'}
          {pendingUploads > 0 && (
            <div style={{
              position: 'absolute', top: -4, right: -4,
              background: '#f97316', borderRadius: '50%',
              width: 18, height: 18, fontSize: 10, fontWeight: 800,
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '2px solid #0f172a',
            }}>{pendingUploads}</div>
          )}
        </button>
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

      {/* Meetup ETA */}
      {meetupPin && meetupETA && (
        <div style={styles.etaBanner}>📍 Meetup · {meetupETA}</div>
      )}

      {/* World zoom button */}
      <button style={styles.worldBtn} onClick={zoomToWorld} title="Show full world map">
        <span style={{ fontSize: 20, lineHeight: 1 }}>🌍</span>
        <span style={{ fontSize: 10, marginTop: 2 }}>World</span>
      </button>

      {/* Fit all FAB */}
      <button style={styles.fitBtn} onClick={fitAll} title="Zoom to fit your group">
        <span style={{ fontSize: 22, lineHeight: 1 }}>⊙</span>
        <span style={{ fontSize: 11, marginTop: 2 }}>Group</span>
      </button>

      {/* Members sidebar */}
      <div style={styles.friendsList}>
        {(selfRow || myPos) && (() => {
          const pos = myPos || { lat: selfRow!.lat!, lng: selfRow!.lng! }
          return (
            <div style={{ ...styles.friendRow, border: `1px solid ${session.color}55` }}
              onClick={() => mapInstanceRef.current?.setView([pos.lat, pos.lng], 16)}>
              <div style={{ ...styles.dot, background: session.color, flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1 }}>
                <span style={styles.friendName}>{session.name} ★</span>
                <span style={styles.lastSeen}>you · live</span>
              </div>
            </div>
          )
        })()}
        {others.map(m => {
          const active = isActive(m.updated_at)
          const dist = myPos && m.lat && m.lng ? distanceKm(myPos.lat, myPos.lng, m.lat, m.lng) : null
          const eta = dist !== null ? formatETA(dist, m.speed) : null
          const isMoving = (m.speed ?? 0) > 0.5
          return (
            <div key={m.id} style={styles.friendRow}
              onClick={() => m.lat && m.lng && mapInstanceRef.current?.setView([m.lat, m.lng], 16)}>
              <div style={{ ...styles.dot, background: active ? m.color : '#64748b', flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ ...styles.friendName, opacity: active ? 1 : 0.6 }}>{m.name}</span>
                  {isMoving && active && <span style={{ fontSize: 10, color: '#38bdf8' }}>↑</span>}
                </div>
                <span style={styles.lastSeen}>
                  {active ? 'live' : timeAgo(m.updated_at)}
                  {dist !== null ? ` · ${formatDist(dist)}` : ''}
                  {active && eta ? ` · ${eta}` : ''}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div style={styles.refreshBadge}>↻ {timeAgo(lastRefresh.toISOString())}</div>
      {geoError && <div style={styles.errorBanner}>⚠ {geoError}</div>}
      {!myPos && !geoError && <div style={styles.waitingBanner}>Getting your location…</div>}

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
            <div style={{ display: 'flex', gap: 8, marginTop: 12, width: '100%' }}>
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

      {/* Chat panel */}
      {chatOpen && (
        <div style={styles.adminOverlay} onClick={() => setChatOpen(false)}>
          <div style={{ ...styles.adminCard, maxWidth: 360, flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={styles.adminTitle}>💬 Quick Message</div>
            <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 8, textAlign: 'center' }}>
              Tap to send — appears above your pin
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                style={{ ...styles.adminInput, flex: 1, fontSize: 15 }}
                placeholder="Type your own message…"
                value={customChatMsg}
                onChange={e => setCustomChatMsg(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChat(customChatMsg)}
                maxLength={80}
              />
              <button style={{ ...styles.adminBtn, width: 48, flexShrink: 0, fontSize: 18, padding: 0 }}
                onClick={() => sendChat(customChatMsg)}>↑</button>
            </div>
            <div style={{ color: '#475569', fontSize: 12, marginBottom: 8, textAlign: 'center' }}>— or choose a preset —</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, width: '100%' }}>
              {CHAT_PRESETS.map(msg => (
                <button key={msg} className="friendmap-preset-btn" onClick={() => sendChat(msg)}>{msg}</button>
              ))}
            </div>
            <button style={styles.adminCancel} onClick={() => setChatOpen(false)}>Cancel</button>
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
  countPill: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: '#1e293bee', border: '1px solid #334155', borderRadius: 20,
    padding: '6px 12px', color: '#94a3b8', fontSize: 13, backdropFilter: 'blur(4px)',
  },
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
  worldBtn: {
    position: 'absolute', bottom: 112, right: 12, zIndex: 1000,
    width: 52, height: 52, borderRadius: '50%',
    background: '#1e293b', border: '2px solid #334155', color: '#94a3b8', fontWeight: 700, cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 12px #0008',
  },
  fitBtn: {
    position: 'absolute', bottom: 48, right: 12, zIndex: 1000,
    width: 52, height: 52, borderRadius: '50%',
    background: '#38bdf8', border: 'none', color: '#0f172a', fontWeight: 700, cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 12px #0008',
  },
  friendsList: {
    position: 'absolute', top: 70, left: 12, zIndex: 1000,
    display: 'flex', flexDirection: 'column', gap: 6,
    maxHeight: 'calc(100dvh - 200px)', overflowY: 'auto',
  },
  friendRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#1e293bee', border: '1px solid #334155', borderRadius: 20,
    padding: '7px 14px', cursor: 'pointer', backdropFilter: 'blur(4px)', minWidth: 150,
  },
  friendName: { color: '#f1f5f9', fontSize: 13, fontWeight: 500 },
  lastSeen: { color: '#94a3b8', fontSize: 13 },
  refreshBadge: {
    position: 'absolute', bottom: 175, right: 12, zIndex: 1000,
    background: '#1e293b99', border: '1px solid #1e293b', borderRadius: 12,
    padding: '4px 10px', color: '#475569', fontSize: 11,
  },
  meetupBanner: {
    position: 'absolute', top: 70, left: '50%', transform: 'translateX(-50%)',
    background: '#38bdf8', color: '#0f172a', borderRadius: 20,
    padding: '8px 16px', fontSize: 13, fontWeight: 600, zIndex: 1001,
    display: 'flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap',
  },
  meetupCancel: {
    background: '#0f172a33', border: 'none', borderRadius: 12,
    color: '#0f172a', fontSize: 12, padding: '3px 8px', cursor: 'pointer',
  },
  etaBanner: {
    position: 'absolute', bottom: 115, left: '50%', transform: 'translateX(-50%)',
    background: '#1e293bee', border: '1px solid #38bdf8', borderRadius: 20,
    padding: '6px 14px', color: '#38bdf8', fontSize: 13, fontWeight: 500,
    zIndex: 1000, whiteSpace: 'nowrap',
  },
  notificationBanner: {
    position: 'absolute', top: 70, left: '50%', transform: 'translateX(-50%)',
    background: '#1e293b', border: '1px solid #334155', borderRadius: 20,
    padding: '8px 16px', color: '#f1f5f9', fontSize: 13,
    zIndex: 1002, whiteSpace: 'nowrap', animation: 'slideDown 0.3s ease',
    boxShadow: '0 4px 16px #0008', display: 'flex', alignItems: 'center', gap: 4,
  },
  errorBanner: {
    position: 'absolute', bottom: 50, left: '50%', transform: 'translateX(-50%)',
    background: '#7f1d1dee', border: '1px solid #ef4444', borderRadius: 8,
    padding: '8px 16px', color: '#fca5a5', fontSize: 13, zIndex: 1000, whiteSpace: 'nowrap',
  },
  waitingBanner: {
    position: 'absolute', bottom: 50, left: '50%', transform: 'translateX(-50%)',
    background: '#1e293bee', border: '1px solid #334155', borderRadius: 8,
    padding: '8px 16px', color: '#94a3b8', fontSize: 13, zIndex: 1000, whiteSpace: 'nowrap',
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