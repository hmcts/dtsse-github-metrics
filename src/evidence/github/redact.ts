export const REDACTION = "[redacted]";

/**
 * How long a fragment has to be before blanking it is worth making a message less readable.
 *
 * A PEM's `-----END-----` line is not a secret, and a rule that blanked every short string would turn
 * GitHub's account of a refusal into a row of markers. Everything actually worth hiding is longer than
 * this: a PEM's body is 64-character base64 lines, and a token or a JWT is longer again.
 */
export const MINIMUM_SECRET_LENGTH = 12;

/**
 * Blanks secret material out of a string on its way to a log line or an error message.
 *
 * BELT AND BRACES, AND DELIBERATELY SO. Nothing in this module puts a key, a JWT or a token into a
 * message: what these messages carry is GitHub's own account of a refusal, or a crypto library's account
 * of a key it could not parse. But both come out of code this project does not control, and a parser
 * that quotes the input it was handed — ordinary, helpful behaviour almost everywhere else — would
 * publish the App's private key into every log the run writes. One pass over a short string closes that
 * off permanently, in the one place every such message goes.
 *
 * Each secret is matched WHOLE AND LINE BY LINE, because a message quoting a single base64 line of a PEM
 * has still published part of the key. Longest first, so a whole key becomes one marker rather than one
 * per line.
 */
export function redacted(text: string, ...secrets: (string | undefined)[]): string {
  const fragments = new Set<string>();
  for (const secret of secrets) {
    if (secret === undefined || secret === "") {
      continue;
    }
    fragments.add(secret.trim());
    for (const line of secret.split("\n")) {
      fragments.add(line.trim());
    }
  }
  let result = text;
  for (const fragment of [...fragments].sort((left, right) => right.length - left.length)) {
    if (fragment.length >= MINIMUM_SECRET_LENGTH) {
      result = result.split(fragment).join(REDACTION);
    }
  }
  return result;
}

/**
 * Summarises a refused exchange in one line, preferring GitHub's own `message` to its whole body.
 *
 * One line and 200 characters at most, because the alternative is a multi-kilobyte HTML error page from a
 * proxy in the path. GitHub's `message` is the part worth reading — `Integration not found` and `A JSON
 * web token could not be decoded` are different problems with different fixes, and both arrive as a bare
 * 404 or 401 otherwise. Nothing of the REQUEST is copied out.
 *
 * REDACTION HAPPENS HERE, BEFORE THE TRUNCATION, and that order is the whole point of doing it in this
 * function rather than in the caller. A body that quotes the request back is longer than the limit, so
 * cutting first would leave the first 200 characters of a JWT in the message — which no later pass can
 * match against the whole one, and which is a leak whatever the marker says.
 */
export function refusal(body: string, ...secrets: (string | undefined)[]): string {
  let text = body;
  try {
    const payload: unknown = JSON.parse(body);
    if (typeof payload === "object" && payload !== null && "message" in payload) {
      const message = (payload as { message: unknown }).message;
      if (typeof message === "string" && message !== "") {
        text = message;
      }
    }
  } catch {
    // Not JSON, so the body itself is the best summary available.
  }
  return redacted(text, ...secrets)
    .split(/\s+/)
    .join(" ")
    .trim()
    .slice(0, 200);
}
