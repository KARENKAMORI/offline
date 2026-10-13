import { liveQuery } from 'dexie';
import { Observable } from 'rxjs';

/** Wraps a Dexie liveQuery as an RxJS Observable that re-emits whenever the queried tables change. */
export function fromLiveQuery<T>(querier: () => T | Promise<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    const sub = liveQuery(querier).subscribe({
      next: (value) => subscriber.next(value),
      error: (err) => subscriber.error(err),
    });
    return () => sub.unsubscribe();
  });
}
