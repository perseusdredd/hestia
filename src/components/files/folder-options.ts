export type FolderNode = { id: string; name: string; parentId: string | null };
export type FolderOption = { id: string; label: string; depth: number };

/**
 * Flatten the folder tree into picker options ("Ana / Alt / Klasör"),
 * depth-first and sorted by name. When `excludeSubtreeOf` is given, that
 * folder and all its descendants are left out (a folder cannot be moved into
 * itself). The server enforces the same rule.
 */
export function buildFolderOptions(nodes: FolderNode[], excludeSubtreeOf?: string): FolderOption[] {
  const children = new Map<string | null, FolderNode[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const parent = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(n);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, "tr", { sensitivity: "base" }));
  }

  const out: FolderOption[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, prefix: string, depth: number) => {
    for (const n of children.get(parent) ?? []) {
      if (seen.has(n.id) || n.id === excludeSubtreeOf) continue;
      seen.add(n.id);
      const label = prefix ? `${prefix} / ${n.name}` : n.name;
      out.push({ id: n.id, label, depth });
      walk(n.id, label, depth + 1);
    }
  };
  walk(null, "", 0);
  return out;
}
