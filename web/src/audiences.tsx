import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Segment, type User } from './api';
import { ErrorNote, firstError } from './ui';

export const AudiencesPage = ({ user }: { user: User }) => {
  const canEdit = user.organisationRole === 'OWNER' || user.organisationRole === 'MANAGER';
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [allGenres, setAllGenres] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [genres, setGenres] = useState<string[]>([]);
  const [minViews, setMinViews] = useState('3');
  const [error, setError] = useState('');

  const fail = (reason: ApiError) => setError(firstError(reason));

  const load = useCallback(() => {
    api.segments().then(setSegments).catch(fail);
  }, []);

  useEffect(() => {
    load();
    api
      .shows()
      .then((shows) => setAllGenres([...new Set(shows.map((show) => show.genre))].sort()))
      .catch(fail);
  }, [load]);

  const create = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    api
      .createSegment(name, genres, Number(minViews))
      .then(() => {
        setName('');
        setGenres([]);
        load();
      })
      .catch(fail);
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Audiences</h1>
          <p className="muted">
            Groups of viewers by what they watch. Only viewers who consented are ever included.
          </p>
        </div>
      </header>

      <ErrorNote message={error} />

      <section className="card">
        <h2>Your audiences</h2>
        {segments?.length === 0 && <p className="muted">No audiences yet.</p>}
        <ul className="rows">
          {segments?.map((segment) => (
            <li key={segment.id}>
              <span>
                {segment.name}
                <span className="muted small">
                  {' '}
                  · {segment.genres.join(', ')} · {segment.minViews}+ views
                </span>
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="button"
                  aria-label={`Delete ${segment.name}`}
                  onClick={() => {
                    api.deleteSegment(segment.id).then(load).catch(fail);
                  }}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {canEdit && (
        <section className="card">
          <h2>New audience</h2>
          <form className="stack" onSubmit={create}>
            <div className="fields">
              <label>
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                />
              </label>
              <label>
                Views needed to qualify
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={minViews}
                  onChange={(event) => setMinViews(event.target.value)}
                  required
                />
              </label>
            </div>
            <fieldset className="checks">
              <legend>Interested in</legend>
              {allGenres.map((genre) => (
                <label key={genre}>
                  <input
                    type="checkbox"
                    checked={genres.includes(genre)}
                    onChange={(event) =>
                      setGenres(
                        event.target.checked
                          ? [...genres, genre]
                          : genres.filter((item) => item !== genre),
                      )
                    }
                  />
                  {genre}
                </label>
              ))}
            </fieldset>
            <div>
              <button type="submit" className="button primary" disabled={genres.length === 0}>
                Create audience
              </button>
            </div>
          </form>
        </section>
      )}
    </>
  );
};
