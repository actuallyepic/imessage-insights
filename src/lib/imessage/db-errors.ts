export type DbErrorKind = "permission" | "missing" | "unknown";

export interface DbErrorInfo {
  kind: DbErrorKind;
  status: number;
  message: string;
}

const MISSING_PATTERNS = [
  /no such file/i,
  /unable to open database file/i,
  /cannot open/i,
  /SQLITE_CANTOPEN/i,
  /file must exist/i,
];

export function getDbErrorInfo(error: unknown): DbErrorInfo {
  if (error instanceof Error) {
    const message = error.message;

    if (/authorization denied/i.test(message)) {
      return {
        kind: "permission",
        status: 403,
        message:
          "macOS denied access to the Messages database. Grant Full Disk Access to this app and try again.",
      };
    }

    if (MISSING_PATTERNS.some((pattern) => pattern.test(message))) {
      return {
        kind: "missing",
        status: 404,
        message:
          "Could not open the Messages database. Update the path in Settings or check Full Disk Access.",
      };
    }
  }

  return {
    kind: "unknown",
    status: 500,
    message: "Unexpected error while accessing the Messages database.",
  };
}
