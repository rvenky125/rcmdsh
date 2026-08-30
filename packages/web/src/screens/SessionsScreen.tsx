import type { SessionInfo, ShellInfo } from "rcmdsh-core";
import type { RelaySocket } from "../lib/ws";
import type { ConnectionStatus } from "../lib/ws";

interface SessionsScreenProps {
  socket: RelaySocket;
  deviceName: string;
  status: ConnectionStatus;
  sessions: SessionInfo[];
  shells: ShellInfo[];
  onCreate: (shell: string) => void;
  onOpen: (sessionId: string) => void;
  onUnpair: () => void;
}

function formatTime(createdAt: number): string {
  return new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function originLabel(session: SessionInfo): string {
  if (session.origin === "bridge") return "window";
  return "background";
}

export function SessionsScreen({
  socket,
  deviceName,
  status,
  sessions,
  shells,
  onCreate,
  onOpen,
  onUnpair,
}: SessionsScreenProps) {
  const alive = sessions.filter((s) => s.alive);
  const dead = sessions.filter((s) => !s.alive);

  const create = (shell: string) => {
    onCreate(shell);
  };

  return (
    <div className="screen sessions-screen">
      <header className="sessions-header">
        <div>
          <h1>{deviceName}</h1>
          <div className="status">
            <span className={`dot ${status.connected ? "on" : "off"}`} />
            {status.connected ? (status.daemonOnline ? "computer online" : "computer offline") : "connecting..."}
          </div>
        </div>
        <button className="linklike small" onClick={onUnpair}>
          Unpair
        </button>
      </header>

      <section>
        <h2>New session</h2>
        {shells.length === 0 ? (
          <p className="muted">
            {status.daemonOnline ? "loading shells..." : "your computer is not connected"}
          </p>
        ) : (
          <div className="shell-grid">
            {shells.map((shell) => (
              <button key={shell.id} className="btn shell" onClick={() => create(shell.id)}>
                + {shell.name}
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Running sessions</h2>
        {alive.length === 0 ? (
          <p className="muted">No active sessions.</p>
        ) : (
          <ul className="session-list">
            {alive.map((session) => (
              <li key={session.id} className="session-card" onClick={() => onOpen(session.id)}>
                <div className="session-main">
                  <span className="session-title">
                    {session.title} <span className={`badge ${session.origin}`}>{originLabel(session)}</span>
                  </span>
                  <span className="session-meta">
                    {session.shell} · since {formatTime(session.createdAt)}
                    {session.pid != null ? ` · pid ${session.pid}` : ""}
                  </span>
                </div>
                <button
                  className="btn danger small"
                  onClick={(e) => {
                    e.stopPropagation();
                    socket.request({ type: "session.kill", id: session.id });
                  }}
                >
                  Kill
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dead.length > 0 && (
        <section>
          <h2>Exited</h2>
          <ul className="session-list dim">
            {dead.slice(0, 5).map((session) => (
              <li key={session.id} className="session-card" onClick={() => onOpen(session.id)}>
                <div className="session-main">
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">exited</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
