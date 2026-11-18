import { CalendarClock } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { istanbulDayKey } from "@/lib/istanbul-time";
import { hasRole } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { listCheckins, type CheckinAnswerDto } from "@/server/checkins";

import { ActiveToggle, AnswerForm, CreateQuestionForm, EditQuestionForm } from "./checkin-forms";
import { WEEKDAY_OPTIONS } from "./weekdays";

export const metadata = { title: "Otomatik kontroller" };

function dayLabel(key: string): string {
  return formatDate(new Date(`${key}T12:00:00Z`));
}

function Answers({ answers }: { answers: CheckinAnswerDto[] }) {
  if (answers.length === 0) return <p className="text-sm text-muted-foreground">Henüz cevap yok.</p>;
  return (
    <ul className="grid gap-3">
      {answers.map((a) => (
        <li key={a.id} className="rounded-lg bg-muted/50 px-3 py-2">
          <p className="text-sm font-medium">{a.authorName}</p>
          <p className="text-sm break-words whitespace-pre-wrap">{a.body}</p>
        </li>
      ))}
    </ul>
  );
}

export default async function CheckinsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const { questions, rounds } = await listCheckins(ctx);
  const isAdmin = hasRole(ctx.role, "ADMIN");
  const today = istanbulDayKey(new Date());
  const open = rounds.filter((r) => r.dateKey === today);
  const past = rounds.filter((r) => r.dateKey !== today);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Otomatik kontroller"
        description="Belirlenen gün ve saatte sorulan düzenli sorular. Herkesin cevabı bir arada görünür."
      />

      {open.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Bugün açık kontrol yok"
          description="Zamanı geldiğinde sorular burada görünür."
        />
      ) : (
        <div className="grid gap-4">
          {open.map((r) => (
            <section key={r.id} className="grid gap-3 rounded-xl border bg-card p-4 shadow-xs">
              <h2 className="font-semibold">{r.questionText}</h2>
              <AnswerForm
                slug={slug}
                roundId={r.id}
                initial={r.answers.find((a) => a.userId === ctx.userId)?.body ?? ""}
              />
              <Answers answers={r.answers} />
            </section>
          ))}
        </div>
      )}

      {past.length > 0 ? (
        <section className="grid gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Geçmiş kontroller</h2>
          {past.map((r) => (
            <details key={r.id} className="rounded-xl border bg-card px-4 py-3 shadow-xs">
              <summary className="cursor-pointer text-sm font-medium">
                {r.questionText}{" "}
                <span className="font-normal text-muted-foreground">
                  · {dayLabel(r.dateKey)} · {r.answers.length} cevap
                </span>
              </summary>
              <div className="pt-3">
                <Answers answers={r.answers} />
              </div>
            </details>
          ))}
        </section>
      ) : null}

      {isAdmin ? (
        <section className="grid gap-3 rounded-xl border bg-card p-4 shadow-xs">
          <h2 className="font-semibold">Sorular</h2>
          <ul className="grid gap-3">
            {questions.map((q) => (
              <li key={q.id} className="grid gap-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 font-medium break-words">{q.text}</span>
                  <Badge variant={q.active ? "secondary" : "outline"}>{q.active ? "Etkin" : "Durduruldu"}</Badge>
                  <ActiveToggle slug={slug} id={q.id} active={q.active} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {WEEKDAY_OPTIONS.filter((d) => q.weekdays.includes(d.value))
                    .map((d) => d.label)
                    .join(", ")}{" "}
                  · {String(q.hour).padStart(2, "0")}:00
                </p>
                <details>
                  <summary className="cursor-pointer text-sm text-muted-foreground">Düzenle</summary>
                  <div className="pt-3">
                    <EditQuestionForm
                      slug={slug}
                      id={q.id}
                      q={{ text: q.text, weekdays: q.weekdays, hour: q.hour }}
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
          <div className="border-t pt-3">
            <h3 className="mb-2 text-sm font-medium">Yeni soru</h3>
            <CreateQuestionForm slug={slug} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
