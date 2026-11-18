import type { TenantContext } from "@/lib/tenant-context";
import { listUpcomingEvents, type EventWithAccess } from "@/server/calendar";
import { listPosts } from "@/server/messages";
import { listMySubscriptions, type MySubscription } from "@/server/subscriptions";
import { listMyOpenTodos, type MyOpenTodo } from "@/server/todos";

/** "Benim İşlerim": read-only aggregation for the current user in one workspace. */

export const MY_EVENT_DAYS = 30;

export type MyTodoGroups = {
  overdue: MyOpenTodo[];
  today: MyOpenTodo[];
  upcoming: MyOpenTodo[];
  undated: MyOpenTodo[];
};

/** Split open to-dos by due date relative to `today` ("yyyy-MM-dd"). */
export function groupMyTodos(items: MyOpenTodo[], today: string): MyTodoGroups {
  const g: MyTodoGroups = { overdue: [], today: [], upcoming: [], undated: [] };
  for (const t of items) {
    if (!t.dueDate) g.undated.push(t);
    else if (t.dueDate < today) g.overdue.push(t);
    else if (t.dueDate === today) g.today.push(t);
    else g.upcoming.push(t);
  }
  return g;
}

export type MyWork = {
  todos: MyTodoGroups;
  todoTotal: number;
  events: EventWithAccess[];
  drafts: { id: string; title: string; updatedAt: Date }[];
  subscriptions: MySubscription[];
};

export async function getMyWork(ctx: TenantContext, opts: { today: string; now?: Date }): Promise<MyWork> {
  const [todos, events, drafts, subscriptions] = await Promise.all([
    listMyOpenTodos(ctx, { today: opts.today, take: 50 }),
    listUpcomingEvents(ctx, { days: MY_EVENT_DAYS, take: 10, now: opts.now }),
    listPosts(ctx, { take: 10, draftsOnly: true }),
    listMySubscriptions(ctx, { take: 20 }),
  ]);
  return {
    todos: groupMyTodos(todos.items, opts.today),
    todoTotal: todos.total,
    events,
    drafts: drafts.items.map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt })),
    subscriptions,
  };
}
