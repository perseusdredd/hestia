/** Serializable view model passed from the calendar page to client components. */
export type CalEvent = {
  /** The underlying event (links, edit, delete). */
  id: string;
  /** Unique per rendered occurrence; equals `id` for a non-recurring event. */
  key: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** Istanbul wall time of the event itself (first occurrence), as form input values: "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm". */
  start: string;
  end: string;
  /** NONE | DAILY | WEEKLY | MONTHLY, and the series end as "YYYY-MM-DD" ("" = open-ended). */
  recurrence: string;
  recurrenceUntil: string;
  inviteeIds: string[];
  /** Occurrence times for display: "HH:mm" for timed events, null for all-day. */
  startTime: string | null;
  endTime: string | null;
  startKey: string;
  endKey: string;
  canEdit: boolean;
  /** Team-only ("Yalnızca ekip"): hidden from guests. */
  internal: boolean;
  /** Comments on the event (one grouped count query on the page). */
  commentCount: number;
};

export type CalTodo = { id: string; title: string; done: boolean };

export type CalDay = {
  key: string;
  inMonth: boolean;
  isToday: boolean;
  eventIds: string[];
  todos: CalTodo[];
};

export type CalMember = { id: string; label: string };
