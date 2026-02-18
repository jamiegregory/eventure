import { FormEvent, useEffect, useMemo, useState } from 'react';
import { createEvent, EventItem, fetchEvents } from './api';

const initialForm = {
  title: '',
  description: '',
  startsAt: '',
};

function App() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(initialForm);

  async function loadEvents() {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchEvents();
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadEvents();
  }, []);

  const canSubmit = useMemo(() => {
    return (
      form.title.trim().length >= 3 &&
      form.description.trim().length >= 10 &&
      form.startsAt.trim().length > 0
    );
  }, [form]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      await createEvent({
        title: form.title.trim(),
        description: form.description.trim(),
        startsAt: new Date(form.startsAt).toISOString(),
      });
      setForm(initialForm);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl p-6 md:p-10">
      <header className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wider text-blue-600">Eventure Platform</p>
        <h1 className="text-3xl font-bold text-slate-900">Event management dashboard</h1>
        <p className="mt-2 text-slate-600">Create and browse events backed by a Node.js REST API and PostgreSQL.</p>
      </header>

      <section className="mb-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold">Create event</h2>

        <form className="grid gap-4" onSubmit={handleSubmit}>
          <input
            className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500"
            placeholder="Event title"
            value={form.title}
            onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
          />
          <textarea
            className="min-h-28 w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500"
            placeholder="Event description"
            value={form.description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          />
          <input
            className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500"
            type="datetime-local"
            value={form.startsAt}
            onChange={(event) => setForm((prev) => ({ ...prev, startsAt: event.target.value }))}
          />

          <button
            className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!canSubmit || submitting}
            type="submit"
          >
            {submitting ? 'Saving…' : 'Create event'}
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Upcoming events</h2>
          <button className="rounded-lg border border-slate-300 px-3 py-1 text-sm" onClick={() => void loadEvents()}>
            Refresh
          </button>
        </div>

        {error && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-rose-700">{error}</p>}

        {loading ? (
          <p className="text-slate-500">Loading events…</p>
        ) : events.length === 0 ? (
          <p className="text-slate-500">No events yet. Create your first one.</p>
        ) : (
          <ul className="grid gap-3">
            {events.map((event) => (
              <li className="rounded-xl border border-slate-200 p-4" key={event.id}>
                <h3 className="font-semibold text-slate-900">{event.title}</h3>
                <p className="mt-1 text-slate-600">{event.description}</p>
                <p className="mt-2 text-sm text-slate-500">{new Date(event.starts_at).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export default App;
