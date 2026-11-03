/**
 * Player SDK: asks an ad server for an ad in VAST, plays it in a <video>
 * element, and reports impressions, quartiles and completion back to the
 * links in the VAST. It has no dependencies, and works with any VAST 4 server.
 */
export type TrackingEvent = 'start' | 'firstQuartile' | 'midpoint' | 'thirdQuartile' | 'complete';

export interface VastAd {
  id: string;
  title: string;
  advertiser: string;
  mediaUrl: string;
  clickThroughUrl: string;
  impressionUrl: string;
  tracking: Partial<Record<TrackingEvent, string>>;
}

export interface AdBreakRequest {
  serverUrl: string;
  /** A short-lived player token from the publisher's server. */
  token: string;
  showId: string;
  slot: 'PRE_ROLL' | 'MID_ROLL' | 'POST_ROLL';
  country: string;
  device: string;
  /** Ads sharing a break ID never come from rival brands. */
  breakId?: string;
}

export interface AdCallbacks {
  /** Called as each event is reported, with its name. */
  onEvent?: (event: string) => void;
  /** Called while the ad plays, with the seconds left. */
  onProgress?: (secondsLeft: number) => void;
}

const QUARTILES: Array<[fraction: number, event: TrackingEvent]> = [
  [0.25, 'firstQuartile'],
  [0.5, 'midpoint'],
  [0.75, 'thirdQuartile'],
];

const text = (root: ParentNode, selector: string): string =>
  root.querySelector(selector)?.textContent?.trim() ?? '';

/** Reads VAST XML. Returns null when it holds no ad. */
export const parseVast = (xml: string): VastAd | null => {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('The ad server sent invalid VAST.');

  const ad = document.querySelector('Ad');
  const mediaUrl = ad ? text(ad, 'MediaFile') : '';
  if (!ad || !mediaUrl) return null;

  const tracking: VastAd['tracking'] = {};
  ad.querySelectorAll('Tracking').forEach((element) => {
    const event = element.getAttribute('event') as TrackingEvent | null;
    if (event) tracking[event] = element.textContent?.trim() ?? '';
  });

  return {
    id: ad.getAttribute('id') ?? '',
    title: text(ad, 'AdTitle'),
    advertiser: text(ad, 'Advertiser'),
    mediaUrl,
    clickThroughUrl: text(ad, 'ClickThrough'),
    impressionUrl: text(ad, 'Impression'),
    tracking,
  };
};

export const requestAd = async (request: AdBreakRequest): Promise<VastAd | null> => {
  const { serverUrl, ...placement } = request;
  const provided = Object.entries(placement).filter(([, value]) => value !== undefined);
  const response = await fetch(`${serverUrl}?${new URLSearchParams(provided).toString()}`);
  if (!response.ok) throw new Error(`The ad server responded with ${response.status}.`);
  return parseVast(await response.text());
};

/** Reporting must never interrupt playback, and should survive the page closing. */
const report = (url: string | undefined): void => {
  if (url) void fetch(url, { keepalive: true }).catch(() => undefined);
};

/**
 * Plays one ad to the end. Resolves when it finishes, including if it fails to
 * play, so a broken ad can never block the show.
 */
export const playAd = (
  video: HTMLVideoElement,
  ad: VastAd,
  { onEvent, onProgress }: AdCallbacks = {},
): Promise<void> =>
  new Promise((resolve) => {
    let started = false;
    const reached = new Set<TrackingEvent>();

    const fire = (event: TrackingEvent): void => {
      report(ad.tracking[event]);
      onEvent?.(event);
    };

    const finish = (): void => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', finish);
      video.removeAttribute('src');
      video.load();
      resolve();
    };

    const onPlaying = (): void => {
      if (started) return;
      started = true;
      report(ad.impressionUrl);
      onEvent?.('impression');
      fire('start');
    };

    const onTimeUpdate = (): void => {
      if (!video.duration) return;
      onProgress?.(Math.ceil(video.duration - video.currentTime));

      for (const [fraction, event] of QUARTILES) {
        if (video.currentTime / video.duration >= fraction && !reached.has(event)) {
          reached.add(event);
          fire(event);
        }
      }
    };

    const onEnded = (): void => {
      fire('complete');
      finish();
    };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', finish);

    video.src = ad.mediaUrl;
    video.play().catch(() => {
      // Browsers can refuse sound without a recent click, so try again muted.
      video.muted = true;
      video.play().catch(finish);
    });
  });
