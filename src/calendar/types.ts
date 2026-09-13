export type CalendarTaskStatus = "suggested" | "confirmed" | "done" | "cancelled";

export interface CalendarTask {
  id: string;
  title: string;
  notes?: string;
  url?: string;
  allDay: boolean;
  /** YYYY-MM-DD, only meaningful when allDay is true. */
  date?: string;
  /** epoch ms UTC, only meaningful when allDay is false. */
  startsAt?: number | null;
  /** epoch ms UTC. When absent on a timed task, the event lasts 30 minutes. */
  endsAt?: number | null;
  /** IANA time zone, e.g. "America/Vancouver". */
  timezone: string;
  status: CalendarTaskStatus;
  updatedAt: number;
}
