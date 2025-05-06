import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { PrismaClient } from '../node_modules/.prisma/client'; // Direct path
import authRoutes from './routes/authRoutes';
import groupRoutes from './routes/groupRoutes';
import groupMemberRoutes from './routes/groupMemberRoutes';
import invitationRoutes from './routes/invitationRoutes';
import dishPostRoutes from './routes/dishPostRoutes';
import userRoutes from './routes/userRoutes';
import restaurantRoutes from './routes/restaurantRoutes'; // Import restaurant routes

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 3000; // Default to 3000 if PORT not in .env

const prisma = new PrismaClient();

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Basic Route
app.get('/', (req: Request, res: Response) => {
  res.send('WhatToEat Backend is running!');
});

// Mount auth routes
app.use('/auth', authRoutes);
app.use('/groups', groupRoutes); 
app.use('/groups/:groupId/members', groupMemberRoutes);
app.use('/invitations', invitationRoutes);
app.use('/posts', dishPostRoutes);
app.use('/users', userRoutes);
app.use('/restaurants', restaurantRoutes); // Mount restaurant routes


// Start server
app.listen(port, () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
});

// Graceful shutdown for Prisma Client
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

export default app; // For potential testing
