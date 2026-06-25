import asyncio
import json
import os
from typing import Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="HAMELEONWEB Sufler WebRTC Signaling")


class SuflerPeer:
    def __init__(self, role: str, websocket: WebSocket):
        self.role = role
        self.ws = websocket


class SuflerRoom:
    def __init__(self, room_id: str):
        self.room_id = room_id
        self.electron: Optional[SuflerPeer] = None
        self.operator: Optional[SuflerPeer] = None
        self.lock = asyncio.Lock()

    def get_peer(self, role: str) -> Optional[SuflerPeer]:
        return self.electron if role == "electron" else self.operator

    def set_peer(self, role: str, peer: Optional[SuflerPeer]):
        if role == "electron":
            self.electron = peer
        else:
            self.operator = peer

    def other_role(self, role: str) -> str:
        return "operator" if role == "electron" else "electron"

    def other_peer(self, role: str) -> Optional[SuflerPeer]:
        return self.operator if role == "electron" else self.electron


class RoomManager:
    def __init__(self):
        self.rooms: Dict[str, SuflerRoom] = {}

    def get_or_create(self, room_id: str) -> SuflerRoom:
        if room_id not in self.rooms:
            self.rooms[room_id] = SuflerRoom(room_id)
        return self.rooms[room_id]

    def cleanup_if_empty(self, room_id: str):
        room = self.rooms.get(room_id)
        if room and room.electron is None and room.operator is None:
            del self.rooms[room_id]


manager = RoomManager()


@app.websocket("/ws/sufler/{room_id}")
async def sufler_websocket(websocket: WebSocket, room_id: str):
    await websocket.accept()

    try:
        # First message must identify role
        raw = await websocket.receive_text()
        msg = json.loads(raw)
        role = msg.get("role")
        if role not in ("electron", "operator"):
            await websocket.close(code=1008, reason="role must be electron or operator")
            return

        room = manager.get_or_create(room_id)
        async with room.lock:
            if room.get_peer(role) is not None:
                await websocket.close(code=1008, reason=f"{role} already connected")
                return
            peer = SuflerPeer(role, websocket)
            room.set_peer(role, peer)

        # Notify peer that other side is already here if applicable
        other = room.other_peer(role)
        if other:
            try:
                await websocket.send_text(json.dumps({"type": "peer-joined", "role": room.other_role(role)}))
                await other.ws.send_text(json.dumps({"type": "peer-joined", "role": role}))
            except Exception:
                pass

        # Relay messages
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            msg["from"] = role
            other = room.other_peer(role)
            if other:
                try:
                    await other.ws.send_text(json.dumps(msg))
                except Exception:
                    break
            else:
                # No other peer yet; optionally queue or drop
                pass

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        room = manager.rooms.get(room_id)
        if room:
            async with room.lock:
                peer = room.get_peer(role)
                if peer and peer.ws == websocket:
                    room.set_peer(role, None)
                    other = room.other_peer(role)
                    if other:
                        try:
                            await other.ws.send_text(json.dumps({"type": "peer-left", "role": role}))
                        except Exception:
                            pass
            manager.cleanup_if_empty(room_id)
        try:
            await websocket.close()
        except Exception:
            pass


@app.get("/sufler/{room_id}")
async def sufler_page(room_id: str):
    static_dir = os.path.join(os.path.dirname(__file__), "static")
    return FileResponse(os.path.join(static_dir, "index.html"))


# Serve static files for the operator page (optional)
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(static_dir):
    app.mount("/sufler-static", StaticFiles(directory=static_dir), name="sufler-static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("SUFLER_PORT", "8001")))
