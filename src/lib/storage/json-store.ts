import fs from "node:fs/promises";
import path from "node:path";
import { StudioError } from "@/lib/core/errors";
import { createLogger } from "@/lib/core/logger";
import { dbFile, dbDir, ensureDir } from "./paths";

const log = createLogger("storage");

/**
 * A deliberately small JSON-file collection store.
 *
 * Appropriate for the MVP: no daemon, no schema migrations, inspectable with
 * `cat`. It is not appropriate for concurrent multi-process writes — when this
 * project outgrows a single Next.js process, replace this module with SQLite
 * or Postgres. Everything above it talks through `Collection`, so that swap is
 * local.
 */

export interface Entity {
  id: string;
}

/** Serialises writes per collection so two requests can't clobber each other. */
const writeLocks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeLocks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export class Collection<T extends Entity> {
  constructor(private readonly name: string) {}

  private get file(): string {
    return dbFile(this.name);
  }

  async all(): Promise<T[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      // A corrupt file must not take the whole app down; quarantine and reset.
      log.error(`Collection "${this.name}" is unreadable; starting a fresh file.`, {
        error: (error as Error).message,
      });
      await this.quarantine();
      return [];
    }
  }

  async find(id: string): Promise<T | null> {
    const items = await this.all();
    return items.find((i) => i.id === id) ?? null;
  }

  async require(id: string): Promise<T> {
    const found = await this.find(id);
    if (!found) {
      throw new StudioError("NOT_FOUND", `No ${this.name} with id "${id}".`);
    }
    return found;
  }

  async filter(predicate: (item: T) => boolean): Promise<T[]> {
    return (await this.all()).filter(predicate);
  }

  async insert(item: T): Promise<T> {
    return withLock(this.name, async () => {
      const items = await this.all();
      if (items.some((i) => i.id === item.id)) {
        throw new StudioError("STORAGE_FAILED", `Duplicate ${this.name} id "${item.id}".`);
      }
      items.push(item);
      await this.write(items);
      return item;
    });
  }

  /** Read-modify-write under the collection lock. */
  async update(id: string, mutate: (current: T) => T): Promise<T> {
    return withLock(this.name, async () => {
      const items = await this.all();
      const index = items.findIndex((i) => i.id === id);
      if (index === -1) {
        throw new StudioError("NOT_FOUND", `No ${this.name} with id "${id}".`);
      }
      const updated = mutate(items[index]);
      items[index] = updated;
      await this.write(items);
      return updated;
    });
  }

  async upsert(item: T): Promise<T> {
    return withLock(this.name, async () => {
      const items = await this.all();
      const index = items.findIndex((i) => i.id === item.id);
      if (index === -1) items.push(item);
      else items[index] = item;
      await this.write(items);
      return item;
    });
  }

  async remove(id: string): Promise<boolean> {
    return withLock(this.name, async () => {
      const items = await this.all();
      const next = items.filter((i) => i.id !== id);
      if (next.length === items.length) return false;
      await this.write(next);
      return true;
    });
  }

  /** Atomic-ish write: temp file then rename, so a crash can't truncate the DB. */
  private async write(items: T[]): Promise<void> {
    await ensureDir(dbDir());
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(items, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  private async quarantine(): Promise<void> {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.rename(this.file, path.join(dbDir(), `${this.name}.corrupt-${stamp}.json`));
    } catch {
      /* nothing more we can do */
    }
  }
}
