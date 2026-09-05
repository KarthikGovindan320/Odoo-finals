import type { AuthenticatedUser } from '../services/auth_service.ts';

// Attaches the authenticated principal to the request. Declaration merging keeps
// req.auth typed everywhere without a cast at each use site.
declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
      /**
       * Set by authorize(). 'own' means the handler must restrict rows to the
       * caller's own employee record; 'all' means no row restriction.
       */
      accessScope?: 'own' | 'all';
    }
  }
}

export {};
