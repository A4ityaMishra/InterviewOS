import asyncio
import sys
import types
import unittest


fastapi_stub = types.ModuleType("fastapi")


class DummyFastAPI:
    def __init__(self, *args, **kwargs):
        pass

    def get(self, *args, **kwargs):
        def decorator(func):
            return func
        return decorator

    def post(self, *args, **kwargs):
        def decorator(func):
            return func
        return decorator

    def websocket(self, *args, **kwargs):
        def decorator(func):
            return func
        return decorator

    def mount(self, *args, **kwargs):
        return None


class DummyWebSocket:
    def __init__(self, *args, **kwargs):
        pass


class DummyUploadFile:
    pass


class DummyFileResponse:
    def __init__(self, *args, **kwargs):
        pass


class DummyStaticFiles:
    def __init__(self, *args, **kwargs):
        pass


fastapi_stub.FastAPI = DummyFastAPI
fastapi_stub.Form = lambda *args, **kwargs: None
fastapi_stub.UploadFile = DummyUploadFile
fastapi_stub.WebSocket = DummyWebSocket
fastapi_stub.WebSocketDisconnect = Exception
fastapi_stub.responses = types.SimpleNamespace(FileResponse=DummyFileResponse)
fastapi_stub.staticfiles = types.SimpleNamespace(StaticFiles=DummyStaticFiles)
sys.modules["fastapi"] = fastapi_stub
sys.modules["fastapi.responses"] = fastapi_stub.responses
sys.modules["fastapi.staticfiles"] = fastapi_stub.staticfiles


server_agent_stub = types.ModuleType("server.agent")
server_agent_stub.InterviewSession = object
server_agent_stub.build_system_prompt = lambda *args, **kwargs: ""
sys.modules["server.agent"] = server_agent_stub

server_speech_stub = types.ModuleType("server.speech")
server_speech_stub.StreamingSTT = object

async def _synthesize(text):
    return b""

server_speech_stub.synthesize = _synthesize
sys.modules["server.speech"] = server_speech_stub

server_vad_stub = types.ModuleType("server.vad")
server_vad_stub.UtteranceDetector = object
sys.modules["server.vad"] = server_vad_stub

server_documents_stub = types.ModuleType("server.documents")
server_documents_stub.extract_text = lambda *args, **kwargs: ""
sys.modules["server.documents"] = server_documents_stub

server_store_stub = types.ModuleType("server.store")
server_store_stub.get = lambda *args, **kwargs: None
server_store_stub.create = lambda *args, **kwargs: None
server_store_stub.list_all = lambda *args, **kwargs: []
server_store_stub.set_status = lambda *args, **kwargs: None
server_store_stub.append_message = lambda *args, **kwargs: None
sys.modules["server.store"] = server_store_stub

from server.main import CallHandler


class DummyWebSocketClient:
    def __init__(self):
        self.messages = []

    async def send_json(self, payload):
        self.messages.append(payload)


class DummySession:
    ended = False

    def __init__(self):
        self._iterated = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._iterated:
            raise StopAsyncIteration
        self._iterated = True
        raise RuntimeError("boom")

    def respond(self, user_text):
        return self

    def note_partial_reply(self, spoken_prefix):
        return None


class SpeakResponseTests(unittest.IsolatedAsyncioTestCase):
    async def test_speak_response_recovers_from_producer_errors(self):
        ws = DummyWebSocketClient()
        handler = CallHandler.__new__(CallHandler)
        handler.ws = ws
        handler.session = DummySession()
        handler.session_id = "test-session"
        handler.speak_task = None
        handler.spoken_so_far = ""
        handler.pending_text = ""
        handler._record_agent_turn = lambda interrupted=False: None

        await asyncio.wait_for(handler.speak_response(None), timeout=2.0)

        self.assertTrue(any(msg.get("type") == "status" and msg.get("state") == "listening" for msg in ws.messages))
        self.assertTrue(any(msg.get("type") == "agent_text" and "trouble connecting" in msg.get("text", "") for msg in ws.messages))


if __name__ == "__main__":
    unittest.main()
