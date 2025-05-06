import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key'; // Fallback for safety, ensure JWT_SECRET is in .env
let jwtExpiryString: string = '60m'; // Default to '60m'
if (process.env.JWT_EXPIRY_IN_MINUTES) {
  const minutes = parseInt(process.env.JWT_EXPIRY_IN_MINUTES, 10);
  if (!isNaN(minutes) && minutes > 0) {
    jwtExpiryString = `${minutes}m`;
  }
}


export const hashPassword = async (password: string): Promise<string> => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
  return bcrypt.compare(password, hash);
};

export interface JwtPayload {
  userId: string;
  email: string;
}

export const generateToken = (payload: JwtPayload): string => {
  const options: SignOptions = { 
    expiresIn: jwtExpiryString as any, // Bypass strict type checking for this property
    issuer: process.env.JWT_ISSUER || undefined, // Optional: from your autobebe .env
    audience: process.env.JWT_AUDIENCE || undefined // Optional: from your autobebe .env
  };
  return jwt.sign(payload, JWT_SECRET, options);
};

export const verifyToken = (token: string): JwtPayload | null => {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch (error) {
    console.error('Invalid token:', error);
    return null;
  }
};
