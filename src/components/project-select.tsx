import { FieldError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { Label } from "@/components/ui/label";

export type ProjectOption = { id: string; name: string };

/**
 * Optional "Proje" picker for create forms. Renders nothing when the workspace
 * has no active projects; the empty value means "Genel" (workspace level).
 */
export function ProjectSelect({
  projects,
  id,
  defaultValue = "",
  errors,
}: {
  projects: ProjectOption[];
  id: string;
  defaultValue?: string;
  errors?: string[];
}) {
  if (projects.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Proje</Label>
      <NativeSelect
        className="max-w-xs"
        id={id}
        name="projectId"
        defaultValue={defaultValue}
        aria-invalid={Boolean(errors?.length) || undefined}
      >
        <option value="">Genel</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
      <FieldError errors={errors} />
    </div>
  );
}
