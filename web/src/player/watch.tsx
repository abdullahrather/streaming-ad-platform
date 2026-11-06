import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { COUNTRY_LABELS, DEVICE_LABELS } from '../format';
import { playAd, requestAd, type AdBreakRequest, type VastAd } from './ad-sdk';
import './watch.css';

interface Show {
  id: string;
  title: string;
  genre: string;
  videoUrl: string;
  posterUrl: string;
}

interface LogLine {
  id: number;
  time: string;
  text: string;
}

type Slot = AdBreakRequest['slot'];

const SLOT_NAMES: Record<Slot, string> = {
  PRE_ROLL: 'Pre-roll',
  MID_ROLL: 'Mid-roll',
  POST_ROLL: 'Post-roll',
};

const EVENT_NAMES: Record<string, string> = {
  impression: 'Impression counted',
  start: 'Ad started',
  firstQuartile: 'Reached 25%',
  midpoint: 'Reached 50%',
  thirdQuartile: 'Reached 75%',
  complete: 'Watched to the end',
};

const VIEWER_KEY = 'northlight-viewer';
const CONSENT_KEY = 'northlight-consent';
const MID_ROLL_ADS = 2;

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const store = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice then lasts for this visit.
  }
};

const viewerId = (): string => {
  const existing = stored(VIEWER_KEY);
  if (existing) return existing;

  const id = crypto.randomUUID();
  store(VIEWER_KEY, id);
  return id;
};

/** A real site would get this from its own server, which holds the ad server key. */
const playerToken = async (consent: boolean): Promise<string> => {
  const response = await fetch('/player/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ viewerId: viewerId(), consent }),
  });
  if (!response.ok) throw new Error('Ads are not available on this site.');

  const { data } = (await response.json()) as { data: { token: string } };
  return data.token;
};

