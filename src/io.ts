// Lazily-set Socket.IO server reference, used by route handlers to emit
// real-time events without circular imports against index.ts. The server in
// index.ts assigns ioRef.io once the SocketServer has been instantiated.

import type { Server as SocketServer } from 'socket.io'

export const ioRef: { io: SocketServer | null } = { io: null }
