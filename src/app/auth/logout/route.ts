import { clearedSessionCookie } from "@/auth/cookies";
import { signOutUrl } from "@/auth/entra";
import { redirectAway, redirectTo } from "@/auth/redirect";
import { authRequired, authSettings } from "@/auth/settings";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!authRequired()) {
    return redirectTo("/repositories");
  }

  const settings = authSettings();
  // Entra is asked to forget the reader too. Clearing only our own cookie would let the next visit sign straight
  // back in without a prompt, which on a shared machine reads as "sign out did nothing".
  const away = await signOutUrl(settings);
  const response = away === undefined ? redirectTo("/repositories") : redirectAway(away);
  response.headers.append("set-cookie", clearedSessionCookie());
  return response;
}
