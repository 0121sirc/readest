import { AppService } from '@/types/system';
import { deleteCloudLibrary } from '@/libs/user';

/**
 * Remove every book from THIS device: rows, files, covers and reading data.
 *
 * A hard removal rather than `deletedAt` tombstones — tombstones would be
 * pushed straight back up on the next sync and refill the library we just
 * emptied, which is exactly what the file-sync endpoint-replace flow must not
 * do to the server it just adopted.
 *
 * Callers that only clear this device use it on its own; {@link deleteAllBooks}
 * wraps it with the Readest Cloud half.
 */
export const purgeLocalLibrary = async (appService: AppService): Promise<void> => {
  const books = await appService.loadLibraryBooks();
  for (const book of books) {
    try {
      // 'purge' erases the whole Books/<hash>/ dir — the book file, cover,
      // config.json (progress, bookmarks, annotations), nav.json and the TTS
      // cache. Its `source.kind === 'managed'` guard is why this must go
      // through deleteBook: books imported in place keep their original file
      // at the user-controlled path (see the in-place delete regression).
      await appService.deleteBook(book, 'purge');
    } catch (error) {
      // One unreadable book must not strand the rest of the library.
      console.error('Failed to purge book:', book.hash, error);
    }
  }

  await appService.saveLibraryBooks([], { replace: true });
};

/**
 * Wipe the user's whole library: the cloud `books` rows first, then every book
 * on this device.
 *
 * The cloud call goes first on purpose. It is the recoverable half — if it
 * fails, nothing local has been touched yet and the user still has every book.
 * The local purge is irreversible, so it only runs once the network step has
 * succeeded.
 */
export const deleteAllBooks = async (appService: AppService): Promise<void> => {
  await deleteCloudLibrary();
  await purgeLocalLibrary(appService);
};
