'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'

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

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa']

export default function DailyPage() {
  const [photos, setPhotos] = useState<PhotoPin[]>([])
  const [loading, setLoading] = useState(true)
  const [room, setRoom] = useState('')
  const [date, setDate] = useState('')
  const [selected, setSelected] = useState<PhotoPin | null>(null)
  const [lightbox, setLightbox] = useState<PhotoPin | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [calOpen, setCalOpen] = useState(false)
  const [calYear, setCalYear] = useState(new Date().getFullYear())
  const [calMonth, setCalMonth] = useState(new Date().getMonth())
  const [datesWithPhotos, setDatesWithPhotos] = useState<Set<string>>(new Set())

  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const sbRef = useRef<any>(null)

  // Load photos for a given date
  const loadPhotosForDate = useCallback(async (dateStr: string, roomStr: string) => {
    const sb = sbRef.current
    if (!sb) return
    setLoading(true)
    setSelected(null)
    setLightbox(null)
    setMapReady(false)
    if (mapInstanceRef.current) { mapInstanceRef.current.remove(); mapInstanceRef.current = null }

    const dayStart = new Date(dateStr + 'T00:00:00.000Z').toISOString()
    const dayEnd = new Date(dateStr + 'T23:59:59.999Z').toISOString()
    let query = sb.from('photo_pins').select('*').gte('created_at', dayStart).lte('created_at', dayEnd).order('created_at', { ascending: true })
    if (roomStr) query = query.eq('room', roomStr)
    const { data } = await query
    setPhotos(data || [])
    setLoading(false)
  }, [])

  // Load which dates have photos for calendar dots
  const loadDatesWithPhotos = useCallback(async (year: number, month: number, roomStr: string) => {
    const sb = sbRef.current
    if (!sb) return
    const start = new Date(year, month, 1).toISOString()
    const end = new Date(year, month + 1, 0, 23, 59, 59).toISOString()
    let query = sb.from('photo_pins').select('created_at').gte('created_at', start).lte('created_at', end)
    if (roomStr) query = query.eq('room', roomStr)
    const { data } = await query
    if (data) {
      const dates = new Set<string>(data.map((p: any) => p.created_at.slice(0, 10)))
      setDatesWithPhotos(dates)
    }
  }, [])

  // Init on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const roomParam = params.get('room') || ''
    const dateParam = params.get('date') ||
      window.location.pathname.split('/').filter(Boolean).pop() ||
      new Date().toISOString().slice(0, 10)

    setRoom(roomParam)
    setDate(dateParam)

    sbRef.current = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
    )

    // Set calendar to the date's month
    const d = new Date(dateParam + 'T12:00:00Z')
    setCalYear(d.getFullYear())
    setCalMonth(d.getMonth())

    loadPhotosForDate(dateParam, roomParam)
    loadDatesWithPhotos(d.getFullYear(), d.getMonth(), roomParam)
  }, [])

  // Reload calendar dots when month changes
  useEffect(() => {
    if (room !== undefined) loadDatesWithPhotos(calYear, calMonth, room)
  }, [calYear, calMonth, room])

  // Build map when photos change
  useEffect(() => {
    if (loading || !mapRef.current || mapInstanceRef.current || photos.length === 0) return

    import('leaflet').then(async L => {
      if (!mapRef.current) return
      // Start fully zoomed out showing the whole world
      const map = L.map(mapRef.current, { zoomControl: true, center: [20, 0], zoom: 2 })
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors', maxZoom: 19,
      }).addTo(map)
      mapInstanceRef.current = map

      // Load markercluster for photo pin grouping
      const loadCluster = () => new Promise<void>(resolve => {
        if ((window as any).L?.MarkerClusterGroup) { resolve(); return }
        const s = document.createElement('script')
        s.src = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js'
        s.onload = () => resolve()
        s.onerror = () => resolve()
        document.head.appendChild(s)
      })

      await loadCluster()

      const LMC = (window as any).L
      const useCluster = !!LMC?.MarkerClusterGroup

      let clusterGroup: any = null
      if (useCluster) {
        clusterGroup = LMC.markerClusterGroup({
          maxClusterRadius: 80,
          showCoverageOnHover: false,
          zoomToBoundsOnClick: true,
          iconCreateFunction: (cluster: any) => {
            const count = cluster.getChildCount()
            return L.divIcon({
              className: '',
              html: `<div style="
                width:52px;height:52px;border-radius:50%;
                background:#1e293b;border:3px solid #38bdf8;
                display:flex;flex-direction:column;
                align-items:center;justify-content:center;
                font-family:system-ui;
                box-shadow:0 2px 12px rgba(0,0,0,0.5);
                cursor:pointer;
              ">
                <span style="font-size:18px;font-weight:800;color:#38bdf8;line-height:1;">${count}</span>
                <span style="font-size:9px;color:#64748b;font-weight:600;">📸</span>
              </div>`,
              iconSize: [52, 52],
              iconAnchor: [26, 26],
            })
          },
        })
        clusterGroup.addTo(map)
      }

      const points: [number, number][] = []
      photos.forEach((pin, idx) => {
        points.push([pin.lat, pin.lng])
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:36px;height:36px;border-radius:50%;background:${pin.member_color};border:3px solid #0f172a;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#0f172a;font-family:system-ui;box-shadow:0 2px 8px #0006;cursor:pointer;">${idx + 1}</div>`,
          iconSize: [36, 36], iconAnchor: [18, 18],
        })
        const marker = L.marker([pin.lat, pin.lng], { icon })
        marker.bindTooltip(`${pin.member_name} · ${new Date(pin.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`, { direction: 'top' })
        marker.on('click', () => { setSelected(pin); setLightbox(pin) })

        if (clusterGroup) {
          clusterGroup.addLayer(marker)
        } else {
          marker.addTo(map)
        }
      })

      // Draw route line
      if (points.length > 1) {
        L.polyline(points, { color: '#38bdf8', weight: 2, opacity: 0.4, dashArray: '6, 8' }).addTo(map)
      }

      // Map starts at world view — clusters will be visible immediately
      // User can click a cluster to zoom into that area
      setMapReady(true)
    })

    return () => { mapInstanceRef.current?.remove(); mapInstanceRef.current = null }
  }, [loading, photos])

  function goToDate(dateStr: string) {
    setDate(dateStr)
    setCalOpen(false)
    loadPhotosForDate(dateStr, room)
    // Update URL without reload
    const url = new URL(window.location.href)
    url.searchParams.set('date', dateStr)
    window.history.pushState({}, '', url.toString())
  }

  // Calendar grid
  function buildCalendar() {
    const firstDay = new Date(calYear, calMonth, 1).getDay()
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate()
    const cells: (number | null)[] = []
    for (let i = 0; i < firstDay; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(d)
    return cells
  }

  const formatDate = (d: string) => {
    try {
      return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    } catch { return d }
  }

  const today = new Date().toISOString().slice(0, 10)
  const calCells = buildCalendar()

  const navBtn: React.CSSProperties = {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 8,
    color: '#f1f5f9', fontSize: 14, padding: '6px 14px', cursor: 'pointer',
  }

  return (
    <div style={styles.page}>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />

      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerInner}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
            <svg width="28" height="28" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="20" fill="#1e293b" />
              <circle cx="20" cy="20" r="13" stroke="#38bdf8" strokeWidth="1.5" fill="none" />
              <circle cx="20" cy="20" r="2.5" fill="#38bdf8" />
              <line x1="20" y1="7" x2="20" y2="13" stroke="#38bdf8" strokeWidth="1.5" />
              <line x1="20" y1="27" x2="20" y2="33" stroke="#38bdf8" strokeWidth="1.5" />
              <line x1="7" y1="20" x2="13" y2="20" stroke="#38bdf8" strokeWidth="1.5" />
              <line x1="27" y1="20" x2="33" y2="20" stroke="#38bdf8" strokeWidth="1.5" />
            </svg>
            <div>
              <div style={styles.title}>📅 Daily Photo Summary</div>
              <div style={styles.subtitle}>
                {date ? formatDate(date) : 'Loading…'}
                {room ? ` · Room: ${room}` : ''}
              </div>
            </div>
          </div>

          {/* Calendar toggle button */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              style={{
                background: calOpen ? '#38bdf8' : '#1e293b',
                border: '1px solid #334155', borderRadius: 10,
                color: calOpen ? '#0f172a' : '#f1f5f9',
                fontSize: 13, fontWeight: 600, padding: '8px 14px',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              }}
              onClick={() => setCalOpen(o => !o)}
            >
              🗓 {MONTHS[calMonth].slice(0, 3)} {calYear}
            </button>

            {/* Calendar dropdown */}
            {calOpen && (
              <div style={styles.calDropdown} onClick={e => e.stopPropagation()}>
                {/* Month nav */}
                <div style={styles.calHeader}>
                  <button style={styles.calNavBtn} onClick={() => {
                    if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1) }
                    else setCalMonth(m => m - 1)
                  }}>←</button>
                  <span style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 14 }}>
                    {MONTHS[calMonth]} {calYear}
                  </span>
                  <button style={styles.calNavBtn} onClick={() => {
                    if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1) }
                    else setCalMonth(m => m + 1)
                  }}>→</button>
                </div>

                {/* Day headers */}
                <div style={styles.calGrid}>
                  {DAYS.map(d => (
                    <div key={d} style={styles.calDayHeader}>{d}</div>
                  ))}

                  {/* Date cells */}
                  {calCells.map((cell, idx) => {
                    if (!cell) return <div key={`empty-${idx}`} />
                    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(cell).padStart(2, '0')}`
                    const hasPhotos = datesWithPhotos.has(dateStr)
                    const isToday = dateStr === today
                    const isSelected = dateStr === date
                    const isFuture = dateStr > today

                    return (
                      <div
                        key={dateStr}
                        style={{
                          ...styles.calCell,
                          background: isSelected ? '#38bdf8' : isToday ? '#1e3a5f' : 'transparent',
                          color: isSelected ? '#0f172a' : isFuture ? '#334155' : '#f1f5f9',
                          cursor: isFuture ? 'default' : 'pointer',
                          fontWeight: isSelected || isToday ? 700 : 400,
                          opacity: isFuture ? 0.4 : 1,
                        }}
                        onClick={() => { if (!isFuture) goToDate(dateStr) }}
                      >
                        {cell}
                        {hasPhotos && !isSelected && (
                          <div style={{
                            position: 'absolute', bottom: 2, left: '50%',
                            transform: 'translateX(-50%)',
                            width: 5, height: 5, borderRadius: '50%',
                            background: isSelected ? '#0f172a' : '#38bdf8',
                          }} />
                        )}
                      </div>
                    )
                  })}
                </div>

                <button
                  style={{ ...styles.calNavBtn, width: '100%', marginTop: 8, fontSize: 12 }}
                  onClick={() => {
                    const t = new Date()
                    setCalYear(t.getFullYear())
                    setCalMonth(t.getMonth())
                  }}
                >Today</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Click outside calendar to close */}
      {calOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1999 }} onClick={() => setCalOpen(false)} />
      )}

      {loading ? (
        <div style={styles.loading}>Loading photos…</div>
      ) : photos.length === 0 ? (
        <div style={styles.empty}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📸</div>
          <div>No photos on this day.</div>
          <div style={{ color: '#475569', marginTop: 8, fontSize: 13 }}>
            Use the 🗓 calendar to pick another date.
          </div>
        </div>
      ) : (
        <div style={styles.content}>
          {/* Map */}
          <div style={styles.mapContainer}>
            <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
            {!mapReady && <div style={styles.mapOverlay}>Loading map…</div>}
          </div>

          {/* Photo strip */}
          <div style={styles.photoStrip}>
            <div style={styles.stripLabel}>
              {photos.length} photo{photos.length !== 1 ? 's' : ''} — tap to view fullscreen
            </div>
            <div style={styles.stripScroll}>
              {photos.map((pin, idx) => (
                <div
                  key={pin.id}
                  style={{
                    ...styles.thumb,
                    border: `3px solid ${selected?.id === pin.id ? '#38bdf8' : pin.member_color}`,
                    outline: selected?.id === pin.id ? '2px solid #38bdf8' : 'none',
                  }}
                  onClick={() => {
                    setSelected(pin)
                    setLightbox(pin)
                    mapInstanceRef.current?.setView([pin.lat, pin.lng], 16)
                  }}
                >
                  <img src={pin.photo_url} style={styles.thumbImg} alt="" />
                  <div style={{ ...styles.thumbNum, background: pin.member_color }}>{idx + 1}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Selected detail */}
          {selected && (
            <div style={styles.detail}>
              <img
                src={selected.photo_url}
                style={{ ...styles.detailImg, cursor: 'pointer' }}
                onClick={() => setLightbox(selected)}
                alt=""
              />
              <div style={styles.detailInfo}>
                <div style={{ color: selected.member_color, fontWeight: 700, fontSize: 15 }}>
                  📸 {selected.member_name}
                </div>
                <div style={{ color: '#64748b', fontSize: 13, marginTop: 6 }}>
                  🕐 {new Date(selected.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </div>
                {selected.lat && (
                  <a
                    href={`https://www.google.com/maps?q=${selected.lat},${selected.lng}`}
                    target="_blank" rel="noreferrer"
                    style={{ color: '#38bdf8', fontSize: 12, marginTop: 4, display: 'block' }}
                  >
                    📍 Open in Maps
                  </a>
                )}
                <button style={{ ...navBtn, marginTop: 10 }} onClick={() => setLightbox(selected)}>
                  🔍 Fullscreen
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.95)', zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setLightbox(null)}
        >
          <button
            style={{ position: 'absolute', top: 16, right: 16, background: '#1e293b', border: '1px solid #334155', borderRadius: '50%', width: 44, height: 44, color: '#f1f5f9', fontSize: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}
            onClick={() => setLightbox(null)}
          >✕</button>

          <img
            src={lightbox.photo_url}
            style={{ maxWidth: '100vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 8 }}
            onClick={e => e.stopPropagation()}
            alt=""
          />

          <div
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,0.85))', padding: '20px 20px 24px' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ color: lightbox.member_color, fontWeight: 700, fontSize: 16 }}>📸 {lightbox.member_name}</div>
            <div style={{ color: '#94a3b8', fontSize: 14, marginTop: 4 }}>
              🕐 {new Date(lightbox.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              {' · '}
              📅 {new Date(lightbox.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </div>
            {lightbox.lat && (
              <a href={`https://www.google.com/maps?q=${lightbox.lat},${lightbox.lng}`} target="_blank" rel="noreferrer" style={{ color: '#38bdf8', fontSize: 13, display: 'block', marginTop: 4 }}>
                📍 {lightbox.lat.toFixed(5)}, {lightbox.lng.toFixed(5)} — Open in Maps
              </a>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <button style={navBtn} onClick={e => { e.stopPropagation(); const idx = photos.findIndex(p => p.id === lightbox.id); if (idx > 0) setLightbox(photos[idx - 1]) }} disabled={photos.findIndex(p => p.id === lightbox.id) === 0}>← Prev</button>
              <span style={{ color: '#475569', fontSize: 13 }}>{photos.findIndex(p => p.id === lightbox.id) + 1} / {photos.length}</span>
              <button style={navBtn} onClick={e => { e.stopPropagation(); const idx = photos.findIndex(p => p.id === lightbox.id); if (idx < photos.length - 1) setLightbox(photos[idx + 1]) }} disabled={photos.findIndex(p => p.id === lightbox.id) === photos.length - 1}>Next →</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const navBtn: React.CSSProperties = {
  background: '#1e293b', border: '1px solid #334155', borderRadius: 8,
  color: '#f1f5f9', fontSize: 14, padding: '6px 14px', cursor: 'pointer',
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100dvh', background: '#0f172a', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column' },
  header: { background: '#1e293b', borderBottom: '1px solid #334155', padding: '12px 16px', position: 'sticky', top: 0, zIndex: 2000 },
  headerInner: { maxWidth: 900, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12 },
  title: { color: '#f1f5f9', fontSize: 17, fontWeight: 700 },
  subtitle: { color: '#64748b', fontSize: 12, marginTop: 2 },
  loading: { color: '#94a3b8', fontSize: 16, textAlign: 'center', padding: '80px 20px' },
  empty: { color: '#64748b', fontSize: 15, textAlign: 'center', padding: '80px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center' },
  content: { flex: 1, display: 'flex', flexDirection: 'column', maxWidth: 900, width: '100%', margin: '0 auto', padding: '16px', gap: 14, boxSizing: 'border-box' as const },
  mapContainer: { height: '50vh', minHeight: 260, borderRadius: 12, overflow: 'hidden', border: '1px solid #334155', position: 'relative' },
  mapOverlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 14, background: '#1e293b' },
  photoStrip: { background: '#1e293b', borderRadius: 12, border: '1px solid #334155', padding: 12 },
  stripLabel: { color: '#64748b', fontSize: 12, marginBottom: 10 },
  stripScroll: { display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 },
  thumb: { width: 72, height: 72, borderRadius: 10, overflow: 'hidden', flexShrink: 0, cursor: 'pointer', position: 'relative' },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover' },
  thumbNum: { position: 'absolute', top: 3, left: 3, width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#0f172a' },
  detail: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 12, display: 'flex', gap: 12, alignItems: 'flex-start' },
  detailImg: { width: 110, height: 110, borderRadius: 8, objectFit: 'cover', flexShrink: 0 },
  detailInfo: { flex: 1, display: 'flex', flexDirection: 'column' },
  calDropdown: {
    position: 'absolute', top: '110%', right: 0, zIndex: 3000,
    background: '#1e293b', border: '1px solid #334155', borderRadius: 12,
    padding: 12, width: 240, boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  },
  calHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  calNavBtn: {
    background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
    color: '#94a3b8', fontSize: 13, padding: '4px 10px', cursor: 'pointer',
  },
  calGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2,
  },
  calDayHeader: {
    textAlign: 'center', fontSize: 10, color: '#475569',
    fontWeight: 600, padding: '2px 0 6px',
  },
  calCell: {
    textAlign: 'center', fontSize: 13, padding: '6px 2px',
    borderRadius: 6, position: 'relative', transition: 'background 0.1s',
  },
}
