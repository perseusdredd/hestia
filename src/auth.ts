import NextAuth, { CredentialsSignin } from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import { isGoogleAuthEnabled } from "@/lib/safe-redirect";
import { verifySessionReissueProof } from "@/server/auth-tokens";
import { AUTH_LIMITS, clientIp, hitRateLimit } from "@/server/rate-limit";

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(200),
});

// Used when no user matches so the response time does not reveal whether an
// email address is registered.
const DUMMY_HASH = "$2b$10$2m8FZymubg1/Z2Ft.EQPxenyANr8mYcSiZagY7Ch6C3D3QuXubzV.";

/** Thrown when an IP or account exceeded its login budget (loginAction shows a distinct message). */
class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}

const providers: Provider[] = [
  Credentials({
    credentials: {
      email: { label: "E-posta", type: "email" },
      password: { label: "Şifre", type: "password" },
    },
    // Runs for loginAction, registerAction AND direct POSTs to
    // /api/auth/callback/credentials, so the throttle lives here.
    async authorize(raw, request) {
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) return null;
      const { email, password } = parsed.data;

      const ipOk = hitRateLimit(`login:ip:${clientIp(request?.headers)}`, AUTH_LIMITS.loginPerIp);
      const emailOk = ipOk && hitRateLimit(`login:email:${email}`, AUTH_LIMITS.loginPerEmail);
      if (!ipOk || !emailOk) throw new RateLimitedSignin();

      const user = await db.user.findUnique({ where: { email } });
      if (!user?.passwordHash) {
        await bcrypt.compare(password, DUMMY_HASH);
        return null;
      }
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return null;
      return { id: user.id, email: user.email, name: user.name, image: user.image };
    },
  }),
];

if (isGoogleAuthEnabled()) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  );
}

async function currentSessionVersion(userId: string): Promise<number | null> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
  return row?.sessionVersion ?? null;
}

export const { auth, signIn, signOut, handlers, unstable_update } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(db),
  providers,
  callbacks: {
    ...authConfig.callbacks,
    /*
     * Stamps User.sessionVersion into the JWT at sign-in (credentials and
     * Google). src/lib/tenant.ts rejects a JWT whose version no longer matches
     * the row. On a session update the version only moves when the payload
     * carries a server-minted re-issue proof (changePasswordAction); a client
     * calling the session endpoint with its own payload changes nothing.
     */
    async jwt({ token, user, trigger, session }) {
      if (user?.id) token.id = user.id;
      const userId = (token.id as string | undefined) ?? token.sub;
      if (!userId) return token;

      if (trigger === "signIn" || trigger === "signUp") {
        token.sessionVersion = (await currentSessionVersion(userId)) ?? 0;
      } else if (trigger === "update") {
        const proof = (session as { sessionReissue?: unknown } | null | undefined)?.sessionReissue;
        const proven = verifySessionReissueProof(userId, proof);
        if (proven !== null && proven === (await currentSessionVersion(userId))) {
          token.sessionVersion = proven;
        }
      }
      return token;
    },
  },
  events: {
    // Keep stored emails lowercase for OAuth users too.
    async createUser({ user }) {
      if (user.id && user.email && user.email !== user.email.toLowerCase()) {
        await db.user
          .update({ where: { id: user.id }, data: { email: user.email.toLowerCase() } })
          .catch(() => undefined);
      }
    },
  },
});
