import { type NextRequest, NextResponse } from "next/server";
import { clearedSessionCookie } from "@/auth/cookies";
import { signOutUrl } from "@/auth/entra";
import { authRequired, authSettings } from "@/auth/settings";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const home = new URL("/repositories", request.nextUrl.origin);

  if (!authRequired()) {
    return NextResponse.redirect(home);
  }

  const settings = authSettings();
  // Entra is asked to forget the reader too. Clearing only our own cookie would let the next visit sign
  // straight back in without a prompt, which on a shared machine reads as "sign out did nothing".
  const away = (await signOutUrl(settings, home.toString())) ?? home;
  const response = NextResponse.redirect(away);
  response.headers.append("set-cookie", clearedSessionCookie());
  return response;
}
