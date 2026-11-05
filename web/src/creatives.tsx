import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type AiReview,
  type Creative,
  type CreativeStatus,
  type ReviewItem,
} from './api';
import { formatDateTime } from './format';
import { ErrorNote, firstError } from './ui';

const STATUS: Record<CreativeStatus, { label: string; tone: string }> = {
  PROCESSING: { label: 'Converting', tone: 'neutral' },
  PENDING_REVIEW: { label: 'Waiting for review', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'good' },
  REJECTED: { label: 'Rejected', tone: 'serious' },
  FAILED: { label: 'Failed', tone: 'serious' },
};

const REFRESH_MS = 2000;

const COMPARISON: Record<NonNullable<Creative['comparison']>, string> = {
  LEADING: 'Winning, with 95% confidence',
  BEHIND: 'Losing, with 95% confidence',
  TOO_CLOSE: 'Too close to call',
  NOT_ENOUGH_DATA: 'Needs at least 1,000 impressions per ad',
};

const Results = ({ creative }: { creative: Creative }) => {
  const { results, comparison } = creative;
  if (!results || results.impressions === 0) return null;

  return (
    <p className="small">
      {results.impressions.toLocaleString('en')} impressions · {(results.ctr * 100).toFixed(2)}% CTR
      · {Math.round(results.completionRate * 100)}% finished
      {comparison && <span className="muted"> · {COMPARISON[comparison]}</span>}
    </p>
  );
};

const CreativeBadge = ({ status }: { status: CreativeStatus }) => {
  const { label, tone } = STATUS[status];
  return <span className={`badge badge-${tone}`}>{label}</span>;
};

const UploadForm = ({ campaignId, onDone }: { campaignId: string; onDone: () => void }) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [clickUrl, setClickUrl] = useState('https://');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;

    setUploading(true);
    setError('');
    api
      .uploadCreative(campaignId, name, clickUrl, file)
      .then(() => {
        setName('');
        setClickUrl('https://');
        if (fileInput.current) fileInput.current.value = '';
        onDone();
      })
      .catch((reason: ApiError) => setError(firstError(reason)))
      .finally(() => setUploading(false));
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="fields">
        <label>
          Ad name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={2}
          />
        </label>
        <label>
          Where clicks go
          <input
            type="url"
            value={clickUrl}
            onChange={(event) => setClickUrl(event.target.value)}
            required
          />
        </label>
        <label className="wide">
          Video file
          <input ref={fileInput} type="file" accept="video/*" required />
        </label>
      </div>
      <p className="hint">5 to 120 seconds, at least 240 pixels tall. MP4 works best.</p>
      <ErrorNote message={error} />
      <div>
        <button type="submit" className="button primary" disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload ad'}
        </button>
      </div>
    </form>
  );
};

