import { Router, Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '../../node_modules/.prisma/client'; // Direct path
import { hashPassword, comparePassword, generateToken, JwtPayload } from '../utils/auth';

const router = Router();
const prisma = new PrismaClient();

// POST /auth/register
const registerHandler: RequestHandler = async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: 'Email and password are required' });
      return;
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      res.status(400).json({ message: 'User already exists with this email' });
      return;
    }

    const hashedPassword = await hashPassword(password);
    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name || null,
      },
    });

    const tokenPayload: JwtPayload = { userId: newUser.id, email: newUser.email };
    const token = generateToken(tokenPayload);

    // Exclude password from user object returned to client
    const { password: _, ...userWithoutPassword } = newUser;

    res.status(201).json({ user: userWithoutPassword, token, message: 'User registered successfully' });
  } catch (error) {
    console.error('Registration error:', error);
    if (!res.headersSent) { // Ensure headers aren't already sent
      res.status(500).json({ message: 'Internal server error during registration' });
    }
  }
};
router.post('/register', registerHandler);

// POST /auth/login
const loginHandler: RequestHandler = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: 'Email and password are required' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }

    const tokenPayload: JwtPayload = { userId: user.id, email: user.email };
    const token = generateToken(tokenPayload);
    
    // Exclude password from user object returned to client
    const { password: _, ...userWithoutPassword } = user;

    res.status(200).json({ user: userWithoutPassword, token, message: 'Login successful' });
  } catch (error) {
    console.error('Login error:', error);
    if (!res.headersSent) { // Ensure headers aren't already sent
      res.status(500).json({ message: 'Internal server error during login' });
    }
  }
};
router.post('/login', loginHandler);

export default router;
