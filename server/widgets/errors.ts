// server/widgets/errors.ts — one error type for the widget subsystem. It
// carries the HTTP status, so the routes in api.ts map it with no lookup table.
export class WidgetError extends Error {
  constructor(readonly code: 400 | 404 | 409 | 413 | 429 | 500 | 503, message: string) {
    super(message);
    this.name = "WidgetError";
  }
}
