export interface ConfigInventoryEntry {
  readonly category: string;
  readonly item?: string;
}

export interface ConfigSnapshotData {
  readonly inventory: readonly ConfigInventoryEntry[];
  readonly categories: Record<string, unknown>;
}

interface ConfigListResult {
  readonly categories?: unknown;
}

interface ConfigReadableClient {
  configsList(): Promise<unknown>;
  configGet(category: string, item?: string): Promise<unknown>;
}

export function normalizeConfigInventory(details: unknown): readonly ConfigInventoryEntry[] {
  const categories = (details as ConfigListResult | null | undefined)?.categories;
  if (!Array.isArray(categories)) {
    return [];
  }

  const inventory: ConfigInventoryEntry[] = [];
  const seen = new Set<string>();

  for (const categoryEntry of categories) {
    if (typeof categoryEntry === "string") {
      const category = categoryEntry.trim();
      if (!category) {
        continue;
      }
      const key = `${category}::`;
      if (!seen.has(key)) {
        seen.add(key);
        inventory.push({ category });
      }
      continue;
    }

    if (!categoryEntry || typeof categoryEntry !== "object") {
      continue;
    }

    const category = typeof (categoryEntry as { name?: unknown }).name === "string"
      ? ((categoryEntry as { name: string }).name).trim()
      : "";
    if (!category) {
      continue;
    }

    const items = Array.isArray((categoryEntry as { items?: unknown }).items)
      ? (categoryEntry as { items: unknown[] }).items
      : [];

    if (items.length === 0) {
      const key = `${category}::`;
      if (!seen.has(key)) {
        seen.add(key);
        inventory.push({ category });
      }
      continue;
    }

    for (const itemEntry of items) {
      if (typeof itemEntry !== "string") {
        continue;
      }
      const item = itemEntry.trim();
      if (!item) {
        continue;
      }
      const key = `${category}::${item}`;
      if (!seen.has(key)) {
        seen.add(key);
        inventory.push({ category, item });
      }
    }
  }

  return inventory;
}

export async function captureConfigSnapshot(client: ConfigReadableClient): Promise<ConfigSnapshotData> {
  const inventory = normalizeConfigInventory(await client.configsList());
  const categories: Record<string, unknown> = {};

  for (const entry of inventory) {
    try {
      const value = normalizeSnapshotValue(await client.configGet(entry.category, entry.item), entry);
      setSnapshotValue(categories, entry, value);
    } catch (error) {
      setSnapshotValue(categories, entry, {
        _error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { inventory, categories };
}

export function validateSnapshotCategories(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Snapshot categories payload must be an object");
  }
  return value as Record<string, unknown>;
}

function setSnapshotValue(target: Record<string, unknown>, entry: ConfigInventoryEntry, value: unknown): void {
  if (!entry.item) {
    target[entry.category] = value;
    return;
  }

  const existing = target[entry.category];
  const bucket = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  bucket[entry.item] = value;
  target[entry.category] = bucket;
}

function normalizeSnapshotValue(value: unknown, entry: ConfigInventoryEntry): unknown {
  if (!entry.item) {
    return value;
  }

  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.keys(value as Record<string, unknown>).length === 1
      || ((value as Record<string, unknown>).category === entry.category
        && (value as Record<string, unknown>).item === entry.item
        && ["int", "string"].includes(String((value as Record<string, unknown>).type))))
    && Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return (value as { value: unknown }).value;
  }

  return value;
}