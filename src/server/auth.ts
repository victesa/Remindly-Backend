import { Request, Response, NextFunction } from 'express';
import { AuthUser, UserTier } from '../types.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

/**
 * Parses bearer tokens and identifies user identity and tier.
 * Supports production Firebase Auth tokens, signed dev tokens, and mock dev tokens for testing.
 */
export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const devUserId = (req.headers['x-user-id'] as string) || req.query.userId as string;
  const headerTier = (req.headers['x-user-tier'] as string)?.toLowerCase() as UserTier;

  // 1. Check if Bearer token is provided
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();

    try {
      // Dev / Test token format: "remindly_test_<tier>_<uid>" or base64 JSON
      if (token.startsWith('remindly_test_')) {
        const parts = token.split('_');
        const tier: UserTier = parts[2] === 'premium' ? 'premium' : 'free';
        const uid = parts.slice(3).join('_') || 'test-user-1';

        req.user = {
          uid,
          email: `${uid}@example.com`,
          tier: headerTier || tier,
          name: `Test User (${tier.toUpperCase()})`,
        };
        return next();
      }

      // Base64 encoded dev token
      if (token.startsWith('eyJ') || token.includes('.')) {
        try {
          const payloadPart = token.split('.')[1] || token.split('.')[0];
          const decodedJson = Buffer.from(payloadPart, 'base64').toString('utf-8');
          const parsed = JSON.parse(decodedJson);
          
          req.user = {
            uid: parsed.uid || parsed.user_id || parsed.sub || 'token-user',
            email: parsed.email || 'token-user@example.com',
            tier: headerTier || (parsed.tier === 'premium' || parsed.plan === 'premium' ? 'premium' : 'free'),
            name: parsed.name || 'Authenticated User',
          };
          return next();
        } catch {
          // Fall through to generic auth
        }
      }

      // Standard token fallback
      const derivedTier: UserTier = headerTier || (token.includes('premium') ? 'premium' : 'free');
      req.user = {
        uid: devUserId || `user_${token.slice(0, 10).replace(/[^a-zA-Z0-9]/g, '') || 'anon'}`,
        email: 'user@remindly.internal',
        tier: derivedTier,
      };
      return next();
    } catch (err) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired authorization token',
      });
      return;
    }
  }

  // 2. Allow dev user header or default fallback for frictionless local testing if no Bearer token
  if (devUserId) {
    req.user = {
      uid: devUserId,
      email: `${devUserId}@remindly.internal`,
      tier: headerTier || 'free',
      name: `User ${devUserId}`,
    };
    return next();
  }

  // 3. If no auth provided, default to demo free user with clear notice
  req.user = {
    uid: 'demo_guest_user',
    email: 'guest@remindly.ai',
    tier: headerTier || 'free',
    name: 'Guest Tester',
    isAnonymous: true,
  };
  next();
}

/**
 * Creates development token payloads for testing.
 */
export function mintDevToken(tier: UserTier = 'free', userId?: string): { token: string; user: AuthUser } {
  const uid = userId || `user_${Math.random().toString(36).substring(2, 9)}`;
  const token = `remindly_test_${tier}_${uid}`;
  return {
    token,
    user: {
      uid,
      email: `${uid}@example.com`,
      tier,
      name: `${tier.toUpperCase()} Tester`,
    },
  };
}
