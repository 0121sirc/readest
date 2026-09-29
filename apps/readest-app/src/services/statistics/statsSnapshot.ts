import type { AppService } from '@/types/system';
import type { PageStatEvent, StatBook } from '@/types/statistics';
import { StatisticsDb } from './statisticsDb';

/** Root-level zip entry holding the reading-statistics snapshot. */
export const STATS_SNAPSHOT_FILENAME = 'statistics.json';

/**
 * Portable reading-statistics payload. We snapshot the KOReader-compatible
 * page events + book identity rather than copying `statistics.db` verbatim:
 * the SQLite file lives in OPFS (web) / a provider-locked native path, so a
 * raw byte copy is both platform-specific and unsafe while the reader holds
 * the DB open. Re-applying the events through `applyRemoteEvents` reconstructs
 * the exact same derived aggregates on the importing device.
 */
export interface StatsSnapshot {
  books: StatBook[];
  events: PageStatEvent[];
}

export const isEmptyStatsSnapshot = (snapshot: StatsSnapshot | null | undefined): boolean =>
  !snapshot || (snapshot.books.length === 0 && snapshot.events.length === 0);

/**
 * Read every page event from the local statistics DB, or null when there is
 * no DB / no data / the read fails (a snapshot without stats is still useful,
 * so callers treat this as best-effort).
 */
export async function exportStatsSnapshot(appService: AppService): Promise<StatsSnapshot | null> {
  try {
    if (!(await appService.databaseExists('statistics.db', 'Data'))) return null;
    const db = await StatisticsDb.open(appService);
    await db.checkpoint();
    // `getEventsForPush(0)` returns every event (start_time > 0) joined to its
    // book identity; books with no events carry no stats worth snapshotting.
    const { events, books } = await db.getEventsForPush(0);
    if (events.length === 0 && books.length === 0) return null;
    return { books, events };
  } catch (error) {
    console.warn('Skipping stats snapshot:', error);
    return null;
  }
}

/**
 * Merge a snapshot's events into the local statistics DB using the same
 * last-writer-wins semantics as a server pull (per `(book, page, start_time)`,
 * keeping the longer duration).
 */
export async function importStatsSnapshot(
  appService: AppService,
  snapshot: StatsSnapshot,
): Promise<void> {
  if (isEmptyStatsSnapshot(snapshot)) return;
  const db = await StatisticsDb.open(appService);
  await db.applyRemoteEvents(snapshot.books, snapshot.events);
}
