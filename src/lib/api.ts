/** Minimal typed fetch client. Every non-2xx becomes a thrown Error with the
 * server's message — surfaced by the caller as a toast, never swallowed. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Turn a failed response into an ApiError. Shared by the fetch and XHR paths so
 * they cannot drift — in particular the 401 redirect below, which is easy to
 * lose when a second transport appears.
 */
function toApiError(status: number, bodyText: string): ApiError {
  let message = `Request failed (${status})`;
  let code = "unknown";
  try {
    const body = JSON.parse(bodyText) as { error?: { message?: string; code?: string } };
    message = body.error?.message ?? message;
    code = body.error?.code ?? code;
  } catch {
    /* non-JSON error body */
  }
  // Session expired/missing under the password gate — a toast alone strands a
  // single-user app, so send the browser to the login screen.
  if (status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
    location.href = "/login";
  }
  return new ApiError(message, code, status);
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  throw toApiError(res.status, await res.text().catch(() => ""));
}

export async function apiGet<T>(url: string): Promise<T> {
  return handle<T>(await fetch(url, { cache: "no-store" }));
}

export async function apiSend<T>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  return handle<T>(
    await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

/**
 * Upload with progress.
 *
 * XMLHttpRequest, not fetch, for one reason: [Certain] fetch cannot report
 * UPLOAD progress in browsers — `ReadableStream` request bodies need
 * `duplex: "half"` and are not usable here. An 11 MB photo pair takes 10-15s
 * over Funnel, and a spinner with no number for that long reads as broken.
 *
 * `onProgress` receives 0..1, and only while the total is known (a
 * `Content-Length` is always set for a FormData body, so in practice always).
 */
export function apiUpload<T>(
  url: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    // Deliberately no Content-Type: the browser must set it, because only it
    // knows the multipart boundary it generated.

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new ApiError("Server sent a malformed response", "bad_response", xhr.status));
        }
        return;
      }
      reject(toApiError(xhr.status, xhr.responseText));
    };
    // Distinguish the two silent failures, because over a relay they mean
    // different things: the connection died vs the app never answered.
    xhr.onerror = () =>
      reject(new ApiError("The upload could not reach the server", "network_error", 0));
    xhr.ontimeout = () => reject(new ApiError("The upload timed out", "timeout", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled", "aborted", 0));

    xhr.send(form);
  });
}
