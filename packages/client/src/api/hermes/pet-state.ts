import { io, type Socket } from 'socket.io-client'
import { getActiveProfileName, getApiKey, getBaseUrlValue } from '@/api/client'

export interface PetActivity {
  busy?: boolean
  reasoning?: boolean
  toolRunning?: boolean
  awaitingInput?: boolean
  error?: boolean
  justCompleted?: boolean
  celebrate?: boolean
}

export type PetState = 'idle' | 'run' | 'review' | 'failed' | 'wave' | 'jump' | 'waiting'

export interface PetStateSnapshot {
  profile: string
  state: PetState
  activity: PetActivity
  updatedAt: number
  sessionId?: string
  runId?: string
  activeTools: string[]
  awaiting: Array<'approval' | 'clarify' | 'input'>
}

let socket: Socket | null = null
let socketProfile: string | null = null

function activeProfile(profile?: string | null): string {
  return profile || getActiveProfileName() || 'default'
}

export function connectPetStateSocket(profile?: string | null): Socket {
  const nextProfile = activeProfile(profile)
  if (socket && (socket as any).connected && socketProfile === nextProfile) return socket
  if (socket) {
    const ioMgr = socket.io as any
    try { ioMgr.reconnection = false } catch {}
    socket.removeAllListeners?.()
    socket.disconnect()
    try { ioMgr._destroy?.(false) } catch {}
    socket = null
  }

  socketProfile = nextProfile
  const base = getBaseUrlValue() || ''
  socket = io('/pet-state', {
    path: `${base}/socket.io`,
    auth: { token: getApiKey() },
    query: { profile: nextProfile },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    timeout: 30000,
  })
  return socket
}

export function disconnectPetStateSocket(): void {
  if (socket) {
    const ioMgr = socket.io as any
    try { ioMgr.reconnection = false } catch {}
    socket.removeAllListeners?.()
    socket.disconnect()
    try { ioMgr._destroy?.(false) } catch {}
    socket = null
  }
  socketProfile = null
}

export function onPetStateSnapshot(
  handler: (snapshot: PetStateSnapshot) => void,
  profile?: string | null,
): () => void {
  const activeSocket = connectPetStateSocket(profile)
  activeSocket.on('pet.state.snapshot', handler)
  activeSocket.on('pet.state.updated', handler)
  return () => {
    activeSocket.off('pet.state.snapshot', handler)
    activeSocket.off('pet.state.updated', handler)
  }
}

export function requestPetStateSnapshot(profile?: string | null): Promise<PetStateSnapshot> {
  const activeSocket = connectPetStateSocket(profile)
  return new Promise((resolve, reject) => {
    activeSocket.timeout(10000).emit('pet.state.get', (err: Error | null, snapshot: PetStateSnapshot) => {
      if (err) {
        reject(err)
        return
      }
      resolve(snapshot)
    })
  })
}
