import { notFound } from "next/navigation";
import { Trash2 } from "lucide-react";

import { ConfirmAction } from "@/components/confirm-action";
import { PageHeader } from "@/components/page-header";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDueDate, todayDateOnly } from "@/lib/date-only";
import { hasRole, isGuest } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { listBoard } from "@/server/cards";
import { listMemberUsers } from "@/server/workspaces";

import { deleteCardAction, deleteColumnAction } from "./actions";
import { AddCardForm, AddColumnForm, CardMoveControls, ColumnManagerRow, EditCardForm } from "./card-forms";

export const metadata = { title: "Pano" };

export default async function CardsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  if (isGuest(ctx.role)) notFound(); // team-only page
  const [columns, users] = await Promise.all([listBoard(ctx), listMemberUsers(ctx)]);
  const members = users.map((u) => ({ id: u.id, label: displayName(u) }));
  const isAdmin = hasRole(ctx.role, "ADMIN");
  const today = todayDateOnly();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pano"
        description="Kartları sütunlar arasında taşıyarak işlerin durumunu izleyin."
      />

      <div className="flex items-start gap-4 overflow-x-auto pb-3">
        {columns.map((col, ci) => (
          <section
            key={col.id}
            aria-label={col.name}
            className="grid w-72 shrink-0 gap-3 rounded-xl border bg-muted/30 p-3"
          >
            <h2 className="flex items-center justify-between gap-2 text-sm font-semibold">
              <span className="truncate">{col.name}</span>
              <span className="text-xs font-normal text-muted-foreground">{col.cards.length}</span>
            </h2>

            <ul className="grid gap-2">
              {col.cards.map((card, i) => (
                <li key={card.id} className="grid gap-2 rounded-lg border bg-card p-3 shadow-xs">
                  <p className="text-sm font-medium break-words">{card.title}</p>
                  {card.notes ? (
                    <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">{card.notes}</p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {card.assignee ? (
                      <span className="flex items-center gap-1.5">
                        <UserAvatar user={card.assignee} size="sm" />
                        {displayName(card.assignee)}
                      </span>
                    ) : null}
                    {card.dueOn ? (
                      <span className={card.dueOn < today ? "font-medium text-destructive" : undefined}>
                        {formatDueDate(card.dueOn, "d MMMM")}
                      </span>
                    ) : null}
                  </div>
                  <CardMoveControls
                    slug={slug}
                    cardId={card.id}
                    prevColumnId={columns[ci - 1]?.id ?? null}
                    nextColumnId={columns[ci + 1]?.id ?? null}
                    isFirst={i === 0}
                    isLast={i === col.cards.length - 1}
                  />
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <EditCardForm
                      slug={slug}
                      cardId={card.id}
                      card={{ title: card.title, notes: card.notes, assigneeId: card.assigneeId, dueOn: card.dueOn }}
                      members={members}
                    />
                    {card.canDelete ? (
                      <ConfirmAction
                        action={deleteCardAction.bind(null, slug, card.id)}
                        title="Kart silinsin mi?"
                        description="Kart panodan kaldırılır."
                        confirmLabel="Sil"
                        triggerLabel="Kartı sil"
                        trigger={<Trash2 aria-hidden />}
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>

            <AddCardForm slug={slug} columnId={col.id} members={members} />
          </section>
        ))}
      </div>

      {isAdmin ? (
        <section className="grid gap-3 rounded-xl border bg-card p-4 shadow-xs">
          <h2 className="font-semibold">Sütunları yönet</h2>
          <div className="grid gap-3">
            {columns.map((col, i) => (
              <div key={col.id} className="flex flex-wrap items-start gap-2">
                <ColumnManagerRow
                  slug={slug}
                  columnId={col.id}
                  name={col.name}
                  isFirst={i === 0}
                  isLast={i === columns.length - 1}
                />
                <ConfirmAction
                  action={deleteColumnAction.bind(null, slug, col.id)}
                  title={`"${col.name}" sütunu silinsin mi?`}
                  description="Yalnızca boş sütunlar silinebilir."
                  confirmLabel="Sil"
                  triggerLabel="Sütunu sil"
                  trigger={<Trash2 aria-hidden />}
                />
              </div>
            ))}
          </div>
          <AddColumnForm slug={slug} />
        </section>
      ) : null}
    </div>
  );
}
