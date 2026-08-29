import { useEffect, useState } from "react";
import { newClientKeyPair, savePairing, type PairingState } from "../lib/store";

interface PairScreenProps {
  onPaired: (state: PairingState) => void;
}

interface PairQuery {
  relay: string;
  code: string;
}

function readPairQuery(): PairQuery | null {
  const hash = window.location.hash;
  const match = hash.match(/[#/]pair\?(.*)/);
  const source = match ? match[1] : window.location.search.replace(/^\?/, "");
  if (!source) return null;
  const params = new URLSearchParams(source);
  const relay = params.get("relay") ?? "";
  const code = params.get("code") ?? "";
  if (!relay || !code) return null;
  return { relay, code };
}

export function PairScreen({ onPaired }: PairScreenProps) {
  const query = readPairQuery();
  const [relay, setRelay] = useState(query?.relay ?? window.location.origin);
  const [code, setCode] = useState(query?.code ?? "");
  const [clientName, setClientName] = useState("my phone");
  const [devMode, setDevMode] = useState(false);
  const [devToken, setDevToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (query) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (devMode) {
        const keys = newClientKeyPair();
        savePairing({
          relay,
          deviceId: "dev",
          deviceName: "dev computer",
          clientId: "dev-client",
          clientName,
          token: devToken,
          daemonPubKey: keys.publicKey,
          clientPubKey: keys.publicKey,
          clientSecretKey: keys.secretKey,
          insecure: true,
        });
        onPaired({
          relay,
          deviceId: "dev",
          deviceName: "dev computer",
          clientId: "dev-client",
          clientName,
          token: devToken,
          daemonPubKey: keys.publicKey,
          clientPubKey: keys.publicKey,
          clientSecretKey: keys.secretKey,
          insecure: true,
        });
        return;
      }

      const normalized = relay.replace(/\/+$/, "");
      const keys = newClientKeyPair();
      const res = await fetch(`${normalized}/v1/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim().toUpperCase(), clientPubKey: keys.publicKey, clientName }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `pairing failed (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        deviceId: string;
        daemonPubKey: string;
        clientId: string;
        clientName: string;
        clientToken: string;
      };
      const state: PairingState = {
        relay: normalized,
        deviceId: data.deviceId,
        deviceName: "my computer",
        clientId: data.clientId,
        clientName,
        token: data.clientToken,
        daemonPubKey: data.daemonPubKey,
        clientPubKey: keys.publicKey,
        clientSecretKey: keys.secretKey,
        insecure: false,
      };
      savePairing(state);
      onPaired(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen pair-screen">
      <h1>rcmdsh</h1>
      <p className="muted">
        Pair with your computer. Run <code>rcmdsh pair</code> on your machine and enter the
        pairing code (or open the link it shows).
      </p>

      <label>
        Relay server
        <input
          value={relay}
          onChange={(e) => setRelay(e.target.value)}
          placeholder="https://relay.example.com"
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="url"
        />
      </label>

      {!devMode && (
        <label>
          Pairing code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD2345"
            autoCapitalize="characters"
            autoCorrect="off"
            maxLength={8}
            inputMode="text"
          />
        </label>
      )}

      <label>
        This device's name
        <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
      </label>

      {devMode && (
        <label>
          Dev token
          <input
            value={devToken}
            onChange={(e) => setDevToken(e.target.value)}
            placeholder="shared dev token"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>
      )}

      {error && <div className="error">{error}</div>}

      <button className="btn primary" disabled={busy || (!devMode && code.length !== 8) || (devMode && !devToken)} onClick={submit}>
        {busy ? "Pairing..." : "Pair"}
      </button>

      <button className="linklike" onClick={() => setDevMode(!devMode)}>
        {devMode ? "Use pairing code" : "Developer mode (dev token)"}
      </button>
    </div>
  );
}
