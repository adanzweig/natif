import { createClient, DeviceUnavailableError, type ExtractMeta, type LoadProgress } from "@be-natif/web";
import { useMemo, useState } from "react";
import { CHECKIN_TASK, CheckInSchema, EMOTION_LABELS_ES, type CheckIn } from "./checkin";
import { crisisCheck, resourcesFor } from "./crisis";

type Consent = { cloudFallback: boolean; telemetry: boolean };
const CONSENT_KEY = "checkin-consent";

function loadConsent(): Consent | null {
  try {
    return JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function App() {
  const [consent, setConsent] = useState<Consent | null>(loadConsent);
  if (!consent) {
    return (
      <ConsentScreen
        onDone={(c) => {
          try {
            localStorage.setItem(CONSENT_KEY, JSON.stringify(c));
          } catch {
            // private mode: ask again next time
          }
          setConsent(c);
        }}
      />
    );
  }
  return <CheckInScreen consent={consent} onResetConsent={() => setConsent(null)} />;
}

function ConsentScreen({ onDone }: { onDone: (c: Consent) => void }) {
  const [cloud, setCloud] = useState(false);
  const [telemetry, setTelemetry] = useState(false);
  return (
    <main>
      <h1>Check-in diario</h1>
      <p>
        Tu texto se procesa <b>en este dispositivo</b> con un modelo de IA local. No sale de tu navegador salvo que
        lo permitas abajo.
      </p>
      <p className="muted">La primera vez se descargan unos 2 GB; después queda guardado.</p>
      <label>
        <input type="checkbox" checked={cloud} onChange={(e) => setCloud(e.target.checked)} /> Si mi dispositivo no
        puede, enviar el texto a la nube para analizarlo (no se guarda).
      </label>
      <label>
        <input type="checkbox" checked={telemetry} onChange={(e) => setTelemetry(e.target.checked)} /> Enviar
        métricas anónimas de rendimiento (modelo, tiempos; nunca el texto).
      </label>
      <button onClick={() => onDone({ cloudFallback: cloud, telemetry })}>Continuar</button>
    </main>
  );
}

function CheckInScreen({ consent, onResetConsent }: { consent: Consent; onResetConsent: () => void }) {
  const ai = useMemo(
    () =>
      createClient({
        consent,
        capabilities: ["text"],
        tasks: { "daily-checkin": CHECKIN_TASK },
        onDownloadProgress: (p) => setProgress(p),
      }),
    [consent],
  );
  const [text, setText] = useState("");
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ data: CheckIn; meta: ExtractMeta } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crisis, setCrisis] = useState(false);
  const [sent, setSent] = useState<object | null>(null);

  async function submit() {
    setError(null);
    setResult(null);
    setSent(null);
    // Independent of the model: runs first, shows help right away.
    const flagged = crisisCheck(text);
    setCrisis(flagged);
    setBusy(true);
    try {
      const r = await ai.extractWithMeta({ task: "daily-checkin", schema: CheckInSchema, input: { text } });
      setResult(r);
      if (r.data.mood <= 2) setCrisis(true);
      // The only thing that would leave the device in a real app: the scores, never the text.
      setSent({ mood: r.data.mood, energy: r.data.energy, stress: r.data.stress, emotions: r.data.emotions, modelId: r.meta.modelId, ts: Date.now() });
    } catch (e) {
      setError(
        e instanceof DeviceUnavailableError
          ? `Este dispositivo no puede correr el modelo (${e.reason}) y no se permitió usar la nube.`
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <main>
      <h1>¿Cómo estás hoy?</h1>
      {crisis && <CrisisBanner />}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Contá cómo dormiste, cómo te sentís, qué pasó hoy…"
      />
      <button disabled={busy || !text.trim()} onClick={submit}>
        {busy ? "Analizando…" : "Analizar en mi dispositivo"}
      </button>

      {progress && progress.phase !== "ready" && (
        <div className="loading">
          <div className="bar">
            <div style={{ width: `${Math.round(progress.progress * 100)}%` }} />
          </div>
          <small>
            {progress.phase === "download" ? "Descargando el modelo" : "Preparando el modelo"} ·{" "}
            {Math.round(progress.progress * 100)}%
          </small>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {result && (
        <section className="result" data-testid="result">
          <Score label="Ánimo" value={result.data.mood} />
          <Score label="Energía" value={result.data.energy} />
          <Score label="Estrés" value={result.data.stress} />
          <p>{result.data.emotions.map((e) => EMOTION_LABELS_ES[e]).join(", ") || "—"}</p>
          <p className="muted">
            {result.meta.runtime === "device" ? "En tu dispositivo" : "En la nube"} · {result.meta.modelId} ·{" "}
            {(result.meta.latencyMs / 1000).toFixed(1)} s
            {result.meta.fallbackReason ? ` · motivo: ${result.meta.fallbackReason}` : ""}
          </p>
        </section>
      )}

      {sent && (
        <details>
          <summary>Qué se enviaría al servidor</summary>
          <pre data-testid="sent">{JSON.stringify(sent, null, 2)}</pre>
        </details>
      )}

      <button className="link" onClick={onResetConsent}>
        Cambiar permisos
      </button>
    </main>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <div className="score">
      <span>{label}</span>
      <meter min={1} max={10} value={value} />
      <b>{value}</b>
    </div>
  );
}

function CrisisBanner() {
  const resources = resourcesFor(navigator.language);
  return (
    <aside className="crisis" role="alert">
      <b>Si estás pasando por un momento muy difícil, no estás solo/a.</b>
      <ul>
        {resources.map((r) => (
          <li key={r.name}>
            {r.name}: {r.contact}
          </li>
        ))}
      </ul>
    </aside>
  );
}
