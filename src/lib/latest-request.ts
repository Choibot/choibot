// Wrap an async loader so only its newest request can publish a result.
// A visibility event can overlap the usage poll interval, and network replies
// can arrive in the opposite order from their requests.
export function latestRequest<T>(load: () => Promise<T>, accept: (value: T) => void): () => void {
  let latest = 0;
  return () => {
    const request = ++latest;
    void load().then((value) => {
      if (request === latest) accept(value);
    });
  };
}
