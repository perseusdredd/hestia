import type { NextAuthConfig } from "next-auth";

declare module "next-auth" {
  interface Session {
    /** User.sessionVersion this JWT was issued with (see src/lib/tenant.ts). */
    sessionVersion?: number;
    /**
     * Only ever used as the payload of a server-side session update after a
     * password change (src/auth.ts verifies it); never set on a real session.
     */
    sessionReissue?: string;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    sessionVersion?: number;
  }
}

// Edge-safe Auth.js config shared by middleware and src/auth.ts.
// Must NOT import Prisma, bcrypt or any Node-only module.
// src/auth.ts replaces the jwt callback with one that also stamps
// sessionVersion (it needs the DB); this one only keeps the token as is.
export const authConfig = {
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      const id = (token.id as string | undefined) ?? token.sub;
      if (session.user && id) {
        session.user.id = id;
      }
      session.sessionVersion = typeof token.sessionVersion === "number" ? token.sessionVersion : 0;
      return session;
    },
  },
} satisfies NextAuthConfig;
