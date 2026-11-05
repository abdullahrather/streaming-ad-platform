import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  type AiProviderName,
  type AiSettings,
  type AiSettingsInput,
  type AiStatus,
  type AiTestResult,
  type LocalAiStatus,
  type ModelDownload,
} from './api';
import { Progress } from './components';
import { formatDateTime } from './format';
import { ErrorNote, firstError } from './ui';

const errorText = (reason: unknown): string =>
  reason instanceof ApiError ? firstError(reason) : String(reason);

const PROVIDERS: Array<{ id: AiProviderName; label: string; hint: string }> = [
  {
    id: 'local',
    label: 'Local model',
    hint: 'Free, on this machine through Ollama. Nothing leaves it.',
  },
  {
    id: 'anthropic',
    label: 'Claude',
    hint: 'Your own Anthropic API key. Usage is billed to your account.',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible API',
    hint: 'Any service with the OpenAI chat API, with your key.',
  },
];

const SUGGESTED_LOCAL_MODEL = 'qwen2.5:7b';

const gigabytes = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/** Ollama's status, its installed models, and downloading another one. */
const LocalSetup = ({
  baseUrl,
  model,
  onModel,
}: {
  baseUrl: string;
  model: string;
  onModel: (model: string) => void;
}) => {
  const [local, setLocal] = useState<LocalAiStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [download, setDownload] = useState<ModelDownload | null>(null);
  const [wanted, setWanted] = useState('');
  const [error, setError] = useState('');

  const check = useCallback(() => {
    setChecking(true);
    api
      .localAiStatus(baseUrl)
      .then(setLocal)
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setChecking(false));
  }, [baseUrl]);

  useEffect(check, [check]);

  // With no model chosen yet, pick an installed one: the default if it's there.
  useEffect(() => {
    if (model || !local?.models.length) return;
    const names = local.models.map(({ name }) => name);
    onModel(names.includes(SUGGESTED_LOCAL_MODEL) ? SUGGESTED_LOCAL_MODEL : (names[0] ?? ''));
  }, [local, model, onModel]);

  // While a download runs, read its progress every second.
  useEffect(() => {
    if (!download || download.done) return undefined;
    const timer = window.setInterval(() => {
      api
        .modelDownload(download.model)
        .then((job) => {
          if (!job) return;
          setDownload(job);
          if (job.done && !job.error) {
            onModel(job.model);
            check();
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [download, check, onModel]);

  const start = (): void => {
    setError('');
    api
      .downloadModel(wanted.trim(), baseUrl)
      .then(setDownload)
      .catch((reason: unknown) => setError(errorText(reason)));
  };

  if (!local) return <p className="muted small">{checking ? 'Looking for Ollama…' : ''}</p>;

  if (!local.running) {
    return (
      <div className="ai-off">
        <p>
          <strong>Ollama isn't running on this machine.</strong> Local models run through Ollama, a
          free app. It has to be installed by hand, since a web page shouldn't install software.
        </p>
        <ol className="small">
          <li>
            Download it from <a href="https://ollama.com/download">ollama.com/download</a>, or on
            Windows run <code>winget install Ollama.Ollama</code>.
          </li>
          <li>Start Ollama. It keeps running in the background.</li>
          <li>Come back here and check again. You can download a model from this page.</li>
        </ol>
        <button type="button" className="button" onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <ErrorNote message={error} />
      </div>
    );
  }

  const downloading = download && !download.done;
  const share = download?.total ? download.completed / download.total : 0;

  return (
    <div className="stack">
      <p className="small">
        <span className="badge badge-good">Running</span> Ollama {local.version}
        {local.models.length === 0 ? ', with no models yet.' : '.'}
      </p>
      {local.models.length > 0 && (
        <label>
          Model
          <select value={model} onChange={(event) => onModel(event.target.value)}>
            {!local.models.some(({ name }) => name === model) && (
              <option value={model}>{model || 'Choose a model'}</option>
            )}
            {local.models.map(({ name, sizeBytes }) => (
              <option key={name} value={name}>
                {name} ({gigabytes(sizeBytes)})
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="ask" role="group" aria-label="Download a model">
        <label className="wide">
          Download a model
          <input
            value={wanted}
            onChange={(event) => setWanted(event.target.value)}
            onKeyDown={(event) => {
              // Enter downloads, rather than saving the settings form around it.
              if (event.key === 'Enter') {
                event.preventDefault();
                if (!downloading && wanted.trim()) start();
              }
            }}
            placeholder={SUGGESTED_LOCAL_MODEL}
            disabled={Boolean(downloading)}
          />
        </label>
        <button
          type="button"
          className="button"
          onClick={start}
          disabled={Boolean(downloading) || !wanted.trim()}
        >
          Download
        </button>
      </div>
      <p className="muted small">
        Names come from <a href="https://ollama.com/library">Ollama's model library</a>. A 7B model
        is about 5 GB and needs a few GB of free graphics memory.
      </p>
      {download && (
        <div aria-live="polite">
          {download.error ? (
            <ErrorNote message={`The download failed: ${download.error}`} />
          ) : download.done ? (
            <p className="small">
              <span className="badge badge-good">Downloaded</span> {download.model} is ready and
              selected. Save to start using it.
            </p>
          ) : (
            <div className="goal">
              <div className="bar-label">
                <span>Downloading {download.model}</span>
                <span className="bar-value">
                  {download.total
                    ? `${gigabytes(download.completed)} of ${gigabytes(download.total)}`
                    : download.status}
                </span>
              </div>
              <Progress label={`Downloading ${download.model}`} rate={share} />
            </div>
          )}
        </div>
      )}
      <ErrorNote message={error} />
    </div>
  );
};

/** Turning the assistant on or off, for platform admins. */
export const AiSettingsPanel = ({ onChange }: { onChange: (status: AiStatus) => void }) => {
  const [saved, setSaved] = useState<AiSettings | null>(null);
  const [form, setForm] = useState<AiSettingsInput>({
    enabled: true,
    provider: 'local',
    model: '',
    baseUrl: '',
    apiKey: '',
  });
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<AiTestResult | null>(null);
  const [error, setError] = useState('');

  const apply = useCallback((settings: AiSettings): void => {
    setSaved(settings);
    setForm({
      enabled: true,
      provider: settings.provider || 'local',
      model: settings.model,
      baseUrl: settings.baseUrl,
      apiKey: '',
    });
  }, []);

  useEffect(() => {
    api
      .aiSettings()
      .then(apply)
      .catch((reason: unknown) => setError(errorText(reason)));
  }, [apply]);

  const set = <K extends keyof AiSettingsInput>(key: K, value: AiSettingsInput[K]): void => {
    setResult(null);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const onModel = useCallback((model: string) => set('model', model), []);

  if (!saved) return error ? <ErrorNote message={error} /> : <p className="empty">Loading…</p>;

  if (saved.lockedByEnv) {
    return (
      <p className="muted small">
        These settings come from <code>AI_PROVIDER</code> in <code>.env</code>, which takes priority
        over the dashboard. Change them there and restart the API.
      </p>
    );
  }

  const sameProvider = saved.provider === form.provider;
  const keyNeeded = form.provider !== 'local';
  const keySaved = sameProvider && saved.keyHint !== '';

  const test = (): void => {
    setBusy('test');
    setError('');
    setResult(null);
    api
      .testAiSettings(form)
      .then(setResult)
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(''));
  };

  const save = (enabled: boolean): void => {
    setBusy(enabled ? 'save' : 'off');
    setError('');
    api
      .saveAiSettings({ ...form, enabled })
      .then((settings) => {
        apply(settings);
        onChange(settings.status);
      })
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(''));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save(true);
  };

  return (
    <form className="stack" onSubmit={submit}>
      <p className="small">
        {saved.status.enabled ? (
          <>
            <span className="badge badge-good">On</span> {saved.status.provider},{' '}
            {saved.status.model}
          </>
        ) : (
          <span className="badge badge-neutral">Off</span>
        )}
        {saved.updatedAt ? (
          <span className="muted"> · changed {formatDateTime(saved.updatedAt)}</span>
        ) : null}
      </p>

      <fieldset className="providers">
        <legend>Provider</legend>
        {PROVIDERS.map(({ id, label, hint }) => (
          <label key={id} className="provider">
            <input
              type="radio"
              name="provider"
              value={id}
              checked={form.provider === id}
              onChange={() => {
                set('provider', id);
                set('model', saved.provider === id ? saved.model : '');
                set('baseUrl', saved.provider === id ? saved.baseUrl : '');
              }}
            />
            <span>
              <strong>{label}</strong>
              <span className="muted small"> {hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {keyNeeded && (
        <label>
          API key
          <input
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={(event) => set('apiKey', event.target.value)}
            placeholder={keySaved ? `Saved key ${saved.keyHint}. Leave empty to keep it.` : ''}
          />
          <span className="muted small">
            Stored encrypted on the server and never shown again.
            {form.provider === 'anthropic' && (
              <>
                {' '}
                Get one from the <a href="https://console.anthropic.com">Claude Console</a>.
              </>
            )}
          </span>
        </label>
      )}

      {form.provider === 'local' ? (
        <>
          <label>
            Ollama address (optional)
            <input
              value={form.baseUrl}
              onChange={(event) => set('baseUrl', event.target.value)}
              placeholder="http://localhost:11434/v1"
            />
          </label>
          <LocalSetup baseUrl={form.baseUrl} model={form.model} onModel={onModel} />
        </>
      ) : (
        <>
          <label>
            Model{form.provider === 'anthropic' ? ' (optional)' : ''}
            <input
              value={form.model}
              onChange={(event) => set('model', event.target.value)}
              placeholder={form.provider === 'anthropic' ? 'claude-opus-5-5' : 'The model name'}
            />
          </label>
          <label>
            Address (optional)
            <input
              value={form.baseUrl}
              onChange={(event) => set('baseUrl', event.target.value)}
              placeholder={
                form.provider === 'anthropic'
                  ? 'https://api.anthropic.com'
                  : 'https://api.openai.com/v1'
              }
            />
          </label>
        </>
      )}

      <div aria-live="polite">
        {result && (
          <p className="small">
            <span className={`badge ${result.ok ? 'badge-good' : 'badge-serious'}`}>
              {result.ok ? 'Live' : 'Not working'}
            </span>{' '}
            {result.message}
          </p>
        )}
      </div>
      <ErrorNote message={error} />

      <div className="actions">
        {saved.enabled && (
          <button
            type="button"
            className="button"
            onClick={() => save(false)}
            disabled={busy !== ''}
          >
            {busy === 'off' ? 'Turning off…' : 'Turn off'}
          </button>
        )}
        <button type="button" className="button" onClick={test} disabled={busy !== ''}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button type="submit" className="button primary" disabled={busy !== ''}>
          {busy === 'save' ? 'Saving…' : saved.enabled ? 'Save' : 'Save and turn on'}
        </button>
      </div>
    </form>
  );
};
