import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/auth';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Extend Express Request type to include user
export interface AuthenticatedRequest extends Request {
  user?: JwtPayload & { id: string }; // Add id to user from token payload
}

export const protect = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = verifyToken(token);

      if (!decoded) {
        res.status(401).json({ message: 'Not authorized, token failed' });
        return;
      }

      // Attach user to request object.
      // We might want to fetch the full user object from DB if more details are needed frequently.
      // For now, the decoded payload (userId, email) is sufficient for many protected routes.
      // The JwtPayload already contains userId, which we've aliased to id here for consistency if needed.
      req.user = { ...decoded, id: decoded.userId }; 

      next();
    } catch (error) {
      console.error('Token verification error:', error);
      res.status(401).json({ message: 'Not authorized, token failed' });
      return;
    }
  }

  if (!token) {
    res.status(401).json({ message: 'Not authorized, no token' });
    return;
  }
};
