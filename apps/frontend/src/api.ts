export type EventItem = {
  id: number;
  title: string;
  description: string;
  starts_at: string;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export async function fetchEvents(): Promise<EventItem[]> {
  const response = await fetch(`${API_BASE_URL}/api/events`);
  if (!response.ok) {
    throw new Error('Failed to fetch events');
  }

  const payload = (await response.json()) as { data: EventItem[] };
  return payload.data;
}

export async function createEvent(input: {
  title: string;
  description: string;
  startsAt: string;
}): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error('Failed to create event');
  }
}
