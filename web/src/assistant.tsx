import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  type AiStatus,
  type CampaignDraft,
  type Diagnosis,
  type Recommendation,
  type User,
} from './api';
import { AiSettingsPanel } from './ai-settings';
import { formatDateTime, formatNumber } from './format';
import { ErrorNote, firstError } from './ui';
import { t } from './i18n';

const errorText = (reason: unknown): string =>
  reason instanceof ApiError ? firstError(reason) : String(reason);

/** Loads whether the assistant is on, once per page. */
export const useAiStatus = (): AiStatus | null => {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    api
      .aiStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, provider: '', model: '', reason: '', source: '' }));
  }, []);
  return status;
};

export const canManage = (user: User): boolean =>
  user.role === 'ADMIN' ||
  (user.role !== 'GUEST' &&
    (user.organisationRole === 'OWNER' || user.organisationRole === 'MANAGER'));

/** Shown wherever an AI feature would be, when the assistant is off. */
const AiOff = ({ status }: { status: AiStatus }) => (
  <div className="ai-off">
    <p>
      <strong>{t('The AI assistant is off.')}</strong>{' '}
      {status.reason.replace(/^The AI assistant is off\.\s*/, '')}
    </p>
    <p className="muted small">
      {t(
        "It's optional: everything else works without it. A platform admin turns it on from the Assistant page, with Claude, an OpenAI-compatible API, or a free local model through Ollama.",
      )}
    </p>
  </div>
);

const TOOL_NAMES: Record<string, string> = {
  list_campaigns: t('campaign list'),
  diagnose_campaign: t('delivery check'),
  campaign_details: t('campaign details'),
  run_report: t('a report'),
  list_alerts: t('alerts'),
};

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
}

const Conversation = ({
  campaignId,
  examples,
}: {
  campaignId: string | null;
  examples: string[];
}) => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [turns]);

  const ask = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const history = turns.slice(-6).map(({ role, content }) => ({ role, content }));
    setTurns((current) => [...current, { role: 'user', content: trimmed }]);
    setQuestion('');
    setBusy(true);
    setError('');
    api
      .ask(trimmed, campaignId, history)
      .then((answer) =>
        setTurns((current) => [
          ...current,
          { role: 'assistant', content: answer.answer, toolsUsed: answer.toolsUsed },
        ]),
      )
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    ask(question);
  };

  return (
    <div className="conversation">
      {turns.length === 0 && (
        <div className="examples">
          <p className="muted small">{t('Try asking:')}</p>
          {examples.map((example) => (
            <button key={example} type="button" className="button" onClick={() => ask(example)}>
              {example}
            </button>
          ))}
        </div>
      )}
      <ol className="turns" aria-live="polite">
        {turns.map((turn, index) => (
          <li key={index} className={`turn turn-${turn.role}`}>
            <span className="sr-only">
              {turn.role === 'user' ? t('You asked:') : t('Assistant:')}
            </span>
            <p className="turn-text">{turn.content}</p>
            {turn.toolsUsed && turn.toolsUsed.length > 0 && (
              <p className="muted small">
                {t('Looked at: {join}', {
                  join: turn.toolsUsed.map((tool) => TOOL_NAMES[tool] ?? tool).join(', '),
                })}
              </p>
            )}
          </li>
        ))}
        {busy && (
          <li className="turn turn-assistant muted" aria-label={t('The assistant is working')}>
            {t('Looking at your data…')}
          </li>
        )}
      </ol>
      <div ref={end} />
      <ErrorNote message={error} />
      <form className="ask" onSubmit={submit}>
        <label className="wide">
          <span className="sr-only">{t('Your question')}</span>
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t('Ask about your campaigns')}
            maxLength={1000}
            disabled={busy}
          />
        </label>
        <button type="submit" className="button primary" disabled={busy || !question.trim()}>
          {t('Ask')}
        </button>
      </form>
      <p className="muted small">
        {t(
          'Answers come from your own campaign data, through read-only tools. The AI can be wrong, so check important numbers on the dashboard.',
        )}
      </p>
    </div>
  );
};

