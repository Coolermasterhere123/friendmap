'use client'

import { useState, useEffect } from 'react'

const FRIEND_COLORS = ['#f97316', '#22d3ee', '#a78bfa', '#34d399', '#fb7185', '#fbbf24']

function generateRoom() {
  const words = ['pine', 'oak', 'maple', 'birch', 'cedar', 'elm', 'ash', 'fern', 'moss', 'sage']
  const nums = Math.floor(Math.random() * 900) + 100
  return words[Math.floor(Math.random() * words.length)] + '-' + nums
}

type SavedRoom = { code: string; label: string; lastUsed: number }

type Props = {
  onJoin: (session: { name: string; room: string; color: string }) => void
}

export default function JoinScreen({ onJoin }: Props) {
  const [name, setName] = useState('')
  const [room, setRoom] = useState('')
  const [color, setColor] = useState(FRIEND_COLORS[0])
  const [savedRooms, setSavedRooms] = useState<SavedRoom[]>([])
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [labelInput, setLabelInput] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<'join' | 'rooms'>('join')

  useEffect(() => {
    const savedName = localStorage.getItem('friendmap_name') || ''
    const savedColor = localStorage.getItem('friendmap_color') || FRIEND_COLORS[Math.floor(Math.random() * FRIEND_COLORS.length)]
    const savedRoom = localStorage.getItem('friendmap_last_room') || ''
    const rooms: SavedRoom[] = JSON.parse(localStorage.getItem('friendmap_rooms') || '[]')
    setName(savedName)
    setColor(savedColor)
    setRoom(savedRoom)
    setSavedRooms(rooms.sort((a, b) => b.lastUsed - a.lastUsed))
    setLoaded(true)
  }, [])

  function saveRoom(code: string, label?: string) {
    const rooms: SavedRoom[] = JSON.parse(localStorage.getItem('friendmap_rooms') || '[]')
    const existing = rooms.findIndex(r => r.code === code)
    const entry: SavedRoom = { code, label: label || rooms[existing]?.label || code, lastUsed: Date.now() }
    if (existing >= 0) rooms[existing] = entry
    else rooms.push(entry)
    localStorage.setItem('friendmap_rooms', JSON.stringify(rooms))
    setSavedRooms(rooms.sort((a, b) => b.lastUsed - a.lastUsed))
  }

  function deleteRoom(code: string) {
    const rooms: SavedRoom[] = JSON.parse(localStorage.getItem('friendmap_rooms') || '[]')
    const updated = rooms.filter(r => r.code !== code)
    localStorage.setItem('friendmap_rooms', JSON.stringify(updated))
    setSavedRooms(updated)
  }

  function renameRoom(code: string, label: string) {
    const rooms: SavedRoom[] = JSON.parse(localStorage.getItem('friendmap_rooms') || '[]')
    const idx = rooms.findIndex(r => r.code === code)
    if (idx >= 0) rooms[idx].label = label
    localStorage.setItem('friendmap_rooms', JSON.stringify(rooms))
    setSavedRooms([...rooms].sort((a, b) => b.lastUsed - a.lastUsed))
    setEditingLabel(null)
  }

  function handleJoin(roomCode?: string) {
    const n = name.trim()
    const r = (roomCode || room.trim() || generateRoom()).toLowerCase()
    if (!n) return
    localStorage.setItem('friendmap_name', n)
    localStorage.setItem('friendmap_color', color)
    localStorage.setItem('friendmap_last_room', r)
    saveRoom(r)
    onJoin({ name: n, room: r, color })
  }

  if (!loaded) return null

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        {/* Logo */}
        <div style={styles.logo}>
          <svg width="36" height="36" viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="20" fill="#1e293b" />
            <circle cx="20" cy="20" r="13" stroke="#38bdf8" strokeWidth="1.5" fill="none" />
            <circle cx="20" cy="20" r="2.5" fill="#38bdf8" />
            <line x1="20" y1="7" x2="20" y2="13" stroke="#38bdf8" strokeWidth="1.5" />
            <line x1="20" y1="27" x2="20" y2="33" stroke="#38bdf8" strokeWidth="1.5" />
            <line x1="7" y1="20" x2="13" y2="20" stroke="#38bdf8" strokeWidth="1.5" />
            <line x1="27" y1="20" x2="33" y2="20" stroke="#38bdf8" strokeWidth="1.5" />
          </svg>
          <span style={styles.title}>FriendMap</span>
        </div>

        {/* Name + color — always visible */}
        <label style={styles.label}>Your name</label>
        <input
          style={styles.input}
          type="text"
          placeholder="e.g. Alex"
          maxLength={24}
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
        />

        <label style={styles.label}>Your pin color</label>
        <div style={styles.colorPicker}>
          {FRIEND_COLORS.map(c => (
            <div key={c} onClick={() => setColor(c)} style={{
              ...styles.colorSwatch, background: c,
              boxShadow: color === c ? `0 0 0 3px #0f172a,0 0 0 5px ${c}` : 'none',
              transform: color === c ? 'scale(1.15)' : 'scale(1)',
            }} />
          ))}
        </div>

        {/* Tabs */}
        <div style={styles.tabs}>
          <button style={{ ...styles.tab, ...(tab === 'join' ? styles.tabActive : {}) }} onClick={() => setTab('join')}>
            Join / Create
          </button>
          <button style={{ ...styles.tab, ...(tab === 'rooms' ? styles.tabActive : {}) }} onClick={() => setTab('rooms')}>
            My Rooms {savedRooms.length > 0 ? `(${savedRooms.length})` : ''}
          </button>
        </div>

        {/* Join tab */}
        {tab === 'join' && (
          <>
            <label style={styles.label}>
              Room code <span style={styles.optional}>(leave blank to create new)</span>
            </label>
            <input
              style={styles.input}
              type="text"
              placeholder="e.g. pine-342"
              maxLength={32}
              value={room}
              onChange={e => setRoom(e.target.value.toLowerCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
            />
            <button style={styles.btnPrimary} onClick={() => handleJoin()}>
              {room.trim() ? 'Join room' : 'Create new room'}
            </button>
            <p style={styles.hint}>Share the room code with friends so they can join.</p>
          </>
        )}

        {/* Saved rooms tab */}
        {tab === 'rooms' && (
          <div style={{ marginTop: 12 }}>
            {savedRooms.length === 0 && (
              <p style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
                No saved rooms yet. Join a room and it will appear here.
              </p>
            )}
            {savedRooms.map(r => (
              <div key={r.code} style={styles.savedRoom}>
                {editingLabel === r.code ? (
                  <input
                    style={{ ...styles.input, flex: 1, padding: '4px 8px', fontSize: 13 }}
                    value={labelInput}
                    autoFocus
                    onChange={e => setLabelInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') renameRoom(r.code, labelInput || r.code)
                      if (e.key === 'Escape') setEditingLabel(null)
                    }}
                    onBlur={() => renameRoom(r.code, labelInput || r.code)}
                  />
                ) : (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={styles.savedRoomLabel}
                      onClick={() => { setLabelInput(r.label); setEditingLabel(r.code) }}
                      title="Tap to rename"
                    >
                      {r.label}
                    </div>
                    <div style={styles.savedRoomCode}>{r.code}</div>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    style={styles.roomBtn}
                    onClick={() => handleJoin(r.code)}
                    title="Rejoin this room"
                  >▶</button>
                  <button
                    style={{ ...styles.roomBtn, color: '#ef4444' }}
                    onClick={() => deleteRoom(r.code)}
                    title="Remove from saved rooms"
                  >✕</button>
                </div>
              </div>
            ))}
            {savedRooms.length > 0 && (
              <p style={{ ...styles.hint, marginTop: 8 }}>Tap a name to rename it. ▶ to rejoin.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100dvh', display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: '#0f172a', padding: '1rem',
  },
  card: {
    background: '#1e293b', borderRadius: 16, padding: '1.75rem',
    width: '100%', maxWidth: 400, border: '1px solid #334155',
  },
  logo: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' },
  title: { fontSize: 22, fontWeight: 600, color: '#f1f5f9', letterSpacing: '-0.5px' },
  label: { display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 6, marginTop: '1rem' },
  optional: { color: '#475569', fontWeight: 400 },
  input: {
    width: '100%', boxSizing: 'border-box', background: '#0f172a',
    border: '1px solid #334155', borderRadius: 8,
    padding: '10px 12px', color: '#f1f5f9', fontSize: 15, outline: 'none',
  },
  colorPicker: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 },
  colorSwatch: {
    width: 26, height: 26, borderRadius: '50%', cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s',
  },
  tabs: { display: 'flex', gap: 0, marginTop: '1.25rem', borderRadius: 8, overflow: 'hidden', border: '1px solid #334155' },
  tab: {
    flex: 1, background: 'transparent', border: 'none', padding: '8px 0',
    color: '#64748b', fontSize: 13, cursor: 'pointer', fontFamily: 'system-ui,sans-serif',
  },
  tabActive: { background: '#0f172a', color: '#f1f5f9', fontWeight: 600 },
  btnPrimary: {
    width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none',
    borderRadius: 8, padding: '11px 0', fontSize: 15, fontWeight: 600,
    cursor: 'pointer', marginTop: '1rem', fontFamily: 'system-ui,sans-serif',
  },
  hint: { color: '#475569', fontSize: 12, marginTop: '0.75rem', textAlign: 'center', lineHeight: 1.5 },
  savedRoom: {
    display: 'flex', alignItems: 'center', gap: 10,
    background: '#0f172a', border: '1px solid #334155', borderRadius: 10,
    padding: '10px 12px', marginBottom: 8,
  },
  savedRoomLabel: {
    color: '#f1f5f9', fontSize: 14, fontWeight: 500, cursor: 'pointer',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  savedRoomCode: { color: '#475569', fontSize: 11, marginTop: 2 },
  roomBtn: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 6,
    color: '#94a3b8', fontSize: 13, padding: '4px 8px', cursor: 'pointer',
    fontFamily: 'system-ui,sans-serif',
  },
}