const Watch = ({ show, onBack }: { show: Show; onBack: () => void }) => {
  const episode = useRef<HTMLVideoElement>(null);
  const adVideo = useRef<HTMLVideoElement>(null);
  const midRollDone = useRef(false);
  const nextLine = useRef(0);

  const [country, setCountry] = useState('DE');
  const [device, setDevice] = useState('CTV');
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [currentAd, setCurrentAd] = useState<VastAd | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [consent, setConsent] = useState(stored(CONSENT_KEY) === 'yes');

  const write = (text: string): void => {
    nextLine.current += 1;
    const line = {
      id: nextLine.current,
      time: new Date().toLocaleTimeString('en-GB'),
      text,
    };
    setLog((lines) => [line, ...lines].slice(0, 40));
  };

  /** Plays one ad. Returns false when there's nothing to play. */
  const playOne = async (slot: Slot, breakId: string, token: string): Promise<boolean> => {
    const ad = await requestAd({
      serverUrl: '/vast',
      token,
      showId: show.id,
      slot,
      country,
      device,
      breakId,
    });
    if (!ad || !adVideo.current) {
      write('No eligible ad for this position');
      return false;
    }

    write(`Serving ${ad.advertiser}: ${ad.title}`);
    setCurrentAd(ad);
    await playAd(adVideo.current, ad, {
      onEvent: (event) => write(EVENT_NAMES[event] ?? event),
      onProgress: setSecondsLeft,
    });
    return true;
  };

  /** Runs one ad break. Any problem falls through to the show. */
  const runAdBreak = async (slot: Slot, ads = 1): Promise<void> => {
    write(`${SLOT_NAMES[slot]} break: asking the ad server`);
    try {
      const breakId = crypto.randomUUID();
      const token = await playerToken(consent);
      for (let position = 0; position < ads; position += 1) {
        if (!(await playOne(slot, breakId, token))) break;
      }
    } catch (error) {
      write(`Skipped: ${(error as Error).message}`);
    } finally {
      setCurrentAd(null);
    }
  };

  const saveConsent = (allowed: boolean): void => {
    setConsent(allowed);
    store(CONSENT_KEY, allowed ? 'yes' : 'no');
  };

  /** Saying no later also deletes the profile built while it was yes. */
  const changeConsent = async (allowed: boolean): Promise<void> => {
    saveConsent(allowed);
    if (allowed) return;
    const token = await playerToken(false);
    await fetch(`/player/profile?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    write('Consent withdrawn: viewing profile deleted');
  };

  const downloadData = async (): Promise<void> => {
    const token = await playerToken(consent);
    const response = await fetch(`/player/data?token=${encodeURIComponent(token)}`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'viewer-data.json';
    link.click();
    URL.revokeObjectURL(url);
    write('Your data was downloaded');
  };

  const deleteData = async (): Promise<void> => {
    const token = await playerToken(false);
    await fetch(`/player/data?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    saveConsent(false);
    write('Everything held about you was deleted');
  };

  const start = async (): Promise<void> => {
    setStarted(true);
    await runAdBreak('PRE_ROLL');
    write('Show started');
    await episode.current?.play().catch(() => undefined);
  };

  const onTimeUpdate = (): void => {
    const video = episode.current;
    if (!video?.duration || midRollDone.current) return;
    if (video.currentTime / video.duration < 0.5) return;

    midRollDone.current = true;
    video.pause();
    void runAdBreak('MID_ROLL', MID_ROLL_ADS).then(() => {
      write('Show resumed');
      return video.play().catch(() => undefined);
    });
  };

  const onEnded = async (): Promise<void> => {
    write('Show ended');
    await runAdBreak('POST_ROLL');
    setFinished(true);
  };

  const learnMore = (): void => {
    if (!currentAd) return;
    write('Viewer clicked the ad');
    window.open(currentAd.clickThroughUrl, '_blank', 'noopener');
  };

  return (
    <main className="watch">
      <button type="button" className="text-button" onClick={onBack}>
        ← All shows
      </button>

      <div className="stage">
        <div className="screen">
          <video
            ref={episode}
            src={show.videoUrl}
            poster={show.posterUrl}
            controls={started && !currentAd}
            hidden={Boolean(currentAd)}
            playsInline
            onTimeUpdate={onTimeUpdate}
            onEnded={() => void onEnded()}
          />
          <video ref={adVideo} hidden={!currentAd} playsInline aria-label="Advertisement" />

          {currentAd && (
            <div className="ad-bar">
              <span>
                Ad · {currentAd.advertiser} · {secondsLeft}s
              </span>
              <button type="button" onClick={learnMore}>
                Learn more
              </button>
            </div>
          )}

          {!started && (
            <button type="button" className="play" onClick={() => void start()}>
              ▶ Play
            </button>
          )}
          {finished && <p className="finished">Thanks for watching</p>}
        </div>

        <aside className="panel">
          <h2>Pretend you are watching from</h2>
          <label>
            Country
            <select
              value={country}
              disabled={started}
              onChange={(event) => setCountry(event.target.value)}
            >
              {Object.entries(COUNTRY_LABELS).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Device
            <select
              value={device}
              disabled={started}
              onChange={(event) => setDevice(event.target.value)}
            >
              {Object.entries(DEVICE_LABELS).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => void changeConsent(event.target.checked)}
            />
            Use what I watch to choose ads
          </label>
          <button type="button" className="text-button" onClick={() => void downloadData()}>
            Download my data
          </button>
          <button type="button" className="text-button" onClick={() => void deleteData()}>
            Delete my data
          </button>

          <h2>What the player reports</h2>
          <ol className="log" aria-live="polite">
            {log.length === 0 && <li className="quiet">Press play to begin.</li>}
            {log.map((line) => (
              <li key={line.id}>
                <span>{line.time}</span> {line.text}
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <h1>{show.title}</h1>
      <p className="quiet">{show.genre} · Episode 1 · Ads play before, during and after.</p>
    </main>
  );
};

const App = () => {
  const [shows, setShows] = useState<Show[] | null>(null);
  const [selected, setSelected] = useState<Show | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/player/catalogue')
      .then((response) => response.json() as Promise<{ data: Show[] }>)
      .then(({ data }) => setShows(data))
      .catch(() => setError('The catalogue could not be loaded.'));
  }, []);

  return (
    <>
      <header className="site-header">
        <button type="button" className="logo" onClick={() => setSelected(null)}>
          Northlight
        </button>
        <span className="quiet">Demo streaming site. All shows and ads are fictional.</span>
      </header>

      {selected ? (
        <Watch key={selected.id} show={selected} onBack={() => setSelected(null)} />
      ) : (
        <main className="catalogue">
          <h1>Watch now</h1>
          {error && <p role="alert">{error}</p>}
          {shows?.length === 0 && (
            <p className="quiet">No episodes yet. Run the demo data seed to create them.</p>
          )}
          <ul className="shows">
            {shows?.map((show) => (
              <li key={show.id}>
                <button type="button" onClick={() => setSelected(show)}>
                  <img src={show.posterUrl} alt="" />
                  <strong>{show.title}</strong>
                  <span className="quiet">{show.genre}</span>
                </button>
              </li>
            ))}
          </ul>
        </main>
      )}
    </>
  );
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