export const AssistantPage = ({ user }: { user: User }) => {
  const loaded = useAiStatus();
  const [changed, setChanged] = useState<AiStatus | null>(null);
  const status = changed ?? loaded;
  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t('Assistant')}</h1>
          <p className="muted">
            {status?.enabled
              ? t('Ask about your campaigns in plain language. Using {provider}, {model}.', {
                  provider: status.provider,
                  model: status.model,
                })
              : t('Ask about your campaigns in plain language.')}
          </p>
        </div>
      </header>
      <section className="card">
        {status === null ? (
          <p className="empty">{t('Loading…')}</p>
        ) : status.enabled ? (
          <Conversation
            campaignId={null}
            examples={[
              t('Which campaigns are behind, and why?'),
              t('How did last week compare with the week before?'),
              t('Which ad slot keeps viewers watching longest?'),
            ]}
          />
        ) : (
          <AiOff status={status} />
        )}
      </section>
      {user.role === 'ADMIN' && status && (
        <section className="card">
          <details open={!loaded?.enabled}>
            <summary>
              <h2 className="inline-heading">{t('Settings')}</h2>
            </summary>
            <p className="muted small">
              {t('Only platform admins see this. Changes apply at once, with no restart.')}
            </p>
            <AiSettingsPanel onChange={setChanged} />
          </details>
        </section>
      )}
    </>
  );
};

const SEVERITY: Record<string, { label: string; tone: string }> = {
  blocker: { label: t('Blocking'), tone: 'serious' },
  limit: { label: t('Limit'), tone: 'warning' },
  info: { label: t('Context'), tone: 'neutral' },
};

