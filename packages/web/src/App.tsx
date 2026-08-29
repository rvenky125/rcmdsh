import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonToClientMessage, SessionInfo, ShellInfo } from "@rcmdsh/shared";
import { clearPairing, loadPairing, type PairingState } from "./lib/store";
import { RelaySocket, type ConnectionStatus } from "./lib/ws";
import { PairScreen } from "./screens/PairScreen";
import { SessionsScreen } from "./screens/SessionsScreen";
import { TerminalScreen } from "./screens/TerminalScreen";

type Screen = { name: "sessions" } | { name: "terminal"; id: string; title: string };

type OutputListener = (message: DaemonToClientMessage) => void;

export default function App() {
  const [pairing, setPairing] = useState<PairingState | null>(() => loadPairing());
  const [screen, setScreen] = useState<Screen>({ name: "sessions" });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>({ connected: false, daemonOnline: false });
  const [toast, setToast] = useState<string | null>(null);

  const socketRef = useRef<RelaySocket | null>(null);
  const listenersRef = useRef(new Set<OutputListener>());
  const pendingCreateRef = useRef<string | null>(null);
  const knownSessionIdsRef = useRef(new Set<string>());

  const subscribe = useCallback((listener: OutputListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!pairing) return;
    knownSessionIdsRef.current = new Set();
    const socket = new RelaySocket(pairing, {
      onMessage: (message) => {
        for (const listener of listenersRef.current) listener(message);
        switch (message.type) {
          case "sessions.list": {
            const previous = knownSessionIdsRef.current;
            const fresh = message.sessions.find((s) => !previous.has(s.id) && s.alive);
            for (const session of message.sessions) previous.add(session.id);
            setSessions(message.sessions);
            if (pendingCreateRef.current && fresh) {
              pendingCreateRef.current = null;
              setScreen({ name: "terminal", id: fresh.id, title: fresh.title });
            }
            return;
          }
          case "capabilities": {
            setShells(message.shells);
            return;
          }
          case "session.exit": {
            socket.request({ type: "sessions.list" });
            return;
          }
          case "error": {
            if (message.code !== "disconnected" || screen.name === "sessions") {
              setToast(`${message.code}: ${message.message}`);
            }
            return;
          }
          default:
            return;
        }
      },
      onStatus: setStatus,
      onReady: () => {
        socket.request({ type: "sessions.list" });
      },
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      socket.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!pairing) {
    return <PairScreen onPaired={setPairing} />;
  }

  const createSession = (shell: string) => {
    pendingCreateRef.current = shell;
    socketRef.current?.request({ type: "session.create", shell, cols: 80, rows: 24 });
  };

  const unpair = () => {
    clearPairing();
    setPairing(null);
    setScreen({ name: "sessions" });
  };

  return (
    <>
      {screen.name === "sessions" ? (
        <SessionsScreen
          socket={socketRef.current!}
          deviceName={pairing.deviceName}
          status={status}
          sessions={sessions}
          shells={shells}
          onCreate={createSession}
          onOpen={(id) => {
            const session = sessions.find((s) => s.id === id);
            setScreen({ name: "terminal", id, title: session?.title ?? id.slice(0, 8) });
          }}
          onUnpair={unpair}
        />
      ) : (
        <TerminalScreen
          socket={socketRef.current!}
          sessionId={screen.id}
          sessionTitle={screen.title}
          subscribe={subscribe}
          onBack={() => {
            setScreen({ name: "sessions" });
            socketRef.current?.request({ type: "sessions.list" });
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
