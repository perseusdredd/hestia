/** Serializable view model passed from the calendar page to client components. */
export type CalEvent = {
  id: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** Istanbul wall time as input values: "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm". */
  start: string;
  end: string;
  /** "HH:mm" for timed events, null for all-day. */
  startTime: string | null;
  endTime: string | null;
  startKey: string;
  endKey: string;
  canEdit: boolean;
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
