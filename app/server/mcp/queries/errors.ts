/**
 * Why a query could not answer: Scribe's `QueryError` and `ArgumentError`,
 * with their messages verbatim. Every case carries enough detail for the
 * message an agent reads to name the thing that was wrong; a tool that
 * reports "invalid input" teaches the model nothing and it retries.
 */
export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }

  static malformedMeetingID(raw: string): QueryError {
    return new QueryError(
      `'${raw}' is not a valid meeting id. Meeting ids are UUIDs, as returned by list_meetings.`
    );
  }

  static unknownMeeting(id: string): QueryError {
    return new QueryError(`No meeting with id ${id}. Call list_meetings to see what exists.`);
  }

  static malformedCursor(raw: string): QueryError {
    return new QueryError(
      `'${raw}' is not a cursor from this listing. Pass next_cursor from a ` +
        'previous result unchanged, or omit it to start from the newest meeting.'
    );
  }

  static conflictingWindow(): QueryError {
    return new QueryError('Supply either start_time/end_time or offset/limit, not both.');
  }

  static unknownTool(name: string): QueryError {
    return new QueryError(`Unknown tool '${name}'.`);
  }

  static missing(key: string): QueryError {
    return new QueryError(`Required argument '${key}' is missing.`);
  }

  static notADate(key: string, raw: string): QueryError {
    return new QueryError(
      `'${raw}' is not a date. '${key}' takes an ISO 8601 date such as 2026-08-31.`
    );
  }

  static unreadable(key: string, raw: string, expected: string): QueryError {
    return new QueryError(`'${key}' takes ${expected}; '${raw}' is not one.`);
  }

  static notOneOf(key: string, raw: string, cases: readonly string[]): QueryError {
    return new QueryError(
      `'${raw}' is not a valid '${key}'. It takes one of: ${cases.join(', ')}.`
    );
  }
}