/** Why a campaign is behind, from its own data. Needs no AI. */
export const DeliveryCheck = ({ campaignId }: { campaignId: string }) => {
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .diagnosis(campaignId)
      .then(setDiagnosis)
      .catch((reason: unknown) => setError(errorText(reason)));
  }, [campaignId]);

  return (
    <section className="card">
      <h2>{t('Delivery check')}</h2>
      <ErrorNote message={error} />
      {diagnosis ? (
        <>
          <p>{diagnosis.summary}</p>
          {diagnosis.factors.length > 0 && (
            <ul className="factors">
              {diagnosis.factors.map((factor) => {
                const severity = SEVERITY[factor.severity] ?? SEVERITY['info']!;
                return (
                  <li key={factor.code}>
                    <span className={`badge badge-${severity.tone}`}>{severity.label}</span>{' '}
                    <strong>{factor.title}.</strong> {factor.detail}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted small">
            {t("Worked out from this campaign's data and the delivery forecast, with no AI.")}
          </p>
        </>
      ) : (
        !error && <p className="empty">{t('Checking…')}</p>
      )}
    </section>
  );
};

const FIELD_NAMES: Record<string, string> = {
  budgetCents: t('Budget'),
  dailyBudgetCents: t('Daily budget'),
  cpmCents: 'CPM',
  pacingMode: t('Pacing'),
  dailyImpressionTarget: t('Daily impression target'),
  frequencyCapPerDay: t('Frequency cap per day'),
  targetCountries: t('Countries'),
  targetDevices: t('Devices'),
  targetSlots: t('Ad slots'),
  targetGenres: t('Genres'),
  activeHours: t('Hours'),
  activeDays: t('Days'),
};

const showValue = (field: string, value: unknown): string => {
  if (value === null || value === undefined) return t('none');
  if (Array.isArray(value)) return value.length === 0 ? t('all') : value.join(', ');
  if (field.endsWith('Cents') && typeof value === 'number') return `€${formatNumber(value / 100)}`;
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
};

const STATUS_LABELS: Record<Recommendation['status'], string> = {
  PENDING: t('Waiting for approval'),
  APPLIED: t('Applied'),
  REJECTED: t('Turned down'),
  STALE: t('Out of date'),
};

const Recommendations = ({
  campaignId,
  manages,
  onApplied,
}: {
  campaignId: string;
  manages: boolean;
  onApplied: () => void;
}) => {
  const [items, setItems] = useState<Recommendation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = (): void => {
    api
      .recommendations(campaignId)
      .then(setItems)
      .catch((reason: unknown) => setError(errorText(reason)));
  };
  useEffect(load, [campaignId]);

  const suggest = (): void => {
    setBusy(true);
    setError('');
    api
      .recommend(campaignId)
      .then((created) => {
        if (created.length === 0) setError(t('The assistant found nothing that needs changing.'));
        load();
      })
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };

  const decide = (id: string, decision: 'approve' | 'reject'): void => {
    setError('');
    api
      .decide(id, decision)
      .then(() => {
        load();
        if (decision === 'approve') onApplied();
      })
      .catch((reason: unknown) => {
        setError(errorText(reason));
        load();
      });
  };

  return (
    <div>
      <div className="card-header">
        <h3>{t('Recommendations')}</h3>
        {manages && (
          <button type="button" className="button" onClick={suggest} disabled={busy}>
            {busy ? t('Thinking…') : t('Suggest changes')}
          </button>
        )}
      </div>
      <p className="muted small">
        {t(
          'Suggestions change nothing until an owner or manager approves them, and an approval is refused if the campaign changed in the meantime.',
        )}
      </p>
      <ErrorNote message={error} />
      {items && items.length > 0 && (
        <ul className="recommendations">
          {items.map((item) => (
            <li key={item.id}>
              <p>
                <strong>{item.title}</strong>{' '}
                <span className="muted small">
                  · {STATUS_LABELS[item.status]} · {formatDateTime(item.createdAt)}
                </span>
              </p>
              <p>{item.reason}</p>
              <ul className="changes" aria-label={t('Changes')}>
                {Object.keys(item.change).map((field) => (
                  <li key={field}>
                    {FIELD_NAMES[field] ?? field}: {showValue(field, item.before[field])} →{' '}
                    <strong>{showValue(field, item.change[field])}</strong>
                  </li>
                ))}
              </ul>
              {manages && item.status === 'PENDING' && (
                <div className="actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => decide(item.id, 'reject')}
                  >
                    {t('Turn down')}
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => decide(item.id, 'approve')}
                  >
                    {t('Apply change')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** The assistant on a campaign's page: questions about it, and suggested changes. */
export const CampaignAssistant = ({
  campaignId,
  user,
  onApplied,
}: {
  campaignId: string;
  user: User;
  onApplied: () => void;
}) => {
  const status = useAiStatus();
  if (!status) return null;
  return (
    <section className="card">
      <h2>{t('Assistant')}</h2>
      {status.enabled ? (
        <>
          <Conversation
            campaignId={campaignId}
            examples={[
              t('Why is this campaign behind?'),
              t('How did it do this week compared with last?'),
            ]}
          />
          <Recommendations
            campaignId={campaignId}
            manages={canManage(user)}
            onApplied={onApplied}
          />
        </>
      ) : (
        <AiOff status={status} />
      )}
    </section>
  );
};

/** Turns a written brief into campaign form values, for the person to check and save. */
export const DraftFromBrief = ({
  onClose,
  onDraft,
}: {
  onClose: () => void;
  onDraft: (draft: CampaignDraft) => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError('');
    api
      .draftCampaign(brief)
      .then(onDraft)
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="brief-title">
      <form className="stack" onSubmit={submit}>
        <h2 id="brief-title">{t('Draft a campaign from a brief')}</h2>
        <label>
          {t('Describe the campaign in your own words')}
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            rows={6}
            maxLength={4000}
            placeholder={t(
              'For example: Spring coats for Nordkap Outdoor, €20,000 over four weeks from 1 March, connected TV in Germany and Austria, evenings, drama and crime fans, at most 3 views a day.',
            )}
          />
        </label>
        <p className="muted small">
          {t(
            'The assistant fills in the campaign form. Nothing is saved until you check it and press Create.',
          )}
        </p>
        <ErrorNote message={error} />
        <div className="actions">
          <button type="button" className="button" onClick={() => dialog.current?.close()}>
            {t('Cancel')}
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || brief.trim().length < 10}
          >
            {busy ? t('Drafting…') : t('Draft campaign')}
          </button>
        </div>
      </form>
    </dialog>
  );
};
