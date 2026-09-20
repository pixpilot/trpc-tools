/* eslint-disable ts/strict-boolean-expressions */
import type { TRPCMiddlewareBuilder, TRPCMiddlewareFunction } from '@trpc/server';
import { TRPCError } from '@trpc/server';

export interface TRPCAuthContext {
  user: unknown | null;
  isAdmin?: boolean;
}

interface AuthenticatedContext<TContext extends TRPCAuthContext> {
  user: NonNullable<TContext['user']>;
}

type AdminContext<TContext extends TRPCAuthContext> = AuthenticatedContext<TContext> & {
  isAdmin: true;
};

interface TRPCMiddlewareFactory<TContext extends TRPCAuthContext, TMeta extends object> {
  middleware: <$ContextOverrides>(
    fn: TRPCMiddlewareFunction<TContext, TMeta, object, $ContextOverrides, unknown>,
  ) => TRPCMiddlewareBuilder<TContext, TMeta, $ContextOverrides, unknown>;
}

// eslint-disable-next-line ts/explicit-module-boundary-types
export function createAuthMiddlewares<
  TContext extends TRPCAuthContext,
  TMeta extends object = object,
>(t: TRPCMiddlewareFactory<TContext, TMeta>) {
  const isAuthed = t.middleware<AuthenticatedContext<TContext>>(async ({ ctx, next }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  });

  const isAdmin = t.middleware<AdminContext<TContext>>(async ({ ctx, next }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    }

    if (ctx.isAdmin !== true) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Admin access required',
      });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
        isAdmin: ctx.isAdmin,
      },
    });
  });

  return { isAuthed, isAdmin };
}