/** The ads inside a campaign, and uploading new ones. */
export const CampaignAds = ({ campaignId, canEdit }: { campaignId: string; canEdit: boolean }) => {
  const [creatives, setCreatives] = useState<Creative[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .creatives(campaignId)
      .then(setCreatives)
      .catch((reason: ApiError) => setError(firstError(reason)));
  }, [campaignId]);

  useEffect(load, [load]);

  const converting = creatives?.some(({ status }) => status === 'PROCESSING');

  useEffect(() => {
    if (!converting) return undefined;
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [converting, load]);

  const remove = (creative: Creative) => {
    if (!window.confirm(`Delete “${creative.name}”?`)) return;
    api
      .deleteCreative(creative.id)
      .then(load)
      .catch((reason: ApiError) => setError(firstError(reason)));
  };

  const hasApproved = creatives?.some(({ status }) => status === 'APPROVED');

  return (
    <section className="card">
      <h2>Video ads</h2>
      <ErrorNote message={error} />
      {creatives?.length === 0 && (
        <p className="muted">
          No ads yet. Viewers can only see this campaign once one is approved.
        </p>
      )}
      {creatives && creatives.length > 0 && !hasApproved && (
        <p className="muted">
          No approved ads yet, so this campaign won't appear in real video players.
        </p>
      )}
      <ul className="ad-list">
        {creatives?.map((creative) => (
          <li key={creative.id}>
            {creative.videoUrl ? (
              <video
                src={creative.videoUrl}
                poster={creative.posterUrl}
                controls
                preload="none"
                aria-label={`Preview of ${creative.name}`}
              />
            ) : (
              <div className="ad-placeholder">Converting…</div>
            )}
            <div>
              <strong>{creative.name}</strong>
              <div className="badges">
                <CreativeBadge status={creative.status} />
                {creative.durationSeconds > 0 && (
                  <span className="muted small">{Math.round(creative.durationSeconds)}s</span>
                )}
              </div>
              <Results creative={creative} />
              {canEdit && creative.status === 'APPROVED' && (
                <label className="share">
                  Share of delivery
                  <input
                    type="number"
                    min="0"
                    max="100"
                    defaultValue={creative.weight}
                    onBlur={(event) => {
                      api
                        .setCreativeWeight(creative.id, Number(event.target.value))
                        .then(load)
                        .catch((reason: ApiError) => setError(firstError(reason)));
                    }}
                  />
                </label>
              )}
              {creative.rejectionReason && (
                <p className="small">Reviewer: {creative.rejectionReason}</p>
              )}
              {creative.failureReason && <p className="small">{creative.failureReason}</p>}
              {canEdit && (
                <button
                  type="button"
                  className="link"
                  aria-label={`Delete ${creative.name}`}
                  onClick={() => remove(creative)}
                >
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {canEdit && (
        <>
          <h3>Upload an ad</h3>
          <UploadForm campaignId={campaignId} onDone={load} />
        </>
      )}
    </section>
  );
};

/** The AI assistant's first look at the poster frame. Advice only: the reviewer decides. */
const AiAdvice = ({ review }: { review: AiReview }) => (
  <aside className="ai-advice" aria-label="AI assistant's first look">
    <p className="small">
      <span
        className={`badge ${review.verdict === 'needs_attention' ? 'badge-serious' : 'badge-neutral'}`}
      >
        {review.status === 'unavailable'
          ? 'AI check unavailable'
          : review.verdict === 'needs_attention'
            ? 'AI: worth a closer look'
            : 'AI: nothing flagged'}
      </span>{' '}
      {review.summary}
    </p>
    {review.issues && review.issues.length > 0 && (
      <ul className="small">
        {review.issues.map((issue, index) => (
          <li key={index}>
            <strong>{issue.kind}:</strong> {issue.detail}
          </li>
        ))}
      </ul>
    )}
    <p className="muted small">
      From the poster frame only, by {review.model}. It can miss things, so watch the video.
    </p>
  </aside>
);

const ReviewCard = ({ item, onDone }: { item: ReviewItem; onDone: () => void }) => {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const decide = (decision: 'APPROVE' | 'REJECT') => {
    setError('');
    api
      .reviewCreative(item.id, decision, reason)
      .then(onDone)
      .catch((failure: ApiError) => setError(firstError(failure)));
  };

  return (
    <article className="card review-card">
      <video
        src={item.videoUrl}
        poster={item.posterUrl}
        controls
        preload="none"
        aria-label={`Preview of ${item.name}`}
      />
      <div className="stack">
        <div>
          <h2>{item.name}</h2>
          <p className="muted small">{item.campaignTitle}</p>
          <p className="muted small">
            {Math.round(item.durationSeconds)}s · {item.width}×{item.height} · uploaded{' '}
            {formatDateTime(item.createdAt)}
          </p>
          <p className="small">
            Clicks go to <a href={item.clickUrl}>{item.clickUrl}</a>
          </p>
        </div>

        {item.aiReview && <AiAdvice review={item.aiReview} />}

        {rejecting && (
          <label>
            Why is it being rejected?
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={5}
            />
          </label>
        )}
        <ErrorNote message={error} />
        <div className="toolbar">
          {!rejecting && (
            <button
              type="button"
              className="button primary"
              aria-label={`Approve ${item.name}`}
              onClick={() => decide('APPROVE')}
            >
              Approve
            </button>
          )}
          <button
            type="button"
            className="button danger"
            aria-label={`Reject ${item.name}`}
            onClick={() => (rejecting ? decide('REJECT') : setRejecting(true))}
          >
            {rejecting ? 'Confirm rejection' : 'Reject'}
          </button>
          {rejecting && (
            <button type="button" className="button" onClick={() => setRejecting(false)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </article>
  );
};

export const ReviewPage = () => {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .reviewQueue()
      .then(setItems)
      .catch((reason: ApiError) => setError(firstError(reason)));
  }, []);

  useEffect(load, [load]);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Ad review</h1>
          <p className="muted">Ads can't reach viewers until they're approved here.</p>
        </div>
      </header>
      <ErrorNote message={error} />
      {items?.length === 0 && <p className="empty card">Nothing is waiting for review.</p>}
      {items?.map((item) => (
        <ReviewCard key={item.id} item={item} onDone={load} />
      ))}
    </>
  );
};
