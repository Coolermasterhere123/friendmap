'use client'

import { useState } from 'react'
import JoinScreen from './components/JoinScreen'
import MapScreen from './components/MapScreen'

export type Friend = {
  id: string
  name: string
  lat: number
  lng: number
  color: string
  updated_at: string
}

export default function Page() {
  const [session, setSession] = useState<{ name: string; room: string; color: string } | null>(null)

  if (!session) {
    return <JoinScreen onJoin={setSession} />
  }

  return <MapScreen session={session} onLeave={() => setSession(null)} />
}
